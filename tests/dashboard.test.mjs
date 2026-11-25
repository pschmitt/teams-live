import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { ApproveServer } from '../src/approve.mjs';
import { liveScript } from '../src/approve-page.mjs';
import { BATCH_APPROVAL_SCRIPT } from '../src/batch-approval-page.mjs';
import { alertsSection, dashboardScript, defaultFilter, jiraWikiToHtml, markdownToHtml, isBotMr, meetingsSection, mrFilters, mrsSection, normalizeMr, statsSection, webLink } from '../src/dashboard.mjs';

// The signed-in dashboard: GitLab sign-in without a card link, only for members of the configured group,
// merge requests read with the visitor's token, the bot's sources shown next to them, inline approvals sent once.

const ORIGIN = 'https://approve.example.com';
const GL = 'git.example.com';
const SHA = 'b'.repeat(40);
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

const node = (over = {}) => ({
  iid: '7',
  title: 'Example change',
  webUrl: `https://${GL}/group/app/-/merge_requests/7`,
  draft: false,
  updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
  sourceBranch: 'feature',
  targetBranch: 'main',
  diffHeadSha: SHA,
  detailedMergeStatus: 'NOT_APPROVED',
  approved: false,
  approvalsRequired: 2,
  approvalsLeft: 1,
  project: { fullPath: 'group/app' },
  author: { username: 'bob', name: 'Bob Example', bot: false },
  reviewers: { nodes: [{ username: 'alice' }] },
  approvedBy: { nodes: [{ username: 'carol', name: 'Carol Example' }] },
  headPipeline: { status: 'SUCCESS' },
  userPermissions: { canApprove: true },
  ...over,
});

async function withDashboard({ member = true, nodes = [node()], sources = {}, enable = true, path = '', dashSessionFile = null, now = Date.now } = {}, fn) {
  const gitlab = { host: GL, mrLink: (p, i) => `https://${GL}/${p}/-/merge_requests/${i}`, async getMr() { return {}; } };
  const server = new ApproveServer({
    gitlab,
    baseUrl: `${ORIGIN}/approve`,
    port: 0,
    oauth: { clientId: 'cid', clientSecret: 'sec', allowedUsers: [] },
    dashboard: { enable, group: 'group', sources, timeZone: 'UTC', path },
    dashSessionFile,
    now,
  });
  await server.start();
  const base = `http://127.0.0.1:${server.port}`;
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.startsWith(`https://${GL}/`)) return original(url, options);
    seen.push({ url: u, options });
    if (u.endsWith('/oauth/token')) {
      const grant = new URLSearchParams(options.body);
      if (grant.get('grant_type') === 'refresh_token') return grant.get('refresh_token') === 'ref' ? Response.json({ access_token: 'tok2', refresh_token: 'ref2', expires_in: 7200 }) : new Response('{}', { status: 400 });
      return Response.json({ access_token: 'tok', refresh_token: 'ref', expires_in: 7200 });
    }
    if (u.endsWith('/api/v4/user')) return Response.json({ id: 9, username: 'alice', name: 'Alice Example' });
    if (u.includes('/groups/group/members/all/9')) return member ? Response.json({ state: 'active', access_level: 30 }) : new Response('{}', { status: 404 });
    if (u.endsWith('/api/graphql')) return Response.json({ data: { group: { mergeRequests: { pageInfo: { hasNextPage: false }, nodes } } } });
    if (u.endsWith('/merge_requests/7')) return Response.json({ state: 'opened', draft: false, sha: SHA, author: { username: 'bob' } });
    if (u.endsWith('/merge_requests/7/approvals')) return Response.json({ approved_by: [], user_can_approve: true });
    if (u.endsWith('/merge_requests/7/approve') && options.method === 'POST') return Response.json({});
    return new Response('{}', { status: 404 });
  };
  try {
    await fn({ base, server, seen });
  } finally {
    globalThis.fetch = original;
    await server.stop();
  }
}

async function signIn(base, dash = '/approve/dashboard') {
  const start = await fetch(`${base}${dash}/signin`, { redirect: 'manual' });
  const location = new URL(start.headers.get('location'));
  const back = await fetch(`${base}/approve/oauth/callback?code=thecode&state=${location.searchParams.get('state')}`);
  const cookie = /tl_dash=[^;]+/.exec(back.headers.get('set-cookie') || '')?.[0] || '';
  return { start, location, back, cookie };
}

test('the dashboard is off unless enabled', async () => {
  await withDashboard({ enable: false }, async ({ base }) => {
    assert.equal((await fetch(`${base}/approve/dashboard`)).status, 404);
    assert.equal((await fetch(`${base}/approve/dashboard/signin`, { redirect: 'manual' })).status, 404);
  });
});

test('signed out, the dashboard offers the GitLab sign-in and its data endpoint answers 401', async () => {
  await withDashboard({}, async ({ base }) => {
    const gate = await fetch(`${base}/approve/dashboard`);
    assert.equal(gate.status, 200);
    assert.match(await gate.text(), /Sign in with GitLab/);
    assert.equal((await fetch(`${base}/approve/dashboard/data`)).status, 401);
  });
});

test('sign-in uses PKCE without a card link and opens a session for a group member', async () => {
  await withDashboard({}, async ({ base, seen }) => {
    const { start, location, back, cookie } = await signIn(base);
    assert.equal(start.status, 302);
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(location.searchParams.get('redirect_uri'), `${ORIGIN}/approve/oauth/callback`);
    assert.equal(back.status, 200);
    assert.ok(cookie, 'a dashboard session cookie');
    assert.match(back.headers.get('set-cookie'), /tl_dash=[^;]+; Path=\/approve\/dashboard; Max-Age=\d+; HttpOnly; SameSite=Strict; Secure/);
    const member = seen.find((c) => c.url.includes('/members/all/9'));
    assert.equal(member.options.headers.Authorization, 'Bearer tok', 'membership is asked with the visitor’s own token');
  });
});

test('a GitLab user outside the group gets no session', async () => {
  await withDashboard({ member: false }, async ({ base }) => {
    const { back, cookie } = await signIn(base);
    assert.equal(back.status, 403);
    assert.equal(cookie, '');
    assert.match(await back.text(), /not a member/);
  });
});

test('the page shows the merge requests read as the visitor, escaped, with the bot sources next to them', async () => {
  const sources = {
    sprint: async () => ({ total: 1, todo: [{ key: 'ABC-1', summary: 'Rotate <keys>', assignee: 'Alice Example', status: 'Open', url: 'https://jira.example.com/browse/ABC-1' }], inProgress: [], inReview: [] }),
    alerts: async () => { throw new Error('boom'); },
    meetings: async () => [{ subject: 'Standup', startTime: new Date(Date.now() + 3_600_000).toISOString(), endTime: new Date(Date.now() + 5_400_000).toISOString(), joinUrl: 'javascript:alert(1)', organizer: '' }],
  };
  await withDashboard({ nodes: [node({ title: 'Fix <script>alert(1)</script>' })], sources }, async ({ base, seen }) => {
    const { cookie } = await signIn(base);
    const res = await fetch(`${base}/approve/dashboard`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Fix &lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('<script>alert(1)'));
    assert.match(html, /data-approve data-project="group\/app" data-iid="7"/);
    assert.match(html, /data-f="human review"/);
    assert.match(html, /data-mrf="review"/, 'what waits for the visitor is shown first');
    assert.ok(html.includes('Rotate &lt;keys&gt;'));
    assert.match(html, /<li class="tk mine"/, 'the visitor’s own ticket is marked');
    assert.match(html, /Could not read OpsGenie right now/, 'a failing source is named, not its error');
    assert.ok(!html.includes('boom'));
    assert.ok(!html.includes('javascript:'), 'only http(s) links');
    const graphql = seen.find((c) => c.url.endsWith('/api/graphql'));
    assert.equal(graphql.options.headers.Authorization, 'Bearer tok');
    const csp = res.headers.get('content-security-policy');
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
    assert.ok(csp.includes(`'sha256-${crypto.createHash('sha256').update(script).digest('base64')}'`), 'the inline script is allowed by its hash');
    const data = await (await fetch(`${base}/approve/dashboard/data`, { headers: { Cookie: cookie } })).json();
    assert.ok(data.sections.mrs.includes('Fix &lt;script&gt;'));
    assert.ok(data.csrf);
  });
});

test('an inline approval is one POST as the visitor, checked like the approval page', async () => {
  await withDashboard({}, async ({ base, seen }) => {
    const { cookie } = await signIn(base);
    const html = await (await fetch(`${base}/approve/dashboard`, { headers: { Cookie: cookie } })).text();
    const csrf = /id="dash-csrf" value="([^"]+)"/.exec(html)[1];
    const post = (body, headers = { Origin: ORIGIN }) =>
      fetch(`${base}/approve/dashboard/approve`, { method: 'POST', headers: { ...FORM, Accept: 'application/json', Cookie: cookie, ...headers }, body: new URLSearchParams(body).toString() });
    const writes = () => seen.filter((c) => c.url.endsWith('/approve') && c.options.method === 'POST').length;

    assert.equal((await post({ csrf, project: 'group/app', iid: '7', sha: SHA }, { Origin: 'https://evil.example.com' })).status, 403);
    assert.equal((await post({ csrf: 'x', project: 'group/app', iid: '7', sha: SHA })).status, 403);
    assert.equal((await post({ csrf, project: 'other/app', iid: '7', sha: SHA })).status, 403, 'only the dashboard’s group');
    assert.equal(writes(), 0);

    const ok = await post({ csrf, project: 'group/app', iid: '7', sha: SHA });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).status, 'approved');
    assert.equal(writes(), 1);
    const write = seen.find((c) => c.url.endsWith('/approve') && c.options.method === 'POST');
    assert.equal(write.options.headers.Authorization, 'Bearer tok');
    assert.deepEqual(JSON.parse(write.options.body), { sha: SHA });

    const changed = await post({ csrf, project: 'group/app', iid: '7', sha: 'c'.repeat(40) });
    assert.equal((await changed.json()).status, 'failed', 'a head that moved is refused');
    assert.equal(writes(), 1);
  });
});

test('sign-out ends the dashboard session', async () => {
  await withDashboard({}, async ({ base }) => {
    const { cookie } = await signIn(base);
    const html = await (await fetch(`${base}/approve/dashboard`, { headers: { Cookie: cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)" data-csrf/.exec(html)[1];
    const out = await fetch(`${base}/approve/dashboard/signout`, { method: 'POST', redirect: 'manual', headers: { ...FORM, Origin: ORIGIN, Cookie: cookie }, body: new URLSearchParams({ csrf }).toString() });
    assert.equal(out.status, 303);
    assert.equal((await fetch(`${base}/approve/dashboard/data`, { headers: { Cookie: cookie } })).status, 401);
  });
});

test('filters: review requests, own and bot merge requests', () => {
  const mr = normalizeMr(node());
  assert.deepEqual(mrFilters(mr, 'Alice'), ['human', 'review']);
  assert.deepEqual(mrFilters(mr, 'bob'), ['human', 'mine']);
  const approved = normalizeMr(node({ approvedBy: { nodes: [{ username: 'alice', name: 'Alice' }] } }));
  assert.deepEqual(mrFilters(approved, 'alice'), ['human'], 'approved already: no longer waiting');
  const draft = normalizeMr(node({ draft: true }));
  assert.ok(!mrFilters(draft, 'alice').includes('review'));
  assert.ok(isBotMr(normalizeMr(node({ author: { username: 'renovate-bot', name: 'Renovate', bot: true } }))));
  assert.equal(defaultFilter([mr], 'alice'), 'review');
  assert.equal(defaultFilter([mr], 'zoe'), 'human');
});

test('the merge request tiles open the list with their filter', () => {
  const ctx = { username: 'alice', name: 'Alice', host: GL, avatars: {}, now: Date.now(), timeZone: 'UTC' };
  const html = statsSection({ mrs: { items: [normalizeMr(node())] }, sprint: { data: {} }, alerts: { data: { alerts: [] } } }, ctx);
  assert.match(html, /data-view-to="mrs" data-mrf-set="review"><span class="k">[\s\S]*?Review requested/);
  assert.match(html, /data-view-to="mrs" data-mrf-set="mine"><span class="k">[\s\S]*?Your merge requests/);
  assert.match(html, /data-view-to="sprint">/, 'other tiles only switch the view');
  assert.match(dashboardScript('/dashboard'), /getAttribute\('data-mrf-set'\)/);
});

test('sections: links stay on their hosts, failures read plainly', () => {
  assert.equal(webLink('javascript:alert(1)'), '');
  assert.equal(webLink('https://teams.example.com/x'), 'https://teams.example.com/x');
  const ctx = { username: 'alice', name: 'Alice', host: GL, avatars: {}, now: Date.now(), timeZone: 'UTC' };
  const offHost = mrsSection({ items: [normalizeMr(node({ webUrl: 'https://evil.example.com/x' }))] }, ctx);
  assert.ok(!offHost.includes('evil.example.com'), 'merge request links only on the GitLab host');
  assert.match(alertsSection({ data: { alerts: [], duty: [{ queue: 'On-call', who: 'Alice Example' }] } }, ctx), /No open alerts[\s\S]*Alice Example/);
  assert.match(meetingsSection({ data: [] }, ctx), /No more meetings/);
});

test('the dashboard can live on its own path; its old address leads there', async () => {
  await withDashboard({ path: '/dashboard' }, async ({ base }) => {
    const moved = await fetch(`${base}/approve/dashboard`, { redirect: 'manual' });
    assert.equal(moved.status, 308);
    assert.equal(moved.headers.get('location'), '/dashboard');
    const { back, cookie } = await signIn(base, '/dashboard');
    assert.match(await back.text(), /url=\/dashboard"/);
    assert.match(back.headers.get('set-cookie'), /tl_dash=[^;]+; Path=\/dashboard;/);
    const html = await (await fetch(`${base}/dashboard`, { headers: { Cookie: cookie } })).text();
    assert.match(html, /action="https:\/\/approve\.example\.com\/dashboard\/signout"/);
    assert.ok(html.includes('"/dashboard"'), 'the script talks to the dashboard path');
    assert.equal((await fetch(`${base}/dashboard/data`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${base}/dashboard/nope`)).status, 404);
  });
  assert.throws(() => new ApproveServer({ gitlab: { host: GL }, baseUrl: `${ORIGIN}/approve`, oauth: { clientId: 'c', clientSecret: 's' }, dashboard: { enable: true, group: 'g', path: 'dashboard' } }), /dashboard\.path/);
});

test('dashboard sessions survive a restart, saved encrypted, and renew the GitLab token before it expires', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-dash-'));
  const file = path.join(dir, 'dashboard-sessions.json');
  let clock = Date.now();
  const now = () => clock;
  try {
    let cookie;
    await withDashboard({ dashSessionFile: file, now }, async ({ base }) => {
      ({ cookie } = await signIn(base));
    });
    const saved = fs.readFileSync(file, 'utf8');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!saved.includes('tok') && !saved.includes('ref') && !saved.includes('alice'), 'tokens and names are encrypted');
    clock += 3 * 3600 * 1000; // past the access token's two hours
    await withDashboard({ dashSessionFile: file, now }, async ({ base, seen }) => {
      const page = await fetch(`${base}/approve/dashboard`, { headers: { Cookie: cookie } });
      assert.equal(page.status, 200);
      assert.match(await page.text(), /data-approve/, 'signed in after the restart, no new sign-in');
      const grant = seen.filter((c) => c.url.endsWith('/oauth/token')).map((c) => new URLSearchParams(c.options.body).get('grant_type'));
      assert.deepEqual(grant, ['refresh_token']);
      const graphql = seen.find((c) => c.url.endsWith('/api/graphql'));
      assert.equal(graphql.options.headers.Authorization, 'Bearer tok2', 'the renewed token is used');
      assert.ok(seen.some((c) => c.url.includes('/members/all/9') && c.options.headers.Authorization === 'Bearer tok2'), 'membership is checked again');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a session whose token cannot be renewed ends', async () => {
  let clock = Date.now();
  await withDashboard({ now: () => clock, member: true }, async ({ base, server }) => {
    const { cookie } = await signIn(base);
    for (const s of server.dashSessions.values()) s.refreshToken = 'revoked';
    clock += 3 * 3600 * 1000;
    const page = await fetch(`${base}/approve/dashboard`, { headers: { Cookie: cookie } });
    assert.match(await page.text(), /Sign in with GitLab/);
    assert.equal(server.dashSessions.size, 0);
  });
});

test('details: only tickets and alerts the dashboard shows, read by the bot, escaped', async () => {
  const reads = [];
  const sources = {
    sprint: async () => ({ total: 1, todo: [{ key: 'ABC-1', summary: 'S', assignee: 'Alice Example', status: 'Open' }], inProgress: [], inReview: [] }),
    alerts: async () => ({ alerts: [{ id: 'abc-123', message: 'Disk full', priority: 'P2', createdAt: new Date().toISOString() }], duty: [] }),
    issueKeys: (mr) => (mr.title.includes('ABC-2') ? ['ABC-2'] : []),
    issue: async (key) => { reads.push(key); return { key, summary: '<b>x</b>', status: 'Open', assignee: 'Alice Example', description: 'line <script>', url: 'https://jira.example.com/browse/' + key }; },
    alert: async (id) => { reads.push(id); if (id !== 'abc-123') throw new Error('secret detail'); return { id, message: 'Disk full', priority: 'P2', details: { host: '<h>' }, url: 'https://opsgenie.example.com/a' }; },
  };
  await withDashboard({ nodes: [node({ title: 'ABC-2: fix it' })], sources }, async ({ base }) => {
    const { cookie } = await signIn(base);
    const get = (q) => fetch(`${base}/approve/dashboard/${q}`, { headers: { Cookie: cookie } });
    const html = await (await fetch(`${base}/approve/dashboard`, { headers: { Cookie: cookie } })).text();
    assert.match(html, /class="tchip" data-issue="ABC-2"/, 'the linked ticket is a chip on the merge request');
    const sprint = await (await get('issue?key=ABC-1')).json();
    assert.ok(sprint.html.includes('line &lt;script&gt;') && sprint.title.includes('&lt;b&gt;') === false);
    assert.equal((await get('issue?key=ABC-2')).status, 200, 'a ticket named by a listed merge request');
    assert.equal((await get('issue?key=ABC-9')).status, 404, 'not on the dashboard');
    assert.equal((await get('issue?key=../x')).status, 404);
    const alert = await (await get('alert?id=abc-123')).json();
    assert.ok(alert.html.includes('&lt;h&gt;'));
    assert.equal((await get('alert?id=other')).status, 404);
    assert.deepEqual(reads, ['ABC-1', 'ABC-2', 'abc-123'], 'nothing else is read');
  });
});

test('moving a ticket: one transition for a ticket on the board, after Origin and CSRF checks', async () => {
  const moves = [];
  const sources = {
    sprint: async () => ({ total: 1, todo: [{ key: 'ABC-1', summary: 'S', assignee: 'A', status: 'Open' }], inProgress: [], inReview: [] }),
    move: async (key, to) => { moves.push([key, to]); return 'In Review'; },
  };
  await withDashboard({ sources }, async ({ base }) => {
    const { cookie } = await signIn(base);
    const html = await (await fetch(`${base}/approve/dashboard`, { headers: { Cookie: cookie } })).text();
    assert.match(html, /data-col="inReview"/);
    assert.match(html, /data-issue="ABC-1" role="button"/);
    const csrf = /id="dash-csrf" value="([^"]+)"/.exec(html)[1];
    const post = (body, origin = ORIGIN) => fetch(`${base}/approve/dashboard/move`, { method: 'POST', headers: { ...FORM, Accept: 'application/json', Cookie: cookie, Origin: origin }, body: new URLSearchParams(body).toString() });
    assert.equal((await post({ csrf, key: 'ABC-1', to: 'inReview' }, 'https://evil.example.com')).status, 403);
    assert.equal((await post({ csrf: 'x', key: 'ABC-1', to: 'inReview' })).status, 403);
    assert.equal((await post({ csrf, key: 'ABC-7', to: 'inReview' })).status, 404, 'not on the board');
    assert.equal((await post({ csrf, key: 'ABC-1', to: 'done' })).status, 400);
    assert.equal(moves.length, 0);
    const ok = await (await post({ csrf, key: 'ABC-1', to: 'inReview' })).json();
    assert.deepEqual(ok, { status: 'moved', text: 'ABC-1 moved to In Review.' });
    assert.deepEqual(moves, [['ABC-1', 'inReview']]);
  });
});

test('the page script parses (a syntax error would leave the whole page inert)', () => {
  assert.doesNotThrow(() => new Function(dashboardScript('/dashboard')));
  assert.doesNotThrow(() => new Function(liveScript('/approve/state')));
  assert.doesNotThrow(() => new Function(BATCH_APPROVAL_SCRIPT));
});

test('Jira descriptions: wiki markup becomes HTML, everything else stays escaped text', () => {
  const html = jiraWikiToHtml('h2. Why\nRead it on [the docs|https://docs.example.com] in {{group/docs}}, *now*.\n* a <b>\n** b\n# one\n{code}\n<script>x</script>\n{code}\n[bad|javascript:alert(1)]');
  assert.match(html, /<h4>Why<\/h4>/);
  assert.match(html, /<a href="https:\/\/docs\.example\.com\/" target="_blank" rel="noopener noreferrer">the docs<\/a>/);
  assert.match(html, /<code>group\/docs<\/code>, <strong>now<\/strong>/);
  assert.match(html, /<ul><li>a &lt;b&gt;<ul><li>b<\/li><\/ul><\/li><\/ul><ol><li>one<\/li><\/ol>/);
  assert.match(html, /<pre>&lt;script&gt;x&lt;\/script&gt;<\/pre>/);
  assert.ok(!html.includes('href="javascript'), 'no script links');
  assert.ok(!/<script/i.test(html));
});

test('merge request details: only listed ones, read with the visitor\'s token, with GitLab\'s link', async () => {
  await withDashboard({}, async ({ base, seen }) => {
    const { cookie } = await signIn(base);
    const html = await (await fetch(`${base}/approve/dashboard`, { headers: { Cookie: cookie } })).text();
    assert.match(html, /data-mr="group\/app!7"/);
    const get = (ref) => fetch(`${base}/approve/dashboard/mr?ref=${encodeURIComponent(ref)}`, { headers: { Cookie: cookie } });
    assert.equal((await get('group/app!8')).status, 404, 'not on the dashboard');
    assert.equal((await get('other/app!7')).status, 404);
    const res = await get('group/app!7');
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.ok(d.html.includes('Branches') && d.urlLabel === 'Open in GitLab');
    assert.match(d.html, /data-approve data-project="group\/app" data-iid="7"/, 'the Approve button comes along');
    const read = seen.filter((c) => c.url.endsWith('/merge_requests/7'));
    assert.ok(read.length && read.every((c) => c.options.headers.Authorization === 'Bearer tok'));
  });
});

test('GitLab descriptions: Markdown becomes HTML, Renovate HTML is dropped, links are http(s) only', () => {
  const html = markdownToHtml('## Release notes\n<details><summary>v4.25.0</summary>\n\n- **fix** a [bug](https://example.com/b) in `x`\n  - nested\n1. one\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\n<script>no</script>\n```\n</details>\n<!-- hidden -->\n[bad](javascript:alert(1)) <img src=x onerror=alert(1)> <b>bold</b>');
  assert.match(html, /<h4>Release notes<\/h4>/);
  assert.match(html, /<li><strong>fix<\/strong> a <a href="https:\/\/example\.com\/b"[^>]*>bug<\/a> in <code>x<\/code><ul><li>nested<\/li><\/ul><\/li><\/ul><ol><li>one<\/li><\/ol>/);
  assert.match(html, /<table><tr><th>a<\/th><th>b<\/th><\/tr><tr><td>1<\/td><td>2<\/td><\/tr><\/table>/);
  assert.match(html, /<pre>&lt;script&gt;no&lt;\/script&gt;<\/pre>/);
  assert.ok(!/hidden|<img|<details|onerror|href="javascript/i.test(html));
});

test('without approval rules a merge request is approved only once someone approved it (as on the cards)', () => {
  const ctx = { username: 'alice', name: 'Alice', host: GL, avatars: {}, now: Date.now(), timeZone: 'UTC' };
  const none = normalizeMr(node({ approved: true, approvalsRequired: 0, approvalsLeft: 0, approvedBy: { nodes: [] } }));
  assert.match(mrsSection({ items: [none] }, ctx), /alt="Not approved yet"/, 'GitLab says approved, but nobody did (approval reset by a push)');
  const one = normalizeMr(node({ approved: true, approvalsRequired: 0, approvalsLeft: 0, approvedBy: { nodes: [{ username: 'carol', name: 'Carol' }] } }));
  assert.match(mrsSection({ items: [one] }, ctx), /alt="Approved \(by Carol\)"/);
});

test('on-duty responders show their picture (initials without one), and an empty queue reads Off-duty', () => {
  const photo = 'data:image/png;base64,AAAA';
  const ctx = { username: 'alice', name: 'Alice', host: GL, avatars: { 'Carol Example': photo }, now: Date.now(), timeZone: 'UTC' };
  const html = alertsSection({ data: { alerts: [], duty: [{ queue: 'On-call', people: [{ name: 'Carol Example', email: 'carol.example@example.com' }] }, { queue: 'Support', people: [{ name: 'Dave Example' }] }, { queue: 'Edge', people: [] }] } }, ctx);
  assert.ok(html.includes(`src="${photo}"`), 'the cached photo');
  assert.match(html, /<img class="av" src="data:image\/png;base64,[^"]+" alt="Dave Example"/, 'initials for the one without a photo');
  assert.match(html, /Off-duty<\/span><small>Edge<\/small>/);
  assert.ok(!html.includes('carol.example@'), 'no addresses on the page');
});

test('installable app: manifest, icons and service worker without a session; only signed-in pages are kept offline', async () => {
  const { serviceWorkerScript } = await import('../src/dashboard.mjs');
  assert.doesNotThrow(() => new Function(serviceWorkerScript('/dashboard')));
  await withDashboard({ path: '/dashboard' }, async ({ base }) => {
    const manifest = await fetch(`${base}/dashboard/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type'), /manifest\+json/);
    const m = await manifest.json();
    assert.equal(m.start_url, '/dashboard');
    assert.equal(m.display, 'standalone');
    const icon = await fetch(`${base}/dashboard/icon-512.png`);
    assert.equal(icon.headers.get('content-type'), 'image/png');
    assert.equal((await icon.arrayBuffer()).byteLength > 1000, true);
    const sw = await fetch(`${base}/dashboard/sw.js`);
    assert.equal(sw.headers.get('service-worker-allowed'), '/dashboard');
    assert.match(await sw.text(), /X-TL-Offline/);

    const gate = await fetch(`${base}/dashboard`);
    assert.equal(gate.headers.get('x-tl-offline'), null, 'the sign-in page is never kept');
    const { cookie } = await signIn(base, '/dashboard');
    const page = await fetch(`${base}/dashboard`, { headers: { Cookie: cookie } });
    assert.equal(page.headers.get('x-tl-offline'), '1');
    assert.match(page.headers.get('content-security-policy'), /manifest-src 'self'; worker-src 'self'/);
    const html = await page.text();
    assert.match(html, /<link rel="manifest" href="\/dashboard\/manifest\.webmanifest">/);
    assert.match(html, /data-palette/);
    assert.match(html, /data-offline-bar hidden/);
    const data = await fetch(`${base}/dashboard/data`, { headers: { Cookie: cookie } });
    assert.equal(data.headers.get('x-tl-offline'), '1');
  });
});

test('theme: the tl_theme cookie picks light or dark for every page; the account menu switches it', async () => {
  await withDashboard({}, async ({ base }) => {
    const { cookie } = await signIn(base);
    const page = async (theme) => (await fetch(`${base}/approve/dashboard`, { headers: { Cookie: `${cookie}; tl_theme=${theme}` } })).text();
    const dark = await page('dark');
    assert.match(dark, /<html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark">/);
    assert.match(dark, /data-theme-set="dark" aria-pressed="true"/);
    const odd = await page('%3Cx%3E');
    assert.match(odd, /<html lang="en"><head>/, 'anything else follows the system');
    assert.match(odd, /data-theme-set="auto" aria-pressed="true"/);
    const gate = await (await fetch(`${base}/approve/dashboard`, { headers: { Cookie: 'tl_theme=light' } })).text();
    assert.match(gate, /<html lang="en" data-theme="light">/, 'other pages follow the choice too');
  });
});

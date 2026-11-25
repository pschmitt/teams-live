import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { ApproveServer } from '../src/approve.mjs';
import { liveScript } from '../src/approve-page.mjs';
import { BATCH_APPROVAL_SCRIPT } from '../src/batch-approval-page.mjs';
import { DEFAULT_LAYOUT, dashboardBody, alertDetail, diffsSection, issueDetail, DASHBOARD_CSS, dashboardPeople, leaveSection, linkify, oncallSection, mergeButton, personDetail, personRef, mrDetail, sprintSection, NOTIFY_DEFAULTS, NOTIFY_KINDS, normalizeNotifySettings, wantsEvent, alertsSection, dashboardScript, defaultFilter, jiraWikiToHtml, markdownToHtml, isBotMr, meetingsSection, mrFilters, mrsSection, normalizeMr, notifyEvents, serviceWorkerScript, settingsSection, statsSection, webLink } from '../src/dashboard.mjs';

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

async function withDashboard({ member = true, nodes = [node()], sources = {}, enable = true, path = '', dashSessionFile = null, pushFile = null, now = Date.now, mergeEnabled = false, personInfo = null, personAbsence = null } = {}, fn) {
  const gitlab = { host: GL, mrLink: (p, i) => `https://${GL}/${p}/-/merge_requests/${i}`, async getMr() { return {}; } };
  const server = new ApproveServer({
    gitlab,
    baseUrl: `${ORIGIN}/approve`,
    port: 0,
    oauth: { clientId: 'cid', clientSecret: 'sec', allowedUsers: [] },
    dashboard: { enable, group: 'group', sources, timeZone: 'UTC', path },
    dashSessionFile,
    pushFile,
    now,
    mergeEnabled,
    personInfo,
    personAbsence,
    mergePollMs: 0,
    mergePollAttempts: 2,
    sleep: async () => {},
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
    assert.match(html, /<h2 id="h-mrs">[\s\S]*?<\/h2><div class="chips hchips"[^>]*><button type="button" data-mrf-to="review">/, 'the filters sit in the card header');
    assert.match(html, /<h2 id="h-sprint">[\s\S]*?<\/h2><button type="button" class="toggle chip-h" data-sprintmine-toggle/, 'Only mine sits in the sprint header, outside the edit tools');
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
  const tiles = statsSection({ mrs: { items: [normalizeMr(node())] }, sprint: { data: {} }, alerts: { data: { alerts: [] } } }, ctx);
  assert.deepEqual(Object.keys(tiles), ['st-review', 'st-mine', 'st-sprint', 'st-alerts'], 'one card per tile');
  assert.match(tiles['st-review'], /data-view-to="mrs" data-mrf-set="review" aria-label="Review requested: 1, merge request waits for you"><span class="v">1<\/span>/);
  assert.match(tiles['st-mine'], /data-view-to="mrs" data-mrf-set="mine"/);
  assert.match(tiles['st-sprint'], /data-view-to="sprint" aria-label/, 'other tiles only switch the view');
  assert.match(dashboardScript('/dashboard'), /getAttribute\('data-mrf-set'\)/);
});

test('the summary tiles are cards: hideable and movable, on top by default, kept together when a saved layout lacks them', () => {
  assert.deepEqual(DEFAULT_LAYOUT.rows[0].cols.map((c) => c.cards[0]), ['st-review', 'st-mine', 'st-sprint', 'st-alerts']);
  const body = dashboardBody({ data: { mrs: { items: [] }, sprint: { data: {} }, alerts: { data: { alerts: [] } }, meetings: { data: [] } }, ctx: { username: 'alice', name: 'Alice', host: GL, avatars: {}, now: Date.now(), timeZone: 'UTC' }, csrf: 'x', filter: 'human', updated: 'now' });
  assert.match(body, /<section class="box box-st-review box-st" data-sec="st-review"[^>]*><header><h2 id="h-st-review"><svg[\s\S]*?Review requested<\/h2>[\s\S]*?data-hide[\s\S]*?data-grip/);
  assert.doesNotMatch(body, /class="stats"/);
  assert.match(dashboardScript('/dashboard'), /if\(k\.indexOf\('st-'\)===0\)\{[^}]*--w','3'/, 'missing tiles share one row');
});

test('detail panels: the external link is a row of the panel, merge requests show status and repository', () => {
  const ctx = { host: GL, avatars: {}, now: Date.now(), timeZone: 'UTC' };
  const mr = mrDetail({ mr: { iid: 7, state: 'merged', title: 'T', web_url: `https://${GL}/group/app/-/merge_requests/7`, references: { full: 'group/app!7' } } }, ctx);
  assert.match(mr.html, /<dt>Status<\/dt><dd><span class="dstate"><span class="pill pill-merged">Merged<\/span><\/span>/, 'no merge status once merged');
  assert.doesNotMatch(mr.html, /<dt>(Reviewers|Changes|Labels|Updated|Merge status)<\/dt>/, 'a compact panel');
  assert.match(mr.html, /<dt>Repo<\/dt><dd><a class="dref" href="https:\/\/git\.example\.com\/group\/app"[^>]*>group\/app<\/a>/);
  assert.match(mr.html, /<dt>GitLab<\/dt><dd><a class="dlink" href="https:\/\/git\.example\.com\/group\/app\/-\/merge_requests\/7"[^>]*><img class="dlogo" src="[^"]+"[^>]*>Open in GitLab<svg/, 'with the service logo');
  assert.match(issueDetail({ key: 'ABC-1', summary: 's', status: 'Open', url: 'https://jira.example.com/browse/ABC-1' }, ctx).html, /<dt>Jira<\/dt><dd><a class="dlink" href="https:\/\/jira\.example\.com\/browse\/ABC-1"/);
  assert.match(alertDetail({ message: 'm', url: 'https://app.opsgenie.com/alert/detail/x' }, ctx).html, /<dt>OpsGenie<\/dt><dd><a class="dlink"/);
  assert.doesNotMatch(issueDetail({ key: 'ABC-1', summary: 's', status: 'Open', url: 'javascript:alert(1)' }, ctx).html, /dlink/, 'no unsafe link');
  assert.doesNotMatch(dashboardScript('/dashboard'), /data-drawer-link/, 'the header has no link any more');
});

test('sections: links stay on their hosts, failures read plainly', () => {
  assert.equal(webLink('javascript:alert(1)'), '');
  assert.equal(webLink('https://teams.example.com/x'), 'https://teams.example.com/x');
  const ctx = { username: 'alice', name: 'Alice', host: GL, avatars: {}, now: Date.now(), timeZone: 'UTC' };
  const offHost = mrsSection({ items: [normalizeMr(node({ webUrl: 'https://evil.example.com/x' }))] }, ctx);
  assert.ok(!offHost.includes('evil.example.com'), 'merge request links only on the GitLab host');
  assert.match(alertsSection({ data: { alerts: [], duty: [{ queue: 'On-call', who: 'Alice Example' }] } }, ctx), /No open alerts/);
  assert.match(oncallSection({ data: { alerts: [], duty: [{ queue: 'On-call', who: 'Alice Example' }] } }, ctx), /Alice Example/);
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

test('ordering a ticket: a rank next to a ticket on the board, also within its column, and with a move', async () => {
  const moves = [];
  const ranks = [];
  const sources = {
    sprint: async () => ({ total: 3, todo: [{ key: 'ABC-1', summary: 'S', assignee: 'A', status: 'Open' }], inProgress: [], inReview: [{ key: 'ABC-2', summary: 'S', assignee: 'A', status: 'In Review' }, { key: 'ABC-3', summary: 'S', assignee: 'A', status: 'In Review' }] }),
    move: async (key, to) => { moves.push([key, to]); return 'In Review'; },
    rank: async (key, at) => { ranks.push([key, at]); },
  };
  await withDashboard({ sources }, async ({ base }) => {
    const { cookie } = await signIn(base);
    const html = await (await fetch(`${base}/approve/dashboard`, { headers: { Cookie: cookie } })).text();
    const csrf = /id="dash-csrf" value="([^"]+)"/.exec(html)[1];
    const post = (body) => fetch(`${base}/approve/dashboard/move`, { method: 'POST', headers: { ...FORM, Accept: 'application/json', Cookie: cookie, Origin: ORIGIN }, body: new URLSearchParams(body).toString() });
    assert.equal((await post({ csrf, key: 'ABC-3', to: 'inReview', before: 'ABC-9' })).status, 404, 'the neighbour must be on the board');
    assert.equal((await post({ csrf, key: 'ABC-3', to: 'inReview', before: 'x' })).status, 400);
    assert.deepEqual(await (await post({ csrf, key: 'ABC-3', to: 'inReview', before: 'ABC-2' })).json(), { status: 'moved', text: 'ABC-3 ranked above ABC-2.' });
    assert.deepEqual(moves, [], 'no transition within a column');
    assert.deepEqual(await (await post({ csrf, key: 'ABC-1', to: 'inReview', after: 'ABC-3' })).json(), { status: 'moved', text: 'ABC-1 moved to In Review.' });
    assert.deepEqual(moves, [['ABC-1', 'inReview']]);
    assert.deepEqual(ranks, [['ABC-3', { before: 'ABC-2' }], ['ABC-1', { after: 'ABC-3' }]]);
  });
});

test('sprint board: an "Only mine" toggle in the card header, per-column counts of the visitor’s tickets', () => {
  const html = sprintSection({ data: { todo: [{ key: 'ABC-1', summary: 's', assignee: 'Alice' }, { key: 'ABC-2', summary: 's', assignee: 'Bob' }], inProgress: [], inReview: [] } }, { name: 'Alice', avatars: {} });
  assert.doesNotMatch(html, /data-sprintmine-toggle/, 'not in the refreshed body');
  assert.match(html, /data-col="todo"><h4>To do<span data-col-count><span class="n-all">2<\/span><span class="n-mine">1<\/span>/);
  assert.match(html, /<li class="tk mine" data-key="ABC-1"/);
  const script = dashboardScript('/dashboard');
  assert.match(script, /tl-sprintmine/);
  assert.match(script, /if\(k==='sprint'\)smn\(\)/, 'the header count follows a refresh');
});

test('merge request panel: the pipeline and its stages on one row, the diff of each file below', () => {
  const ctx = { host: GL, avatars: {}, now: Date.now(), timeZone: 'UTC' };
  const mr = { iid: 7, state: 'opened', title: 'T', web_url: `https://${GL}/group/app/-/merge_requests/7`, head_pipeline: { id: 5, status: 'running', web_url: `https://${GL}/group/app/-/pipelines/5` } };
  const diffs = [
    { old_path: 'a.js', new_path: 'a.js', diff: '@@ -1,2 +1,2 @@\n-old <b>\n+new\n same\n' },
    { old_path: 'big.bin', new_path: 'big.bin', diff: '', too_large: true },
    { old_path: 'n.txt', new_path: 'n.txt', new_file: true, diff: '@@ -0,0 +1 @@\n+x\n' },
  ];
  const { html } = mrDetail({ mr, jobs: [{ stage: 'test', name: 'unit', status: 'running' }], diffs }, ctx);
  assert.match(html, /<span class="pipe-row"><span class="pipe">[\s\S]*?<\/span><span class="stages">/, 'stages sit next to the pipeline link');
  assert.match(html, /<h3 class="dsub">Changes <span class="dsum">3 files · <span class="dadd">\+2<\/span> <span class="ddel">−1<\/span>/, 'totals in the heading');
  assert.match(html, /<select class="dsel" data-diff-sel aria-label="File"><option value="0">a\.js  \+1 −1<\/option><option value="1">big\.bin  \+0 −0<\/option><option value="2">n\.txt \(added\)  \+1 −0<\/option><\/select>/, 'one selector for the files');
  assert.match(html, /data-diff-step="1"/);
  assert.match(html, /<div class="dpane" data-diff-pane="0"><div class="dpath">/, 'the first file is shown');
  assert.match(html, /data-diff-pane="1" hidden>/, 'the others wait');
  assert.match(html, /<tr class="dl-hunk"><td class="ln"><\/td><td class="ln"><\/td><td class="dc">@@ -1,2 \+1,2 @@<\/td><\/tr><tr class="dl-del"><td class="ln">1<\/td><td class="ln"><\/td><td class="dc"><span class="dm">−<\/span>old &lt;b&gt;<\/td><\/tr><tr class="dl-add"><td class="ln"><\/td><td class="ln">1<\/td><td class="dc"><span class="dm">\+<\/span>new<\/td><\/tr><tr class="dl-ctx"><td class="ln">2<\/td><td class="ln">2<\/td>/, 'old and new line numbers, escaped');
  assert.match(html, /big\.bin[\s\S]*?too large or binary/);
  assert.equal(diffsSection(null), '', 'nothing when GitLab gave no diffs');
  assert.doesNotMatch(diffsSection([{ new_path: 'f', diff: '+a\n' }]), /data-diff-step/, 'no previous and next for one file');
  assert.match(dashboardScript('/dashboard'), /data-diff-sel/);
});

test('detail panels open from a prefetched copy: on hover, focus, touch and when idle, kept 30 s, dropped after a write', () => {
  const script = dashboardScript('/dashboard');
  assert.match(script, /addEventListener\('pointerover'[\s\S]*?prefetch\(el\)/);
  assert.match(script, /addEventListener\('focusin'[\s\S]*?prefetch\(el\)/);
  assert.match(script, /requestIdleCallback/);
  assert.match(script, /if\(c0&&c0\.x\)show\(c0\.x\)/, 'a cached copy shows at once');
  assert.doesNotMatch(script, /DC=\{\}/, 'a write drops only what it changed, not every panel');
  assert.equal((script.match(/busy--;dinv\('\/mr\?ref='\+encodeURIComponent\(ref\)\)/g) || []).length, 2, 'approving and merging drop that merge request');
  assert.match(script, /busy--;dinv\('\/issue\?key='/, 'moving drops that ticket');
  assert.match(script, /sessionStorage\.setItem\('tl-dc'/, 'kept for reloads in the tab');
  assert.match(script, /function forget\(\)\{try\{sessionStorage\.removeItem\('tl-dc'\)/, 'and forgotten at sign-out');
  assert.match(script, /if\(x\.pending\)pendLater\(q,n,0\)/, 'a panel still waiting for a source asks again');
});

test('the page script parses (a syntax error would leave the whole page inert)', () => {
  assert.doesNotThrow(() => new Function(dashboardScript('/dashboard')));
  assert.doesNotThrow(() => new Function(liveScript('/approve/state')));
  assert.doesNotThrow(() => new Function(BATCH_APPROVAL_SCRIPT));
});

test('alert panels: URLs in the source, description and details are links, everything else stays escaped', () => {
  const ctx = { host: GL, avatars: {}, now: Date.now(), timeZone: 'UTC' };
  const html = alertDetail({ message: 'm', source: 'http://alertmanager.example.com:9093/#/alerts?receiver=x', description: 'Runbook https://docs.example.com/runbook.md.\n<b>x</b> javascript:alert(1)', details: { runbook: 'see https://docs.example.com/a' } }, ctx).html;
  assert.match(html, /<dt>Source<\/dt><dd><a href="http:\/\/alertmanager\.example\.com:9093\/#\/alerts\?receiver=x" target="_blank" rel="noopener noreferrer">/);
  assert.match(html, /Runbook <a href="https:\/\/docs\.example\.com\/runbook\.md"[^>]*>https:\/\/docs\.example\.com\/runbook\.md<\/a>\./, 'the full stop stays outside');
  assert.match(html, /see <a href="https:\/\/docs\.example\.com\/a"/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt; javascript:alert\(1\)/);
  assert.equal(linkify('(https://e.example.com/Foo_(bar))'), '(<a href="https://e.example.com/Foo_(bar)" target="_blank" rel="noopener noreferrer">https://e.example.com/Foo_(bar)</a>)');
});

test('people are buttons that open the person panel; a placeholder name stays text', () => {
  assert.match(personRef('Alice <Example>', {}), /^<button type="button" class="pref" data-person="Alice &lt;Example&gt;" title="About Alice &lt;Example&gt;">/);
  assert.doesNotMatch(personRef('Unassigned', {}), /<button/);
  assert.equal(personRef('', {}), '');
  const ctx = { username: 'alice', name: 'Alice', host: GL, avatars: {}, now: Date.now(), timeZone: 'UTC' };
  assert.match(oncallSection({ data: { alerts: [], duty: [{ queue: 'On-call', people: [{ name: 'Carol Example' }] }] } }, ctx), /<span class="duty-p"><button type="button" class="pref" data-person="Carol Example"[^>]*>[\s\S]*?<b>Carol Example<\/b><\/button>/);
  assert.match(mrsSection({ items: [normalizeMr(node())] }, ctx), /· <button type="button" class="pref" data-person="Bob Example"/);
  const script = dashboardScript('/dashboard');
  assert.match(script, /'\/person\?name='\+encodeURIComponent\(pp\)/);
  assert.match(script, /var pr=e\.target\.closest\('\[data-person\]'\);if\(pr\)\{e\.preventDefault\(\);openDetail\(pr\)/, 'a person wins over the row it sits in');
  const people = dashboardPeople({ mrs: { items: [normalizeMr(node())] }, sprint: { data: { todo: [{ assignee: 'Erin Example' }] } }, alerts: { data: { duty: [{ people: [{ name: 'Carol Example' }] }, { who: 'Dave Example' }] } }, meetings: { data: [{ organizer: 'Frank Example' }] } });
  assert.deepEqual([...people].sort(), ['Bob Example', 'Carol Example', 'Dave Example', 'Erin Example', 'Frank Example'].sort());
});

test('the person panel: Teams status, HR WORKS, chat, call and email; nothing invented when unknown', () => {
  const ctx = { avatars: {} };
  const html = personDetail({ found: true, name: 'Carol Example', email: 'carol@example.com', mri: '8:orgid:00000000-0000-0000-0000-000000000001', jobTitle: 'Engineer', department: 'Platform', presence: { availability: 'Busy', activity: 'InAMeeting' }, absence: { state: 'present', upcoming: { category: 'Vacation', startDate: '2026-12-01', endDate: '2026-12-05' } } }, ctx).html;
  assert.match(html, /<b>Carol Example<\/b><span>Engineer<\/span>/);
  assert.match(html, /href="https:\/\/teams\.microsoft\.com\/l\/chat\/0\/0\?users=carol%40example\.com"/);
  assert.match(html, /href="https:\/\/teams\.microsoft\.com\/l\/call\/0\/0\?users=carol%40example\.com"/);
  assert.match(html, /href="mailto:carol@example\.com"/);
  assert.match(html, /<span class="pill pill-bad">Busy<\/span><span class="note">In a meeting<\/span>/);
  assert.match(html, /<span class="pill pill-ok">Present<\/span><span class="note">Next: Vacation \(2026-12-01 – 2026-12-05\)<\/span>/);
  const away = personDetail({ found: true, name: 'C', absence: { state: 'away', current: { category: 'Sick', startDate: '2026-11-25' } } }, ctx).html;
  assert.match(away, /pill-bad">Away<\/span><span class="note">Sick \(2026-11-25\)/);
  assert.doesNotMatch(away, /Chat in Teams|mailto/, 'no links without an address');
  assert.match(personDetail({ found: false, name: 'Zed', reason: 'Several people in the Teams directory have this name.' }, ctx).html, /Several people/);
});

test('the person endpoint answers only for people the visitor\'s dashboard shows', async () => {
  const asked = [];
  const personInfo = async (name) => { asked.push(name); return { found: true, name, email: 'bob@example.com', presence: { availability: 'Available' } }; };
  await withDashboard({ personInfo }, async ({ base }) => {
    const { cookie } = await signIn(base);
    const get = (name) => fetch(`${base}/approve/dashboard/person?name=${encodeURIComponent(name)}`, { headers: { Cookie: cookie } });
    assert.equal((await fetch(`${base}/approve/dashboard/person?name=Bob%20Example`)).status, 401);
    assert.equal((await get('Mallory Example')).status, 404, 'not on the dashboard');
    assert.deepEqual(asked, []);
    const res = await get('Bob Example');
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.title, 'Bob Example');
    assert.match(d.html, /pill-ok">Available/);
    await get('Bob Example');
    assert.deepEqual(asked, ['Bob Example'], 'looked up once, then cached');
  });
});

test('the Leave card lists HR WORKS absences of the week, its people open the person panel', () => {
  const ctx = { avatars: {}, now: Date.parse('2026-11-25T10:00:00Z'), timeZone: 'Europe/Berlin' };
  const html = leaveSection({ data: [
    { name: 'Erin Example', category: 'Vacation', startDate: '2026-11-24', endDate: '2026-11-28' },
    { name: 'Frank Example', category: 'Sick', startDate: '2026-11-25', endDate: '2026-11-25' },
    { name: 'Gina Example', category: 'Vacation', startDate: '2026-11-30', endDate: '2026-12-02' },
  ] }, ctx);
  assert.match(html, /^<div class="leave"><ul class="llist">/);
  assert.doesNotMatch(meetingsSection({ data: [] }, ctx), /leave/, 'no longer inside the meetings');
  assert.match(html, /<li class="now" [^>]*><button[^>]*data-person="Erin Example"[\s\S]*?<small>Vacation · until Sat 28 Nov<\/small>/);
  assert.match(html, /<small>Sick · today<\/small>/);
  assert.match(html, /<li class="" [^>]*>[\s\S]*?Gina Example[\s\S]*?<small>Vacation · Mon 30 Nov – Wed 2 Dec<\/small>/);
  assert.match(leaveSection({ off: true }, ctx), /HR WORKS is not configured/);
  assert.match(leaveSection({ pending: true }, ctx), /Reading HR WORKS/);
  assert.match(leaveSection({ data: [] }, ctx), /Nobody on leave this week/);
  assert.ok(dashboardPeople({ leave: { data: [{ name: 'Erin Example' }] } }).has('Erin Example'));
});

test('the On-call card: who is on duty, and the visitor\'s own current or next shift (matched by name)', () => {
  const ctx = { name: 'Philippa Müller', avatars: {}, now: Date.parse('2026-11-25T10:00:00Z'), timeZone: 'Europe/Berlin' };
  const shifts = [
    { queue: 'On-call', shifts: [
      { name: 'Louis Example', start: '2026-11-24T08:00:00Z', end: '2026-12-01T08:00:00Z' },
      { name: 'Philippa Mueller', start: '2026-12-01T08:00:00Z', end: '2026-12-08T08:00:00Z' },
    ] },
    { queue: 'Support', shifts: null },
  ];
  const html = oncallSection({ data: { duty: [{ queue: 'On-call', people: [{ name: 'Louis Example' }] }], shifts } }, ctx);
  assert.match(html, /<div class="myshift">[\s\S]*<b>Your next shift<\/b> · On-call · Tue 1 Dec 09:00 – Tue 8 Dec 09:00/);
  assert.match(html, /data-person="Louis Example"/);
  const now = oncallSection({ data: { duty: [], shifts: [{ queue: 'Support', shifts: [{ name: 'Philippa Müller', start: '2026-11-25T08:00:00Z', end: '2026-11-26T08:00:00Z' }] }] } }, ctx);
  assert.match(now, /<div class="myshift now">[\s\S]*You are on duty now<\/b> · Support until Thu 26 Nov 09:00/);
  assert.match(oncallSection({ data: { duty: [], shifts: [{ queue: 'On-call', shifts: [] }] } }, ctx), /No shift for you in the next four weeks/);
  assert.doesNotMatch(oncallSection({ data: { duty: [{ queue: 'On-call', people: [] }], shifts: [{ queue: 'On-call', shifts: null }] } }, ctx), /myshift/, 'nothing claimed when the timeline is unknown');
});

test('the sprint card has no summary bar any more; alerts and on-call, meetings and leave are separate cards', () => {
  const ctx = { username: 'alice', name: 'Alice', host: GL, avatars: {}, now: Date.now(), timeZone: 'UTC' };
  assert.doesNotMatch(sprintSection({ data: { todo: [{ key: 'ABC-1', summary: 's', assignee: 'Alice' }] } }, ctx), /sbar|slegend/);
});

test('meetings: Today and Tomorrow pills filter the list; every meeting of both days is listed', () => {
  const now = Date.parse('2026-11-25T08:00:00Z');
  const at = (day, h) => new Date(Date.parse(`2026-11-${day}T00:00:00Z`) + h * 3_600_000).toISOString();
  const data = [];
  for (let h = 9; h < 15; h++) data.push({ subject: `Today ${h}`, startTime: at(25, h), endTime: at(25, h + 0.5) });
  for (let h = 9; h < 13; h++) data.push({ subject: `Tomorrow ${h}`, startTime: at(26, h), endTime: at(26, h + 0.5) });
  data.push({ subject: 'Later', startTime: at(28, 9), endTime: at(28, 10) });
  const html = meetingsSection({ data }, { avatars: {}, now, timeZone: 'UTC' });
  assert.equal((html.match(/class="mt[^"]*" data-md="today"/g) || []).length, 6);
  assert.equal((html.match(/class="mt[^"]*" data-md="tomorrow"/g) || []).length, 4, 'all of tomorrow, beyond the first eight');
  assert.doesNotMatch(html, /Later/, 'later days only up to eight in all');
  assert.match(html, /<li class="day" data-md="today">Today<\/li>/);
  assert.match(html, /<li class="none only-tomorrow">No meetings tomorrow\.<\/li>/);
  assert.match(DASHBOARD_CSS, /\.dash\[data-mtf=today\] \.mlist \[data-md\]:not\(\[data-md=today\]\)/);
  const script = dashboardScript('/dashboard');
  assert.match(script, /var mf=e\.target\.closest\('\[data-mtf-to\]'\);if\(mf\)\{mtf\(/);
  assert.match(script, /localStorage\.setItem\('tl-mtf',on\)/);
});

test('detail panels do not wait for the whole dashboard: the last known data is enough when it lists the item', async () => {
  let clock = Date.now();
  const personInfo = async (name) => ({ found: true, name, absence: { state: 'pending' } });
  await withDashboard({ personInfo, now: () => clock }, async ({ base, seen }) => {
    const { cookie } = await signIn(base);
    await fetch(`${base}/approve/dashboard`, { headers: { Cookie: cookie } });
    const lists = () => seen.filter((c) => c.url.endsWith('/api/graphql')).length;
    const before = lists();
    clock += 120_000;
    const res = await fetch(`${base}/approve/dashboard/mr?ref=${encodeURIComponent('group/app!7')}`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.equal(lists(), before, 'the merge request list was not read again');
    assert.match(res.headers.get('server-timing'), /^check;dur=[\d.]+, fetch;dur=[\d.]+, photos;dur=[\d.]+$/);
    assert.equal((await fetch(`${base}/approve/dashboard/mr?ref=${encodeURIComponent('group/app!8')}`, { headers: { Cookie: cookie } })).status, 404);
    assert.equal(lists(), before + 1, 'an unknown item waits for fresh data once');
    const person = await (await fetch(`${base}/approve/dashboard/person?name=${encodeURIComponent('Bob Example')}`, { headers: { Cookie: cookie } })).json();
    assert.equal(person.pending, true);
    assert.match(person.html, /data-pending>Checking HR WORKS/);
  });
});

test('a slow or failing HR WORKS never holds up the dashboard: the Leave card shows its last answer or that it is loading', async () => {
  let calls = 0;
  await withDashboard({ sources: { leave: () => { calls++; return new Promise(() => {}); } } }, async ({ base }) => {
    const { cookie } = await signIn(base);
    const started = Date.now();
    const page = await (await fetch(`${base}/approve/dashboard`, { headers: { Cookie: cookie } })).text();
    const data = await (await fetch(`${base}/approve/dashboard/data`, { headers: { Cookie: cookie } })).json();
    assert.ok(Date.now() - started < 2_000, 'no wait for HR WORKS');
    assert.match(page, /Reading HR WORKS/);
    assert.match(data.sections.leave, /Reading HR WORKS/);
    assert.equal(calls, 1, 'one read in flight, not one per refresh');
  });
});

test('the person panel reads the absence fresh for every request, while the directory answer stays cached', async () => {
  let state = 'pending';
  const asked = [];
  const personInfo = async (name) => { asked.push(name); return { found: true, name, directory: { displayName: name } }; };
  const personAbsence = async () => (state === 'pending' ? { state } : { state: 'away', current: { category: 'Vacation', startDate: '2026-11-25' } });
  await withDashboard({ personInfo, personAbsence }, async ({ base }) => {
    const { cookie } = await signIn(base);
    const get = async () => (await fetch(`${base}/approve/dashboard/person?name=${encodeURIComponent('Bob Example')}`, { headers: { Cookie: cookie } })).json();
    const first = await get();
    assert.equal(first.pending, true);
    state = 'away';
    const second = await get();
    assert.equal(second.pending, false);
    assert.match(second.html, /pill-bad">Away<\/span><span class="note">Vacation/);
    assert.deepEqual(asked, ['Bob Example'], 'the directory was asked once');
  });
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
    assert.match(d.html, /<dt>Status<\/dt><dd><span class="dstate"><span class="pill pill-ok">Open<\/span>/, 'the state is a row of its own');
    assert.match(d.html, /<dt>Approvals<\/dt><dd><span class="appr-line">[\s\S]*?<button[^>]*data-approve data-project="group\/app" data-iid="7"/, 'the Approve button sits on the Approvals row');
    const read = seen.filter((c) => c.url.endsWith('/merge_requests/7'));
    assert.ok(read.length && read.every((c) => c.options.headers.Authorization === 'Bearer tok'));
  });
});

test('an approval drops the cached detail panel, so it no longer shows the old count', async () => {
  await withDashboard({ nodes: [node({ approvalsRequired: 1, approvalsLeft: 1, approvedBy: { nodes: [] } })] }, async ({ base }) => {
    const { cookie } = await signIn(base);
    const html = await (await fetch(`${base}/approve/dashboard`, { headers: { Cookie: cookie } })).text();
    const csrf = /id="dash-csrf" value="([^"]+)"/.exec(html)[1];
    const mock = globalThis.fetch;
    let approved = false;
    globalThis.fetch = async (url, options = {}) => {
      const u = String(url);
      if (u.endsWith('/merge_requests/7/approvals')) {
        return Response.json(approved
          ? { approved: true, approvals_required: 1, approvals_left: 0, approved_by: [{ user: { id: 9, username: 'alice', name: 'Alice Example' } }], user_has_approved: true, user_can_approve: true }
          : { approved: false, approvals_required: 1, approvals_left: 1, approved_by: [], user_can_approve: true });
      }
      const res = await mock(url, options);
      if (u.endsWith('/merge_requests/7/approve') && options.method === 'POST') approved = true;
      return res;
    };
    const detail = async () => (await (await fetch(`${base}/approve/dashboard/mr?ref=${encodeURIComponent('group/app!7')}`, { headers: { Cookie: cookie } })).json()).html;
    assert.match(await detail(), /alt="0 of 1 approvals"/, 'cached before the approval');
    const ok = await fetch(`${base}/approve/dashboard/approve`, { method: 'POST', headers: { ...FORM, Accept: 'application/json', Cookie: cookie, Origin: ORIGIN }, body: new URLSearchParams({ csrf, project: 'group/app', iid: '7', sha: SHA }).toString() });
    assert.equal((await ok.json()).status, 'approved');
    const after = await detail();
    assert.match(after, /alt="Approved"/);
    assert.doesNotMatch(after, /0 of 1/);
  });
});

test('Merge buttons: only while merging is on and GitLab reports the merge request as mergeable for the visitor', () => {
  const ready = normalizeMr(node({ detailedMergeStatus: 'MERGEABLE', userPermissions: { canApprove: true, canMerge: true } }));
  assert.match(mergeButton(ready, { merge: true }), /data-merge data-project="group\/app" data-iid="7" data-sha="b{40}"/);
  assert.equal(mergeButton(ready, { merge: false }), '', 'merging off');
  assert.equal(mergeButton({ ...ready, canMerge: false }, { merge: true }), '', 'not allowed to merge');
  assert.equal(mergeButton({ ...ready, mergeStatus: 'not_approved' }, { merge: true }), '', 'not mergeable');
  assert.equal(mergeButton({ ...ready, draft: true }, { merge: true }), '');
  const ctx = { host: GL, avatars: {}, now: Date.now(), timeZone: 'UTC', merge: true };
  const detail = (over) => mrDetail({ mr: { iid: 7, state: 'opened', sha: SHA, title: 'T', detailed_merge_status: 'mergeable', web_url: `https://${GL}/group/app/-/merge_requests/7`, references: { full: 'group/app!7' }, ...over }, approvals: { approved: true, approvals_required: 1, approved_by: [{ user: { username: 'alice', name: 'Alice' } }] } }, ctx).html;
  assert.match(detail(), /<dt>Approvals<\/dt><dd><span class="appr-line">[\s\S]*?<button[^>]*data-merge data-project="group\/app" data-iid="7"/, 'Merge sits on the Approvals row');
  assert.doesNotMatch(detail({ detailed_merge_status: 'ci_still_running' }), /data-merge/);
  assert.doesNotMatch(detail({ user: { can_merge: false } }), /data-merge/);
  assert.match(dashboardScript('/dashboard'), /B\+'\/merge'/);
});

test('a dashboard merge is one PUT as the visitor, pinned to the head, only when mergeable', async () => {
  await withDashboard({ mergeEnabled: true }, async ({ base, seen }) => {
    const { cookie } = await signIn(base);
    const html = await (await fetch(`${base}/approve/dashboard`, { headers: { Cookie: cookie } })).text();
    const csrf = /id="dash-csrf" value="([^"]+)"/.exec(html)[1];
    const mock = globalThis.fetch;
    let mr = { state: 'opened', draft: false, sha: SHA, author: { username: 'bob' }, detailed_merge_status: 'not_approved', user: { can_merge: true } };
    globalThis.fetch = async (url, options = {}) => {
      const u = String(url);
      if (u.endsWith('/merge_requests/7/merge') && options.method === 'PUT') {
        seen.push({ url: u, options });
        mr = { ...mr, state: 'merged' };
        return Response.json(mr);
      }
      if (u.endsWith('/merge_requests/7')) return Response.json(mr);
      return mock(url, options);
    };
    const post = (body, headers = { Origin: ORIGIN }) =>
      fetch(`${base}/approve/dashboard/merge`, { method: 'POST', headers: { ...FORM, Accept: 'application/json', Cookie: cookie, ...headers }, body: new URLSearchParams(body).toString() });
    const writes = () => seen.filter((c) => c.url.endsWith('/merge') && c.options.method === 'PUT');
    assert.equal((await post({ csrf, project: 'group/app', iid: '7', sha: SHA }, { Origin: 'https://evil.example.com' })).status, 403);
    assert.equal((await post({ csrf: 'x', project: 'group/app', iid: '7', sha: SHA })).status, 403);
    const blocked = await (await post({ csrf, project: 'group/app', iid: '7', sha: SHA })).json();
    assert.equal(blocked.status, 'failed');
    assert.match(blocked.text, /not report it as mergeable/);
    mr = { ...mr, detailed_merge_status: 'mergeable' };
    assert.equal((await (await post({ csrf, project: 'group/app', iid: '7', sha: 'c'.repeat(40) })).json()).status, 'failed', 'a moved head is refused');
    assert.equal(writes().length, 0);
    const ok = await (await post({ csrf, project: 'group/app', iid: '7', sha: SHA })).json();
    assert.equal(ok.status, 'merged');
    assert.equal(writes().length, 1);
    assert.equal(writes()[0].options.headers.Authorization, 'Bearer tok');
    assert.deepEqual(JSON.parse(writes()[0].options.body), { sha: SHA });
    assert.equal((await (await post({ csrf, project: 'group/app', iid: '7', sha: SHA })).json()).status, 'already');
    assert.equal(writes().length, 1, 'never sent twice');
  });
  await withDashboard({}, async ({ base }) => {
    const { cookie } = await signIn(base);
    const html = await (await fetch(`${base}/approve/dashboard`, { headers: { Cookie: cookie } })).text();
    const csrf = /id="dash-csrf" value="([^"]+)"/.exec(html)[1];
    const res = await fetch(`${base}/approve/dashboard/merge`, { method: 'POST', headers: { ...FORM, Accept: 'application/json', Cookie: cookie, Origin: ORIGIN }, body: new URLSearchParams({ csrf, project: 'group/app', iid: '7', sha: SHA }).toString() });
    assert.equal(res.status, 409, 'merging off');
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
  const html = oncallSection({ data: { alerts: [], duty: [{ queue: 'On-call', people: [{ name: 'Carol Example', email: 'carol.example@example.com' }] }, { queue: 'Support', people: [{ name: 'Dave Example' }] }, { queue: 'Edge', people: [] }] } }, ctx);
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
    assert.match(page.headers.get('content-security-policy'), /img-src data: 'self';/, 'its own app icon, for the home screen and notifications');
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

test('notification events: review requests, own merge requests, own tickets, open alerts and the next meetings', () => {
  const now = Date.parse('2026-01-05T09:00:00Z');
  const mine = node({ iid: '8', author: { username: 'alice', name: 'Alice Example' }, reviewers: { nodes: [] }, detailedMergeStatus: 'MERGEABLE', headPipeline: { status: 'FAILED' }, approvedBy: { nodes: [{ username: 'carol', name: 'Carol Example' }, { username: 'alice', name: 'Alice Example' }] } });
  const data = {
    mrs: { items: [normalizeMr(node()), normalizeMr(mine)] },
    sprint: { data: { todo: [{ key: 'ABC-1', summary: 'Rotate keys', assignee: 'Alice Example' }, { key: 'ABC-2', summary: 'Other', assignee: 'Bob Example' }], inProgress: [], inReview: [] } },
    alerts: { data: { alerts: [{ id: 'a1', priority: 'P1', message: 'Disk full', queue: 'On-call' }, { id: 'a2', priority: 'P3', message: 'Seen', acknowledged: true }] } },
    meetings: { data: [{ subject: 'Standup', startTime: '2026-01-05T09:30:00Z', endTime: '2026-01-05T09:45:00Z', organizer: 'Bob Example' }, { subject: 'Past', startTime: '2026-01-05T08:00:00Z', endTime: '2026-01-05T08:30:00Z' }, { subject: 'Next week', startTime: '2026-01-12T09:00:00Z', endTime: '2026-01-12T10:00:00Z' }] },
  };
  const events = notifyEvents(data, { username: 'alice', name: 'Alice Example', now, timeZone: 'UTC' });
  const byId = Object.fromEntries(events.map((e) => [e.id, e]));
  assert.deepEqual(Object.keys(byId).sort(), ['alert:a1', 'approved:group/app!8:carol', 'assigned:ABC-1', 'meeting:Standup@2026-01-05T09:30:00Z', 'pipeline:group/app!8@' + SHA, 'ready:group/app!8', 'review:group/app!7'].sort());
  assert.deepEqual(byId['review:group/app!7'].o, ['mr', 'group/app!7']);
  assert.equal(byId['review:group/app!7'].v, 'mrs');
  assert.equal(byId['alert:a1'].p, 1);
  assert.equal(byId['meeting:Standup@2026-01-05T09:30:00Z'].at, Date.parse('2026-01-05T09:30:00Z'));
  assert.equal(byId['meeting:Standup@2026-01-05T09:30:00Z'].b, 'Starts at 09:30 · Bob Example');
  for (const e of events) assert.ok(NOTIFY_KINDS.some(([k]) => k === e.k), `${e.k} is a kind the settings offer`);
  const failed = notifyEvents({ mrs: { error: 'x' }, sprint: { error: 'x' }, alerts: { error: 'x' }, meetings: { error: 'x' } }, { username: 'alice', name: 'Alice Example', now, timeZone: 'UTC' });
  assert.deepEqual(failed, [], 'a failing source yields no events');
});

test('settings: one switch per event kind, the page carries the events, the data endpoint too', async () => {
  const html = settingsSection();
  for (const [k] of NOTIFY_KINDS) assert.match(html, new RegExp(`data-notify-kind="${k}"`));
  assert.match(html, /data-notify-on/);
  assert.match(html, /data-notify-prio/);
  assert.match(html, /data-notify-lead/);
  assert.match(serviceWorkerScript('/dashboard'), /notificationclick/);
  await withDashboard({}, async ({ base }) => {
    const { cookie } = await signIn(base);
    const page = await (await fetch(`${base}/approve/dashboard`, { headers: { Cookie: cookie } })).text();
    assert.match(page, /data-events="\[\{&quot;id&quot;:&quot;review:group\/app!7&quot;/);
    assert.match(page, /data-settings/);
    assert.match(page, /href="\/approve\/dashboard#settings" data-view-to="settings"/, 'the account menu leads to the settings');
    const data = await (await fetch(`${base}/approve/dashboard/data`, { headers: { Cookie: cookie } })).json();
    assert.equal(data.events[0].id, 'review:group/app!7');
  });
});

/** Opens a push message as the browser would (RFC 8291): the payload the server sent, as JSON. */
function openPush(body, ua, auth) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const prkKey = hmac(auth, ua.computeSecret(asPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const decipher = crypto.createDecipheriv('aes-128-gcm', hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12));
  const data = body.subarray(21 + idlen);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  assert.equal(plain[plain.length - 1], 2, 'one final record');
  return JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'));
}

test('notification settings: unknown kinds and odd values fall back to the defaults', () => {
  assert.deepEqual(normalizeNotifySettings(null), { kinds: NOTIFY_DEFAULTS.kinds, prio: 'P2', lead: 5 });
  const s = normalizeNotifySettings({ kinds: { review: false, evil: true, alert: 'yes' }, prio: 'P9', lead: 7 });
  assert.equal(s.kinds.review, false);
  assert.equal(s.kinds.alert, true);
  assert.ok(!('evil' in s.kinds));
  assert.equal(s.prio, 'P2');
  assert.equal(s.lead, 5);
  assert.ok(wantsEvent({ k: 'alert', p: 2 }, s));
  assert.ok(!wantsEvent({ k: 'alert', p: 3 }, s), 'below the chosen priority');
  assert.ok(!wantsEvent({ k: 'review' }, s));
});

test('push: a browser subscribes with its settings, gets only what is new and asked for, and is forgotten on sign-out', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-push-'));
  const pushFile = path.join(dir, 'dashboard-push.json');
  const nodes = [node()];
  const alerts = [];
  const sources = { alerts: async () => ({ alerts, duty: [] }) };
  let firstKey = '';
  try {
    await withDashboard({ nodes, sources, pushFile }, async ({ base, server }) => {
      const { cookie } = await signIn(base);
      const html = await (await fetch(`${base}/approve/dashboard`, { headers: { Cookie: cookie } })).text();
      const key = /data-push-key="([A-Za-z0-9_-]+)"/.exec(html)[1];
      assert.equal(key, server.vapid.publicKey);
      firstKey = key;
      const csrf = /id="dash-csrf" value="([^"]+)"/.exec(html)[1];
      const ua = crypto.createECDH('prime256v1');
      ua.generateKeys();
      const auth = crypto.randomBytes(16);
      const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
      const post = (body, headers = { Origin: ORIGIN }) =>
        fetch(`${base}/approve/dashboard/push`, { method: 'POST', headers: { ...FORM, Accept: 'application/json', Cookie: cookie, ...headers }, body: new URLSearchParams(body).toString() });
      const settings = JSON.stringify({ kinds: { review: true, assigned: false }, prio: 'P1', lead: 5 });

      assert.equal((await post({ csrf: 'x', action: 'save', sub: JSON.stringify(sub), settings })).status, 403);
      assert.equal((await post({ csrf, action: 'save', sub: JSON.stringify(sub), settings }, { Origin: 'https://evil.example.com' })).status, 403);
      assert.equal((await post({ csrf, action: 'save', sub: JSON.stringify({ ...sub, endpoint: 'https://evil.example.com/x' }), settings })).status, 400, 'only real push services');
      assert.equal((await post({ csrf, action: 'save', sub: JSON.stringify(sub), settings })).status, 200);
      assert.equal(server.pushSubs.size, 1);

      const pushes = [];
      const mock = globalThis.fetch;
      globalThis.fetch = async (url, options = {}) => {
        if (String(url) !== sub.endpoint) return mock(url, options);
        pushes.push({ headers: options.headers, payload: openPush(options.body, ua, auth) });
        return new Response('', { status: 201 });
      };
      try {
        await server.pushTick();
        assert.equal(pushes.length, 0, 'the first round only records what is there');
        nodes.push(node({ iid: '9', title: 'New change', webUrl: `https://${GL}/group/app/-/merge_requests/9` }));
        alerts.push({ id: 'a1', priority: 'P1', message: 'Disk full', queue: 'On-call' }, { id: 'a2', priority: 'P3', message: 'Minor' });
        server.dashData.clear();
        server.dashSourceCache.clear();
        await server.pushTick();
        assert.deepEqual(pushes.map((p) => p.payload.id).sort(), ['alert:a1', 'review:group/app!9'], 'the P3 alert is below the chosen priority');
        const review = pushes.find((p) => p.payload.id === 'review:group/app!9');
        assert.deepEqual(review.payload.o, ['mr', 'group/app!9']);
        assert.equal(review.payload.v, 'mrs');
        assert.equal(pushes.find((p) => p.payload.id === 'alert:a1').headers.Urgency, 'high');
        await server.pushTick();
        assert.equal(pushes.length, 2, 'nothing twice');
      } finally {
        globalThis.fetch = mock;
      }

      const saved = fs.readFileSync(pushFile, 'utf8');
      assert.ok(!saved.includes('fcm.googleapis.com') && !saved.includes(server.vapid.privateKey), 'kept encrypted');
      assert.equal((fs.statSync(pushFile).mode & 0o777).toString(8), '600');

      const out = await fetch(`${base}/approve/dashboard/signout`, { method: 'POST', redirect: 'manual', headers: { ...FORM, Origin: ORIGIN, Cookie: cookie }, body: new URLSearchParams({ csrf: /name="csrf" value="([^"]+)" data-csrf/.exec(html)[1] }).toString() });
      assert.equal(out.status, 303);
      assert.equal(server.pushSubs.size, 0, 'the subscription ends with its session');
    });
    await withDashboard({ pushFile }, async ({ server }) => {
      assert.equal(server.vapid.publicKey, firstKey, 'the key pair survives a restart');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a replayed dashboard sign-in (Back through the GitLab consent page) continues to the dashboard', async () => {
  await withDashboard({}, async ({ base, seen }) => {
    const { location, cookie } = await signIn(base);
    const state = location.searchParams.get('state');
    assert.match(state, /^d\./, 'dashboard sign-ins are marked');
    const tokens = () => seen.filter((c) => c.url.endsWith('/oauth/token')).length;
    const before = tokens();
    const again = await fetch(`${base}/approve/oauth/callback?code=othercode&state=${encodeURIComponent(state)}`, { headers: { Cookie: cookie } });
    assert.equal(again.status, 200);
    assert.match(await again.text(), /http-equiv="refresh" content="0;url=\/approve\/dashboard"/);
    assert.equal(again.headers.get('set-cookie'), null, 'no session from a replay');
    assert.equal(tokens(), before, 'the replayed code is not redeemed');
    const unknown = await fetch(`${base}/approve/oauth/callback?code=x&state=unknown`);
    assert.equal(unknown.status, 400, 'any other unknown sign-in still fails');
    assert.match(await unknown.text(), /expired or was not started here/);
  });
});

test('every view is an address: views, the merge request filter and the detail panel go into the history', () => {
  const script = dashboardScript('/dashboard');
  assert.ok(script.includes('(overview|mrs|sprint|alerts|meetings|settings)'), 'all views, the settings too');
  assert.match(script, /history\.pushState/);
  assert.match(script, /addEventListener\('popstate',apply\)/);
  for (const k of ["'mr'", "'issue'", "'alert'", "q.set('f'"]) assert.ok(script.includes(k), k);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMultiMrCard } from '../src/card-multi-mr.mjs';
import { ApproveServer } from '../src/approve.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { setRichMessages, transport } from '../src/teams.mjs';

const origin = 'https://approve.example.com';
const sha = 'a'.repeat(40);
const items = [{ project: 'group/app', iid: '1', sha }, { project: 'group/app', iid: '2', sha }];
const rows = items.map((item, i) => ({ ...item, title: `Change ${i}`, url: `https://gitlab.example.com/group/app/-/merge_requests/${item.iid}`, state: i ? 'open' : 'merged', author: 'Alice Example', approved: true, approvedBy: ['Bob Example'], pipeline: { status: 'success' } }));

test('multi-MR card links titles and references, shows people, merged progress and actions', () => {
  const card = buildMultiMrCard(rows, { approveUrl: 'https://example.com/approve', openUrl: 'https://example.com/open' });
  const content = JSON.stringify(card);
  assert.match(content, /1\/2/);
  assert.match(content, /Alice Example/);
  assert.match(content, /Bob Example/);
  assert.match(content, /Approve all/);
  assert.match(content, /Open all/);
  assert.equal((content.match(/Action.OpenUrl/g) || []).length, 4);
  assert.match(content, /merge_requests\/1/);
  assert.match(content, /merge_requests\/2/);
});

test('multi-MR card offers Merge all only with a merge link', () => {
  assert.doesNotMatch(JSON.stringify(buildMultiMrCard(rows, { approveUrl: 'https://example.com/approve' })), /Merge all/);
  const content = JSON.stringify(buildMultiMrCard(rows, { approveUrl: 'https://example.com/approve', mergeUrl: 'https://example.com/merge', openUrl: 'https://example.com/open' }));
  assert.match(content, /👍 Approve all[\s\S]*🔀 Merge all[\s\S]*🔗 Open all/);
});

test('Merge all checks every member again and merges only the mergeable ones at their head', async () => {
  const merges = [];
  const mrs = {
    1: { state: 'opened', sha, draft: false, title: 'Change 1', author: { username: 'author' }, detailed_merge_status: 'mergeable' },
    2: { state: 'opened', sha, draft: false, title: 'Change 2', author: { username: 'author' }, detailed_merge_status: 'mergeable' },
  };
  const gitlab = {
    host: 'gitlab.example.com',
    mrLink: (project, iid) => `https://gitlab.example.com/${project}/-/merge_requests/${iid}`,
    getMr: async (_project, iid) => mrs[iid],
    getCurrentUser: async () => ({ id: 1, username: 'bot' }),
    getUserApprovalState: async () => ({ known: true, hasApproved: false, canApprove: true, user: { id: 1, username: 'bot' } }),
    mergeMrOnce: async (project, iid, opts) => { merges.push({ project, iid: String(iid), sha: opts.sha }); mrs[iid] = { ...mrs[iid], state: 'merged' }; return mrs[iid]; },
    addMrNote: async () => ({}),
  };
  const off = new ApproveServer({ gitlab, baseUrl: `${origin}/approve`, oauth: { clientId: 'cid', clientSecret: 'secret' } });
  assert.equal(off.batchLinkFor(items, 'merge'), null, 'no Merge all while merging is off');
  const server = new ApproveServer({ gitlab, baseUrl: `${origin}/approve`, port: 0, mergeEnabled: true, mergePollMs: 0, mergePollAttempts: 1, sleep: async () => {}, oauth: { clientId: 'cid', clientSecret: 'secret' } });
  await server.start();
  const base = `http://127.0.0.1:${server.port}/approve`;
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin };
  try {
    const url = server.batchLinkFor(items, 'merge');
    assert.equal(server.store.byToken(url.split('#')[1]).action, 'batch-merge');
    const boot = await fetch(`${base}/session`, { method: 'POST', headers, body: new URLSearchParams({ token: url.split('#')[1] }) });
    const sid = /tl_approve=([^;]+)/.exec(boot.headers.get('set-cookie'))[1];
    const cookie = `tl_approve=${sid}`;
    for (const s of server.sessions.values()) s.user = { id: 9, username: 'alice', name: 'Alice Example' };
    mrs[2] = { ...mrs[2], detailed_merge_status: 'not_approved' };
    const page = await (await fetch(`${base}/confirm`, { headers: { Cookie: cookie } })).text();
    assert.match(page, /❌ 1 of 2 merge request\(s\) cannot be merged right now/);
    assert.match(page, /🔀 Merge 1 eligible/);
    assert.deepEqual(merges, [], 'opening the page merges nothing');
    const fields = Object.fromEntries([...page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]));
    assert.equal((await fetch(`${base}/confirm`, { method: 'POST', headers: { ...headers, Cookie: cookie }, body: new URLSearchParams({ ...fields, actors: 'W10' }) })).status, 403);
    mrs[2] = { ...mrs[2], detailed_merge_status: 'mergeable' };
    const response = await fetch(`${base}/confirm`, { method: 'POST', headers: { ...headers, Cookie: cookie }, body: new URLSearchParams(fields) });
    const result = await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(merges, [{ project: 'group/app', iid: '1', sha }], 'only what the page offered is merged');
    assert.match(result, /❌ 1 of 2 merge request\(s\) were not merged/);
    assert.match(result, /Not offered on the confirmation page/);
  } finally { await server.stop(); }
});

test('bulk confirmation rechecks heads and approves only the still-valid item', async () => {
  const writes = [];
  const heads = { 1: sha, 2: sha };
  const drafts = { 1: false, 2: false };
  const approved = new Set();
  const gitlab = {
    host: 'gitlab.example.com',
    mrLink: (project, iid) => `https://gitlab.example.com/${project}/-/merge_requests/${iid}`,
    pipelineLink: (project, iid) => `https://gitlab.example.com/${project}/-/pipelines/${iid}`,
    getMr: async (_project, iid) => ({ state: 'opened', sha: heads[iid], title: `Change ${iid}`, author: { username: 'author' } }),
    getUserApprovalState: async () => ({ known: true, hasApproved: false, canApprove: true, user: { id: 1, username: 'bot' } }),
    approveMr: async (project, iid, options) => { writes.push({ project, iid, sha: options.sha }); },
  };
  const server = new ApproveServer({ gitlab, baseUrl: `${origin}/approve`, port: 0, oauth: { clientId: 'cid', clientSecret: 'secret' } });
  await server.start();
  const base = `http://127.0.0.1:${server.port}/approve`;
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (!target.startsWith('https://gitlab.example.com/')) return originalFetch(url, options);
    if (target.endsWith('/oauth/token')) return Response.json({ access_token: 'user-token' });
    if (target.endsWith('/api/v4/user')) return Response.json({ id: 9, username: 'alice' });
    const iid = /merge_requests\/(\d+)/.exec(target)?.[1];
    if (target.endsWith('/approvals')) return Response.json({ approved_by: approved.has(iid) ? [{ user: { id: 9, name: 'Alice Example' } }] : [], approvals_required: 1, approvals_left: approved.has(iid) ? 0 : 1, approved: approved.has(iid), user_can_approve: true });
    if (target.endsWith('/approve')) {
      assert.equal(options.headers.Authorization, 'Bearer user-token');
      writes.push({ project: 'group/app', iid, sha: JSON.parse(options.body).sha });
      approved.add(iid);
      return Response.json({});
    }
    return Response.json({ state: 'opened', sha: heads[iid], draft: drafts[iid], title: `Change ${iid}`, author: { username: 'author' }, head_pipeline: { status: 'success', id: 7 }, detailed_merge_status: 'mergeable' });
  };
  try {
    const url = server.batchLinkFor(items, 'approve');
    const token = url.split('#')[1];
    const bootstrap = await fetch(`${base}/session`, { method: 'POST', headers, body: new URLSearchParams({ token }) });
    const cookie = /tl_approve=[^;]+/.exec(bootstrap.headers.get('set-cookie'))[0];
    const start = await fetch(`${base}/oauth/start`, { headers: { Cookie: cookie }, redirect: 'manual' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    await fetch(`${base}/oauth/callback?code=example&state=${state}`);
    drafts[1] = drafts[2] = true;
    const blocked = await (await fetch(`${base}/confirm`, { headers: { Cookie: cookie } })).text();
    assert.match(blocked, /❌ 2 of 2 merge request\(s\) cannot be approved/);
    assert.equal((blocked.match(/❌ This merge request is a draft/g) || []).length, 2);
    assert.match(blocked, /No approvals were sent/);
    assert.doesNotMatch(blocked, /<button class="btn" type="submit">/);
    drafts[1] = drafts[2] = false;
    const confirmation = await fetch(`${base}/confirm`, { headers: { Cookie: cookie } });
    const html = await confirmation.text();
    assert.match(html, /Approve 2 eligible/);
    assert.match(html, /Change 1/);
    assert.match(html, /Pipeline/);
    assert.match(html, /Approvals/);
    assert.match(html, /1 required/);
    assert.equal((html.match(/data-approve-item>/g) || []).length, 2);
    assert.match(html, /aria-label="GitLab account alice"/);
    assert.match(confirmation.headers.get('content-security-policy'), /script-src 'sha256-[A-Za-z0-9+/=]+'; connect-src 'self'/);
    const fields = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]));
    const tampered = await fetch(`${base}/confirm`, { method: 'POST', headers: { ...headers, Cookie: cookie }, body: new URLSearchParams({ ...fields, actors: 'W10' }) });
    assert.equal(tampered.status, 403);
    assert.deepEqual(writes, [], 'the account list is bound to the confirmation token');
    const individual = await fetch(`${base}/confirm`, { method: 'POST', headers: { ...headers, Cookie: cookie, Accept: 'application/json' }, body: new URLSearchParams({ ...fields, item_index: '0' }) });
    assert.deepEqual(await individual.json(), { status: 'approved', text: 'Approved' });
    assert.deepEqual(writes, [{ project: 'group/app', iid: '1', sha }], 'individual action approves only the selected MR');
    heads[2] = 'b'.repeat(40);
    const newer = server.store.linkFor({ ...items[1], sha: heads[2], action: 'approve' });
    const response = await fetch(`${base}/confirm`, { method: 'POST', headers: { ...headers, Cookie: cookie }, body: new URLSearchParams(fields) });
    const result = await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(writes, [{ project: 'group/app', iid: '1', sha }]);
    assert.match(result, /merge request changed/i);
    assert.match(result, /❌ 1 of 2 merge request\(s\) were not confirmed as approved/);
    assert.match(result, /Change 1/);
    assert.match(result, /✅ Already approved by you/);
    assert.equal((result.match(/class="mr"/g) || []).length, 2);
    assert.match(result, /data-status="failed">❌/);
    assert.equal(server.store.byId(newer.record.id).status, 'open', 'an old batch cannot stale the new card link');
  } finally { globalThis.fetch = originalFetch; await server.stop(); }
});

test('open-all has its own route and retries only links blocked on page load', async () => {
  const gitlab = { host: 'gitlab.example.com', mrLink: (project, iid) => `https://gitlab.example.com/${project}/-/merge_requests/${iid}`, getMr: async (_project, iid) => ({ state: 'opened', title: `Change ${iid}`, head_pipeline: { status: 'success' }, author: { name: 'Alice Example' } }), getApprovalSummary: async () => ({ known: true, approvalsGiven: 0, approvalsRequired: 1 }) };
  const server = new ApproveServer({ gitlab, baseUrl: `${origin}/approve`, port: 0, oauth: { clientId: 'cid', clientSecret: 'secret' } });
  await server.start();
  try {
    const link = server.batchLinkFor(items, 'open');
    assert.match(link, /\/approve\/open#/);
    const token = link.split('#')[1];
    const base = `http://127.0.0.1:${server.port}/approve`;
    const entry = await fetch(`${base}/open`);
    assert.match(await entry.text(), /\/open\/view/);
    const remembered = server.whoCookie({ id: 9, username: 'alice', name: 'Alice Example' }).split(';')[0];
    const boot = await fetch(`${base}/session`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, Cookie: remembered }, body: new URLSearchParams({ token }) });
    const cookie = /tl_approve=[^;]+/.exec(boot.headers.get('set-cookie'))[0];
    const response = await fetch(`${base}/open/view`, { headers: { Cookie: cookie } });
    const body = await response.text();
    assert.match(body, /aria-label="GitLab account alice"/);
    assert.match(body, /class="account-avatar"/);
    assert.match(body, /id="open-all"/);
    assert.equal((body.match(/class="mr"/g) || []).length, 2);
    assert.match(body, /Change 1/);
    assert.match(body, /Pipeline/);
    assert.match(body, /1 required/);
    const approveLink = /href="([^"]+)"[^>]*>👍 Approve all<\/a>/.exec(body)?.[1];
    assert.ok(approveLink, 'the page links to the approval confirmation');
    const approveRecord = server.store.byToken(new URL(approveLink).hash.slice(1));
    assert.equal(approveRecord.action, 'batch-approve');
    assert.deepEqual(approveRecord.items, items);
    assert.equal((body.match(/data-mr-link href/g) || []).length, 2);
    assert.doesNotMatch(body, />Open in GitLab</);
    const individualLinks = [...body.matchAll(/href="([^"]+)"[^>]*>👍 Approve<\/a>/g)].map((match) => match[1]);
    assert.equal(individualLinks.length, 2);
    assert.deepEqual(individualLinks.map((url) => server.store.byToken(new URL(url).hash.slice(1))).map(({ project, iid, sha: head, action }) => ({ project, iid, sha: head, action })), items.map((item) => ({ ...item, action: 'approve' })));
    assert.match(body, /Approvals are sent as the signed-in GitLab user/);
    assert.match(response.headers.get('content-security-policy'), /script-src 'sha256-/);
    const script = /<script>([\s\S]*?)<\/script>/.exec(body)[1];
    const opened = [];
    const anchors = ['https://gitlab.example.com/1', 'https://gitlab.example.com/2'].map((href) => ({ href, marked: false, setAttribute() { this.marked = true; } }));
    const button = { hidden: false, addEventListener(_event, handler) { this.click = handler; } };
    const note = { textContent: '' };
    let allow = false;
    let closed = false;
    const window = { open() { if (!allow && opened.length) return null; return { location: { replace(url) { opened.push(url); } } }; }, close() { closed = true; } };
    const document = { getElementById(id) { return id === 'open-all' ? button : note; }, querySelectorAll() { return anchors.filter((a) => !a.marked); } };
    vm.runInNewContext(script, { window, document });
    assert.deepEqual(opened, [anchors[0].href]);
    assert.equal(closed, false, 'blocked tabs keep the fallback page open');
    assert.match(note.textContent, /Allow pop-ups/);
    allow = true;
    button.click();
    assert.deepEqual(opened, anchors.map((a) => a.href), 'retry does not reopen successful tabs');
    assert.equal(closed, false, 'the page stays open for Approve all');
    assert.equal(button.hidden, true);
    assert.equal((await fetch(`${base}/confirm`, { headers: { Cookie: cookie } })).status, 200, 'old open-all links continue to work');
  } finally { await server.stop(); }
});

test('watcher sends one combined reply, updates it on a merge, and persists its ID', async () => {
  const sent = [];
  const original = { ...transport };
  transport.sendMessage = async (...args) => { sent.push({ type: 'send', args }); return { ok: true, value: { timestamp: '1700000000001' } }; };
  transport.editMessage = async (...args) => { sent.push({ type: 'edit', args }); return { ok: true, value: {} }; };
  const states = { 1: 'pending', 2: 'pending' };
  const gitlab = {
    mrLink: (project, iid) => `https://gitlab.example.com/${project}/-/merge_requests/${iid}`,
    pipelineLink: (project, iid) => `https://gitlab.example.com/${project}/-/pipelines/${iid}`,
    getMrStatus: async (project, iid) => ({ project, iid, state: states[iid] === 'merged' ? 'merged' : 'opened', status: states[iid], title: `Change ${iid}`, sha, approved: false, approvalKnown: true, approvedBy: [], author: 'Alice Example', pipeline: { status: 'success', id: 4 }, autoMerge: false }),
  };
  const watcher = new MergeRequestWatcher({ config: { conversations: [], teams: { rich_messages: true }, gitlab: { notify: { ci: { enable: true, on_success: true } } } }, gitlab, jira: null, opsgenie: null });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-live-restart-'));
  watcher.stateFile = path.join(stateDir, 'watcher-state.json');
  watcher.prefetchAvatars = async () => {};
  watcher.setReactionStatus = async (entry, status) => { entry.status = status; };
  const entry = { conversationId: '19:example@thread.v2', messageId: '1700000000000', from: 'Alice Example', createdAt: Date.now(), mrs: items.map((mr) => ({ ...mr, status: null, ciMessageServerId: null })), jobs: [], pipelines: [] };
  watcher.watched.set('conversation/1700000000000', entry);
  try {
    await watcher.checkWatchedKey('conversation/1700000000000');
    assert.equal(sent.filter((call) => call.type === 'send').length, 1);
    assert.equal(entry.multiMrMessageServerId, '1700000000001');
    const restarted = new MergeRequestWatcher({ config: watcher.config, gitlab, jira: null, opsgenie: null });
    restarted.watched.clear();
    restarted.stateFile = watcher.stateFile;
    restarted.loadState();
    restarted.prefetchAvatars = async () => {};
    restarted.setReactionStatus = async (saved, status) => { saved.status = status; };
    assert.equal(restarted.watched.get('conversation/1700000000000').multiMrMessageServerId, '1700000000001');
    await restarted.checkWatchedKey('conversation/1700000000000');
    assert.equal(sent.filter((call) => call.type === 'send').length, 1, 'restart updates the existing card rather than posting another');
    assert.equal(sent.filter((call) => call.type === 'edit').length, 1);
    sent.pop();
    const first = JSON.stringify(sent[0].args);
    assert.match(first, /Change 1/);
    assert.match(first, /Change 2/);
    await watcher.checkWatchedKey('conversation/1700000000000');
    assert.equal(sent.length, 1, 'unchanged polls do not edit the card');
    states[1] = 'merged';
    await watcher.checkWatchedKey('conversation/1700000000000');
    assert.equal(sent.filter((call) => call.type === 'edit').length, 1);
    assert.match(JSON.stringify(sent.at(-1).args), /1\/2/);
  } finally { Object.assign(transport, original); setRichMessages(false); fs.rmSync(stateDir, { recursive: true, force: true }); }
});

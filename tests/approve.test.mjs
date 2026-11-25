import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import crypto from 'node:crypto';

import { ApproveServer, ApprovalStore, CsrfTokens, mergeBlockReason, normalizeLinkTtlSeconds } from '../src/approve.mjs';
import { buildMergeRequestCard } from '../src/cards.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';

const ORIGIN = 'https://approve.example.com';
const SHA = 'a'.repeat(40);
const PROJECT = 'group/app';
const IID = 7;

function makeGitlab(overrides = {}) {
  const calls = { approve: [], reopen: [], merge: [], getMr: 0, state: 0 };
  const gitlab = {
    calls,
    mr: { state: 'opened', draft: false, sha: SHA, title: 'Example change' },
    userState: { known: true, user: { id: 1, username: 'owner' }, hasApproved: false, canApprove: true },
    approveError: null,
    reopenError: null,
    mergeError: null,
    async getCurrentUser() {
      return { id: 1, username: 'owner' };
    },
    async reopenMr(project, iid) {
      calls.reopen.push({ project, iid });
      if (gitlab.reopenError) throw gitlab.reopenError;
      gitlab.mr = { ...gitlab.mr, state: 'opened' };
      return gitlab.mr;
    },
    async mergeMrOnce(project, iid, opts) {
      calls.merge.push({ project, iid, opts });
      if (gitlab.mergeError) throw gitlab.mergeError;
      gitlab.mr = { ...gitlab.mr, state: 'merged' };
      return gitlab.mr;
    },
    async getMr() {
      calls.getMr++;
      return gitlab.mr;
    },
    async getUserApprovalState() {
      calls.state++;
      return typeof gitlab.userState === 'function' ? gitlab.userState() : gitlab.userState;
    },
    async approveMr(project, iid, opts) {
      calls.approve.push({ project, iid, opts });
      if (gitlab.approveError) throw gitlab.approveError;
      return {};
    },
    ...overrides,
  };
  return gitlab;
}

async function setup({ gitlab = makeGitlab(), refreshCards, stateFile = null, now, linkTtlSeconds, action = 'approve', serverOpts = {} } = {}) {
  gitlab.host ||= 'gitlab.example.com';
  const originalFetch = globalThis.fetch;
  let approved = false;
  globalThis.fetch = async (url, options = {}) => {
    if (!String(url).startsWith(`https://${gitlab.host}/api/v4/`)) return originalFetch(url, options);
    const route = new URL(url).pathname;
    const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
    const state = async () => gitlab.getUserApprovalState();
    if (route.endsWith('/user')) return response((await state()).user || {});
    if (route.endsWith('/approvals')) {
      const value = await state();
      if (!value.known) return response({}, 503);
      return response({ approved_by: value.hasApproved || approved ? [{ user: { id: 1 } }] : [], user_can_approve: value.canApprove });
    }
    if (route.endsWith('/approve') && options.method === 'POST') {
      try {
        await gitlab.approveMr(PROJECT, String(IID), JSON.parse(options.body));
        approved = true;
        return response({});
      } catch (err) {
        const status = Number(/\((\d{3})\)/.exec(err.message)?.[1]) || 502;
        return response({}, status);
      }
    }
    return response(await gitlab.getMr());
  };
  const server = new ApproveServer({
    gitlab,
    baseUrl: `${ORIGIN}/approve`,
    port: 0,
    stateFile,
    refreshCards,
    now,
    linkTtlSeconds,
    mergeEnabled: true,
    mergePollMs: 0,
    mergePollAttempts: 3,
    sleep: async () => {},
    oauth: { clientId: 'example', clientSecret: 'example' },
    ...serverOpts,
  });
  await server.start();
  const stop = server.stop.bind(server);
  server.stop = async () => { try { await stop(); } finally { globalThis.fetch = originalFetch; } };
  const base = `http://127.0.0.1:${server.port}`;
  const { token, record } = server.store.linkFor({ project: PROJECT, iid: IID, sha: action === 'reopen' ? undefined : SHA, action });
  const form = (fields) => new URLSearchParams(fields).toString();
  const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const entry = () => fetch(`${base}/approve/`);
  const bootstrap = async (t = token, headers = {}) => {
    const response = await fetch(`${base}/approve/session`, { method: 'POST', headers: { ...FORM, Origin: ORIGIN, ...headers }, body: form({ token: t }) });
    const sid = /tl_approve=([^;]+)/.exec(response.headers.get('set-cookie') || '')?.[1];
    const session = sid && server.sessions.get(crypto.createHash('sha256').update(sid).digest('hex'));
    if (session) { session.user = { id: 1, username: 'owner', name: 'Owner' }; session.accessToken = 'test-oauth-token'; }
    return response;
  };
  const cookieOf = (res) => /tl_approve=[^;]+/.exec(res.headers.get('set-cookie') || '')?.[0] || null;
  const open = async (t = token) => cookieOf(await bootstrap(t));
  const page = (cookie) => fetch(`${base}/approve/confirm`, { headers: cookie ? { Cookie: cookie } : {} });
  const csrfFrom = async (res) => /name="csrf" value="([^"]+)"/.exec(await res.text())?.[1];
  // The page binds the shown account (id 1 of the stand-in, no credential index) into the form.
  const post = (cookie, fields, headers = {}) =>
    fetch(`${base}/approve/confirm`, {
      method: 'POST',
      headers: { ...FORM, Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: form({ user: '1', cred: action === 'approve' ? 'oauth' : '', ...fields }),
    });
  const confirm = async (headers = {}) => {
    const cookie = await open();
    return post(cookie, { csrf: await csrfFrom(await page(cookie)) }, headers);
  };
  return { server, gitlab, token, record, base, entry, bootstrap, cookieOf, open, page, csrfFrom, post, confirm };
}

// The merge request title is a click target (`selectAction`); these tests are about the buttons only.
const withoutTitleAction = (value) =>
  String(typeof value === 'string' ? value : JSON.stringify(value)).replaceAll('"selectAction":{"type":"Action.OpenUrl"', '');

test('constructor fails closed on a missing, insecure or non-loopback configuration', () => {
  const ok = { gitlab: makeGitlab(), baseUrl: `${ORIGIN}/approve` };
  assert.doesNotThrow(() => new ApproveServer(ok));
  assert.doesNotThrow(() => new ApproveServer({ ...ok, baseUrl: 'http://127.0.0.1:3006/approve' }), 'plain http only on loopback');
  assert.throws(() => new ApproveServer({ ...ok, baseUrl: '' }), /base_url/);
  assert.throws(() => new ApproveServer({ ...ok, baseUrl: 'http://approve.example.com/approve' }), /https/);
  assert.throws(() => new ApproveServer({ ...ok, baseUrl: `${ORIGIN}/approve#frag` }), /fragment/);
  assert.throws(() => new ApproveServer({ ...ok, host: '0.0.0.0' }), /loopback/);
  assert.throws(() => new ApproveServer({ gitlab: null, baseUrl: `${ORIGIN}/approve` }), /GitLab client/);
});

test('the link lifetime defaults to 24 hours and is hard bounded', () => {
  assert.equal(normalizeLinkTtlSeconds(undefined), 86400);
  assert.equal(normalizeLinkTtlSeconds('garbage'), 86400);
  assert.equal(normalizeLinkTtlSeconds(-5), 86400);
  assert.equal(normalizeLinkTtlSeconds(5), 60);
  assert.equal(normalizeLinkTtlSeconds(3600), 3600);
  assert.equal(normalizeLinkTtlSeconds(10 * 365 * 86400), 7 * 86400);
});

test('tokens are random 256-bit, only their hash is stored, and the link keeps the token in the fragment', () => {
  const store = new ApprovalStore();
  const a = store.linkFor({ project: PROJECT, iid: IID, sha: SHA });
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.record.id, crypto.createHash('sha256').update(a.token).digest('hex'));
  assert.equal(JSON.stringify([...store.records.values()]).includes(a.token), false);
  assert.equal(store.byToken(a.token).sha, SHA);
  assert.equal(store.byToken('A'.repeat(43)), null);
  assert.equal(store.byToken('short'), null);
  // The same open link is shown again (card refresh), case-insensitively per project.
  assert.equal(store.linkFor({ project: PROJECT.toUpperCase(), iid: IID, sha: SHA }).token, a.token);
  // A new head commit supersedes the old link.
  const b = store.linkFor({ project: PROJECT, iid: IID, sha: 'b'.repeat(40) });
  assert.notEqual(b.token, a.token);
  assert.equal(store.byId(a.record.id).status, 'stale');
  assert.equal(store.linkFor({ project: PROJECT, iid: IID, sha: null }), null);

  const server = new ApproveServer({ gitlab: makeGitlab(), baseUrl: `${ORIGIN}/approve` });
  const url = new URL(server.linkFor({ project: PROJECT, iid: IID, sha: SHA }));
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.pathname, '/approve/');
  assert.equal(url.search, '');
  assert.match(url.hash, /^#[A-Za-z0-9_-]{43}$/);
});

test('the entry page is static: no token needed, no GitLab call, hash-pinned script and hardening headers', async () => {
  const ctx = await setup();
  try {
    for (const method of ['GET', 'HEAD']) {
      const res = await fetch(`${ctx.base}/approve/`, { method });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('referrer-policy'), 'same-origin');
      const csp = res.headers.get('content-security-policy');
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /connect-src 'self'/);
      assert.doesNotMatch(csp, /unsafe-eval|https?:\/\/(?!approve\.example\.com)/);
      if (method === 'GET') {
        const html = await res.text();
        const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
        const hash = `sha256-${crypto.createHash('sha256').update(script).digest('base64')}`;
        assert.ok(csp.includes(`script-src '${hash}'`), 'the CSP pins exactly this script');
        assert.doesNotMatch(html, /src="(?!data:)/, 'no third-party or external resources (embedded pictures only)');
        assert.match(html, /href="https:\/\/github\.com\/pschmitt\/teams-live"[^>]*>.*teams-live on GitHub<\/a>/);
        assert.match(script, /history\.replaceState/, 'the fragment is cleared from the address bar');
        assert.match(script, /location\.hash/);
      }
    }
    assert.equal(ctx.gitlab.calls.getMr, 0);
    assert.equal(ctx.gitlab.calls.approve.length, 0);
    assert.equal((await fetch(`${ctx.base}/approve/${ctx.token}`)).status, 404, 'the token is not a path');
    assert.equal((await fetch(`${ctx.base}/elsewhere`)).status, 404);
  } finally {
    await ctx.server.stop();
  }
});

test('the bootstrap sets a hardened session cookie and neither approves nor consumes the link', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.bootstrap();
    assert.equal(res.status, 200);
    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /^tl_approve=[A-Za-z0-9_-]{43};/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /Path=\/approve/);
    assert.doesNotMatch(await res.text() + setCookie, new RegExp(ctx.token));
    assert.equal(ctx.gitlab.calls.getMr, 0, 'no GitLab call');
    assert.equal(ctx.gitlab.calls.approve.length, 0);
    assert.equal(ctx.server.store.byId(ctx.record.id).status, 'open', 'not consumed');
    // Any number of bootstraps (scanners) leave the link usable.
    for (let i = 0; i < 5; i++) assert.equal((await ctx.bootstrap()).status, 200);
    assert.equal(ctx.server.store.byId(ctx.record.id).status, 'open');
  } finally {
    await ctx.server.stop();
  }
});

test('the bootstrap checks origin, content type, token format and state', async () => {
  const ctx = await setup();
  try {
    assert.equal((await ctx.bootstrap(ctx.token, { Origin: 'https://evil.example.org' })).status, 403);
    const noOrigin = await fetch(`${ctx.base}/approve/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${ctx.token}`,
    });
    assert.equal(noOrigin.status, 403, 'neither Origin nor Referer');
    const json = await fetch(`${ctx.base}/approve/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: '{}',
    });
    assert.equal(json.status, 415);
    assert.equal((await ctx.bootstrap('A'.repeat(43))).status, 404, 'unknown');
    assert.equal((await ctx.bootstrap('nope')).status, 404, 'malformed');
    assert.equal((await fetch(`${ctx.base}/approve/session`)).status, 405, 'GET is not a bootstrap');
    ctx.server.store.setStatus(ctx.record.id, 'stale');
    assert.equal((await ctx.bootstrap()).status, 410, 'superseded');
    ctx.server.store.setStatus(ctx.record.id, 'approved');
    assert.equal((await ctx.bootstrap()).status, 410, 'used');
  } finally {
    await ctx.server.stop();
  }
});

test('repeated invalid tokens are throttled', async () => {
  const ctx = await setup();
  try {
    let last;
    for (let i = 0; i < 70; i++) last = await ctx.bootstrap(crypto.randomBytes(32).toString('base64url'));
    assert.equal(last.status, 429);
  } finally {
    await ctx.server.stop();
  }
});

test('the confirmation page needs a session, shows the account honestly and never mutates on GET or HEAD', async () => {
  const ctx = await setup();
  try {
    assert.equal((await ctx.page()).status, 401, 'no cookie');
    assert.equal((await ctx.page('tl_approve=garbage')).status, 401, 'bad cookie');
    assert.equal((await ctx.page(`tl_approve=${'A'.repeat(43)}`)).status, 401, 'unknown session');
    assert.equal(ctx.gitlab.calls.getMr, 0);

    const cookie = await ctx.open();
    const res = await ctx.page(cookie);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<form method="post" data-act action="https:\/\/approve\.example\.com\/approve\/confirm"/);
    assert.match(html, /signed-in GitLab user|your GitLab account/i);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    // The only script is the live-status one, allowed by its hash alone (never 'unsafe-inline' for scripts).
    assert.match(res.headers.get('content-security-policy'), /script-src 'sha256-[A-Za-z0-9+/=]+'; connect-src 'self'/);
    assert.doesNotMatch(res.headers.get('content-security-policy'), /script-src[^;]*unsafe/);
    const head = await fetch(`${ctx.base}/approve/confirm`, { method: 'HEAD', headers: { Cookie: cookie } });
    assert.equal(head.status, 200);
    assert.equal(ctx.gitlab.calls.approve.length, 0);
    assert.equal(ctx.server.store.byId(ctx.record.id).status, 'open');
  } finally {
    await ctx.server.stop();
  }
});

test('the pages are styled self-contained: state pills, tones, dark mode, no external resources, escaped text', async () => {
  const gitlab = makeGitlab();
  gitlab.mr = { state: 'opened', draft: false, sha: SHA, title: '<img src=x onerror=alert(1)> & "quoted"' };
  const ctx = await setup({ gitlab });
  try {
    const cookie = await ctx.open();
    const res = await ctx.page(cookie);
    const html = await res.text();
    assert.match(html, /<main class="panel tone-neutral">/);
    assert.match(html, /<span class="pill pill-open"><img class="ic" src="data:image\/png;base64,[^"]+" alt="" width="16" height="16">Open<\/span>/, 'the GitLab state icon, then the state');
    assert.match(html, /<button class="btn" type="submit" data-busy="Approving…">Approve merge request<\/button>/);
    assert.match(html, /prefers-color-scheme:dark/);
    assert.match(html, /<title>Approve merge request \u00b7 teams-live<\/title>/);
    assert.match(html, /<footer class="foot"><a href="https:\/\/github\.com\/pschmitt\/teams-live"/);
    // The merge request title is escaped, never markup.
    assert.equal(html.includes('<img src=x'), false, 'no markup from the title (the only images are the embedded icons)');
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;quoted&quot;/);
    // Nothing external: the only script is the live-status one (same origin, allowed by its hash), no src, link or import.
    assert.equal((html.match(/<script/g) || []).length, 1, 'one script');
    assert.match(html, /<script>\(function\(\)\{var U="\/approve\/state"/);
    // Pictures are embedded data URIs only (the CSP allows img-src data: and nothing else).
    assert.match(html, /<link rel="icon" type="image\/png" href="data:image\/png;base64,[A-Za-z0-9+/=]+">/, 'the favicon is embedded');
    assert.doesNotMatch(html.replace(/<script>[\s\S]*?<\/script>/, '').replace(/<img [^>]*src="data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+"[^>]*>/g, '').replace(/<link rel="icon" type="image\/png" href="data:image\/png;base64,[A-Za-z0-9+/=]+">/, ''), /<script|<[a-z][^>]*\ssrc=|<link|@import|url\(/);
    assert.deepEqual(html.match(/https?:\/\/[^\s"'<>)]+/g), ['https://gitlab.example.com/owner', 'https://approve.example.com/approve/confirm', 'https://github.com/pschmitt/teams-live']);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'; img-src data:;/);
    assert.match(csp, /script-src 'sha256-[A-Za-z0-9+/=]+'; connect-src 'self'/);

    // Drafts, closed and merged merge requests show their own pill (closed and merged burn the
    // link, so each case has its own); error pages carry a warning tone.
    for (const [mr, pill] of [[{ draft: true }, 'draft'], [{ state: 'closed' }, 'closed'], [{ state: 'merged' }, 'merged']]) {
      const g = makeGitlab();
      g.mr = { state: 'opened', draft: false, sha: SHA, title: 'T', ...mr };
      const other = await setup({ gitlab: g });
      try {
        const blocked = await (await other.page(await other.open())).text();
        assert.match(blocked, new RegExp(`class="pill pill-${pill}"`), pill);
        assert.match(blocked, /class="panel tone-warn"/);
      } finally {
        await other.server.stop();
      }
    }
    const nothing = await (await fetch(`${ctx.base}/approve/nope`)).text();
    assert.match(nothing, /<main class="panel tone-warn">/);
    assert.equal(ctx.gitlab.calls.approve.length, 0);
  } finally {
    await ctx.server.stop();
  }
});

test('the button keeps WCAG AA contrast (normal and hover) in light and dark mode', async () => {
  const ctx = await setup();
  try {
    const html = await (await ctx.page(await ctx.open())).text();
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
    const lum = (hex) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const contrast = (a, b) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const [light, dark] = css.split('@media (prefers-color-scheme:dark)');
    assert.ok(dark, 'dark-mode block present');
    const vars = (block) => Object.fromEntries([...block.matchAll(/--([a-z-]+):(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]));
    const lightVars = vars(light);
    const darkVars = { ...lightVars, ...vars(dark) };
    for (const [mode, v] of [['light', lightVars], ['dark', darkVars]]) {
      // The button text is white.
      assert.ok(contrast('#ffffff', v.btn) >= 4.5, `${mode} button ${contrast('#ffffff', v.btn).toFixed(2)}`);
      assert.ok(contrast('#ffffff', v['btn-h']) >= 4.5, `${mode} hover ${contrast('#ffffff', v['btn-h']).toFixed(2)}`);
    }
  } finally {
    await ctx.server.stop();
  }
});

test('a confirmed POST approves the displayed head as the user and refreshes the card', async () => {
  const refreshes = [];
  const ctx = await setup({
    refreshCards: async (project, iid) => {
      refreshes.push([project, iid]);
      return { matched: 1, completed: 1, failed: 0 };
    },
  });
  try {
    const res = await ctx.confirm();
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Approved in GitLab/);
    assert.match(html, /refresh was run/);
    assert.deepEqual(ctx.gitlab.calls.approve, [{ project: PROJECT, iid: String(IID), opts: { sha: SHA } }]);
    assert.deepEqual(refreshes, [[PROJECT, String(IID)]]);
    assert.equal(ctx.server.store.byId(ctx.record.id).status, 'open');

    // Other people can still use the link. The same user sees their approval.
    const again = await ctx.page(await ctx.open());
    assert.equal(again.status, 200);
    assert.match(await again.text(), /already approved/i);
    assert.equal(ctx.gitlab.calls.approve.length, 1);
  } finally {
    await ctx.server.stop();
  }
});

test('a session that already holds the page cannot replay the confirmation', async () => {
  const ctx = await setup();
  try {
    const cookie = await ctx.open();
    const csrf = await ctx.csrfFrom(await ctx.page(cookie));
    assert.equal((await ctx.post(cookie, { csrf })).status, 200);
    const replay = await ctx.post(cookie, { csrf });
    assert.equal(replay.status, 200);
    assert.match(await replay.text(), /already approved/i);
    assert.equal(ctx.gitlab.calls.approve.length, 1);
  } finally {
    await ctx.server.stop();
  }
});

test('concurrent POSTs approve exactly once', async () => {
  const gitlab = makeGitlab();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const approve = gitlab.approveMr;
  gitlab.approveMr = async (...args) => {
    await gate;
    return approve(...args);
  };
  const ctx = await setup({ gitlab });
  try {
    const cookie = await ctx.open();
    const csrf = await ctx.csrfFrom(await ctx.page(cookie));
    const first = ctx.post(cookie, { csrf });
    const second = ctx.post(cookie, { csrf });
    await new Promise((r) => setTimeout(r, 100));
    release();
    const statuses = (await Promise.all([first, second])).map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 200]);
    assert.equal(ctx.gitlab.calls.approve.length, 1);
  } finally {
    release();
    await ctx.server.stop();
  }
});

test('CSRF and origin checks reject a POST without approving', async () => {
  const ctx = await setup();
  try {
    const cookie = await ctx.open();
    const csrf = await ctx.csrfFrom(await ctx.page(cookie));
    assert.equal((await ctx.post(cookie, {})).status, 403, 'missing token');
    assert.equal((await ctx.post(cookie, { csrf: 'garbage' })).status, 403, 'bad token');
    assert.equal((await ctx.post(cookie, { csrf: `${csrf}x` })).status, 403, 'tampered token');
    assert.equal((await ctx.post(cookie, { csrf }, { Origin: 'https://evil.example.org' })).status, 403, 'foreign origin');
    assert.equal((await ctx.post(null, { csrf })).status, 401, 'no session');

    // A token of another session of the same link is not valid here.
    const other = await ctx.open();
    const otherCsrf = await ctx.csrfFrom(await ctx.page(other));
    assert.equal((await ctx.post(cookie, { csrf: otherCsrf })).status, 403, 'bound to the session');

    const noOrigin = await fetch(`${ctx.base}/approve/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ csrf }).toString(),
    });
    assert.equal(noOrigin.status, 403, 'neither Origin nor Referer');
    assert.equal(ctx.gitlab.calls.approve.length, 0);
    const referer = await ctx.post(cookie, { csrf }, { Origin: '', Referer: `${ORIGIN}/approve/confirm` });
    assert.equal(referer.status, 200, 'a matching Referer is an accepted fallback');
    assert.equal(ctx.gitlab.calls.approve.length, 1);
  } finally {
    await ctx.server.stop();
  }
});

test('a CSRF token is bound to the session, the link and its expiry', () => {
  let now = 1_000_000;
  const csrf = new CsrfTokens({ now: () => now, ttlMs: 1000 });
  const token = csrf.issue('session-1', 'id-1');
  assert.equal(csrf.verify(token, 'session-1', 'id-1'), true);
  assert.equal(csrf.verify(token, 'session-2', 'id-1'), false);
  assert.equal(csrf.verify(token, 'session-1', 'id-2'), false);
  assert.equal(new CsrfTokens().verify(token, 'session-1', 'id-1'), false, 'another process key');
  now += 1001;
  assert.equal(csrf.verify(token, 'session-1', 'id-1'), false, 'expired');
});

test('a CSRF token is bound to the identity it was issued for', () => {
  const csrf = new CsrfTokens();
  const token = csrf.issue('session-1', 'id-1', 'user=1;cred=0');
  assert.equal(csrf.verify(token, 'session-1', 'id-1', 'user=1;cred=0'), true);
  assert.equal(csrf.verify(token, 'session-1', 'id-1', 'user=2;cred=0'), false);
  assert.equal(csrf.verify(token, 'session-1', 'id-1', 'user=1;cred=1'), false);
  assert.equal(csrf.verify(token, 'session-1', 'id-1'), false, 'no identity');
});

for (const action of ['approve', 'reopen', 'merge']) {
  test(`${action}: a changed account between page and click is rejected, an unavailable one is never offered`, async () => {
    const swap = (gitlab, user) => {
      gitlab.getCurrentUser = async () => user;
      gitlab.userState = { known: true, user, hasApproved: false, canApprove: true };
    };
    const writesOf = (gitlab) => gitlab.calls.approve.length + gitlab.calls.reopen.length + gitlab.calls.merge.length;
    const gitlab = makeGitlab();
    if (action === 'reopen') gitlab.mr = { ...gitlab.mr, state: 'closed' };
    const ctx = await setup({ gitlab, action });
    try {
      // The page showed account 1; account 2 would act at click time.
      const cookie = await ctx.open();
      const html = await (await ctx.page(cookie)).text();
      assert.match(html, /name="user" value="1"/);
      const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
      swap(gitlab, { id: 2, username: 'other' });
      const res = await ctx.post(cookie, { csrf });
      assert.equal(res.status, 409);
      assert.match(await res.text(), /account changed/i);
      assert.equal(writesOf(gitlab), 0);
      // The account cannot be told: neither the page nor the click acts.
      swap(gitlab, null);
      const blocked = await ctx.page(await ctx.open());
      assert.equal(blocked.status, 409);
      assert.doesNotMatch(await blocked.text(), /<form/);
      const refused = await ctx.post(cookie, { csrf });
      assert.equal(refused.status, 409);
      assert.equal(writesOf(gitlab), 0);
    } finally {
      await ctx.server.stop?.();
    }
  });
}

test('wrong content type and oversized bodies are rejected', async () => {
  const ctx = await setup();
  try {
    const cookie = await ctx.open();
    const json = await fetch(`${ctx.base}/approve/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookie },
      body: '{}',
    });
    assert.equal(json.status, 415);
    const big = await fetch(`${ctx.base}/approve/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, Cookie: cookie },
      body: `csrf=${'a'.repeat(10_000)}`,
    }).catch(() => null);
    if (big) assert.equal(big.status, 413);
    assert.equal(ctx.gitlab.calls.approve.length, 0);
  } finally {
    await ctx.server.stop();
  }
});

test('a changed head commit is rejected and cannot be approved', async () => {
  const ctx = await setup();
  try {
    const cookie = await ctx.open();
    const csrf = await ctx.csrfFrom(await ctx.page(cookie));
    ctx.gitlab.mr = { ...ctx.gitlab.mr, sha: 'c'.repeat(40) };
    const res = await ctx.post(cookie, { csrf });
    assert.equal(res.status, 409);
    assert.match(await res.text(), /merge request changed/i);
    assert.equal(ctx.gitlab.calls.approve.length, 0);
    assert.equal(ctx.server.store.byId(ctx.record.id).status, 'open');
    assert.equal((await ctx.bootstrap()).status, 200);
  } finally {
    await ctx.server.stop();
  }
});

test('closed, merged and draft merge requests are not offered or approved', async () => {
  for (const [patch, pattern] of [
    [{ state: 'closed' }, /no longer open/],
    [{ state: 'merged' }, /no longer open/],
    [{ draft: true }, /draft/],
  ]) {
    const ctx = await setup();
    try {
      const cookie = await ctx.open();
      ctx.gitlab.mr = { ...ctx.gitlab.mr, ...patch };
      const page = await ctx.page(cookie);
      assert.equal(page.status, 409);
      assert.match(await page.text(), pattern);
      assert.equal(ctx.gitlab.calls.approve.length, 0);
      assert.equal(ctx.server.store.byId(ctx.record.id).status, 'open');
    } finally {
      await ctx.server.stop();
    }
  }
});

test('identity decides: already approved, unknown and not-allowed are refused without a request', async () => {
  const cases = [
    [{ known: true, user: { id: 1 }, hasApproved: true, canApprove: true }, 200, /already approved/i],
    [{ known: false, user: null, hasApproved: false, canApprove: null }, 409, /could not verify|account changed/i],
    [{ known: true, user: { id: 1 }, hasApproved: false, canApprove: false }, 409, /does not allow/],
  ];
  for (const [userState, status, pattern] of cases) {
    const gitlab = makeGitlab();
    gitlab.userState = userState;
    const ctx = await setup({ gitlab });
    try {
      const res = await ctx.page(await ctx.open());
      assert.equal(res.status, status);
      assert.match(await res.text(), pattern);
      assert.equal(gitlab.calls.approve.length, 0);
    } finally {
      await ctx.server.stop();
    }
  }
});

test('a pending merge status such as ci_must_pass does not block the approval', async () => {
  const ctx = await setup();
  try {
    ctx.gitlab.mr = { ...ctx.gitlab.mr, detailed_merge_status: 'ci_must_pass', merge_status: 'cannot_be_merged' };
    const res = await ctx.confirm();
    assert.equal(res.status, 200);
    assert.equal(ctx.gitlab.calls.approve.length, 1);
  } finally {
    await ctx.server.stop();
  }
});

test('GitLab errors are reported honestly without rendering GitLab text and do not burn the link', async () => {
  const gitlab = makeGitlab();
  gitlab.approveError = new Error('GitLab error (403): <script>secret-detail</script>');
  const ctx = await setup({ gitlab });
  try {
    const res = await ctx.confirm();
    assert.equal(res.status, 502);
    const html = await res.text();
    assert.match(html, /did not confirm|outcome unknown/i);
    assert.doesNotMatch(html, /secret-detail/);
    assert.equal(ctx.server.store.byId(ctx.record.id).status, 'open');
  } finally {
    await ctx.server.stop();
  }
});

test('an uncertain outcome checks the own approval and only a confirmed approval consumes the link', async () => {
  // The request fails after GitLab applied it: the recheck finds the approval.
  const gitlab = makeGitlab();
  gitlab.approveError = new Error('GitLab request failed (network)');
  gitlab.userState = () => ({ known: true, user: { id: 1 }, hasApproved: gitlab.calls.approve.length > 0, canApprove: true });
  let ctx = await setup({ gitlab });
  try {
    const res = await ctx.confirm();
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Approved in GitLab/);
    assert.equal(ctx.server.store.byId(ctx.record.id).status, 'open');
  } finally {
    await ctx.server.stop();
  }

  // The recheck finds nothing: say so; the link stays usable.
  const g2 = makeGitlab();
  g2.approveError = new Error('GitLab error (502): bad gateway');
  ctx = await setup({ gitlab: g2 });
  try {
    const res = await ctx.confirm();
    assert.equal(res.status, 502);
    assert.match(await res.text(), /did not confirm|outcome unknown/i);
    assert.equal(ctx.server.store.byId(ctx.record.id).status, 'open');
  } finally {
    await ctx.server.stop();
  }

  // The recheck itself is unavailable: the outcome is unknown; the link is not burned.
  const g3 = makeGitlab();
  g3.approveError = new Error('GitLab request failed (network)');
  g3.userState = () =>
    g3.calls.approve.length === 0 ? { known: true, user: { id: 1 }, hasApproved: false, canApprove: true } : { known: false };
  ctx = await setup({ gitlab: g3 });
  try {
    const res = await ctx.confirm();
    assert.equal(res.status, 502);
    assert.match(await res.text(), /did not confirm|outcome unknown/i);
    assert.equal(ctx.server.store.byId(ctx.record.id).status, 'open');
  } finally {
    await ctx.server.stop();
  }
});

test('a failing card refresh is reported without over-claiming', async () => {
  for (const [refreshCards, pattern] of [
    [async () => ({ matched: 1, completed: 0, failed: 1 }), /could not be refreshed yet/],
    [async () => ({ matched: 0, completed: 0, failed: 0 }), /No watched Teams card/],
    [async () => { throw new Error('boom'); }, /could not be refreshed yet/],
  ]) {
    const ctx = await setup({ refreshCards });
    try {
      const res = await ctx.confirm();
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /Approved in GitLab/);
      assert.match(html, pattern);
      assert.doesNotMatch(html, /card (was )?updated/i);
    } finally {
      await ctx.server.stop();
    }
  }
});

test('links and sessions expire; the default lifetime is 24 hours', async () => {
  let now = 1_000_000_000;
  const ctx = await setup({ now: () => now });
  try {
    assert.equal(ctx.record.expiresAt - ctx.record.createdAt, 24 * 3600 * 1000);
    const cookie = await ctx.open();
    assert.equal((await ctx.page(cookie)).status, 200);
    now += 16 * 60 * 1000;
    assert.equal((await ctx.page(cookie)).status, 401, 'the session expires after 15 minutes');
    assert.equal((await ctx.bootstrap()).status, 200, 'the link itself is still valid');
    now += 24 * 3600 * 1000;
    assert.equal((await ctx.bootstrap()).status, 404, 'the link expired');
  } finally {
    await ctx.server.stop();
  }

  const short = await setup({ linkTtlSeconds: 120, now: () => now });
  try {
    assert.equal(short.record.expiresAt - short.record.createdAt, 120_000);
    const cookie = await short.open();
    now += 121_000;
    assert.equal((await short.page(cookie)).status, 401, 'a session never outlives its link');
  } finally {
    await short.server.stop();
  }
});

test('records survive a restart as hashes only, expire and are bounded; nothing secret is stored or logged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-test-'));
  const file = path.join(dir, 'links.json');
  try {
    let now = 1_000_000;
    const first = new ApprovalStore({ file, ttlMs: 10_000, now: () => now });
    const { token, record } = first.linkFor({ project: PROJECT, iid: IID, sha: SHA });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw.includes(token), false, 'the token is not stored');
    assert.match(raw, new RegExp(record.id));

    const second = new ApprovalStore({ file, ttlMs: 10_000, now: () => now });
    second.load();
    assert.equal(second.byToken(token)?.sha, SHA, 'the link survives a restart');
    now += 10_001;
    assert.equal(second.byToken(token), null, 'expired');

    const capped = new ApprovalStore({ max: 3, now: () => ++now });
    for (let i = 0; i < 6; i++) capped.linkFor({ project: PROJECT, iid: i, sha: SHA });
    assert.equal(capped.records.size, 3);

    fs.writeFileSync(file, '{not json');
    const broken = new ApprovalStore({ file });
    assert.doesNotThrow(() => broken.load());

    // Records of the former path-id format are ignored.
    fs.writeFileSync(file, JSON.stringify({ version: 1, records: [{ id: 'A'.repeat(32), project: PROJECT, iid: '1', sha: SHA, createdAt: now, expiresAt: now + 1e9, status: 'open' }] }));
    const old = new ApprovalStore({ file, now: () => now });
    old.load();
    assert.equal(old.records.size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the token never reaches the logs', async () => {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  const gitlab = makeGitlab();
  gitlab.approveError = new Error('GitLab error (409): conflict');
  const ctx = await setup({ gitlab });
  try {
    await ctx.confirm();
    await ctx.bootstrap('A'.repeat(43));
    assert.ok(lines.length > 0);
    assert.equal(lines.some((l) => l.includes(ctx.token)), false);
  } finally {
    console.error = original;
    await ctx.server.stop();
  }
});

test('the merge request card has the Approve button only when a link is present', () => {
  const base = { state: 'open', iid: 7, project: PROJECT, title: 'Example', url: 'https://gitlab.example.com/x', approved: false };
  const card = (extra) => buildMergeRequestCard({ ...base, ...extra }).card ?? buildMergeRequestCard({ ...base, ...extra });
  const withLink = card({ approveUrl: `${ORIGIN}/approve/#${'A'.repeat(43)}` });
  const text = JSON.stringify(withLink);
  assert.match(text, /"type":"Action.OpenUrl"/);
  assert.equal(withLink.actions[0].title, '👍 Approve', 'the button reads exactly the thumbs-up and Approve');
  assert.doesNotMatch(text, /Approve…|Approve\.\.\.|\bApprove -|- Approve/);
  assert.doesNotMatch(withoutTitleAction(card({})), /Action\.OpenUrl/);
  assert.doesNotMatch(withoutTitleAction(card({ approveUrl: 'javascript:alert(1)' })), /Action\.OpenUrl/);
});

function watcherWith(teams, flow) {
  const watcher = new MergeRequestWatcher({
    config: { conversations: [], gitlab: { group: 'group', notify: { ci: { enable: true } } }, teams },
    gitlab: { mrLink: (p, i) => `https://gitlab.example.com/${p}/-/merge_requests/${i}`, findMrLinks: () => [] },
    jira: null,
    opsgenie: null,
  });
  watcher.saveState = () => {};
  watcher.setApproveFlow(flow);
  return watcher;
}

test('the watcher offers the button for live, undrafted merge requests with a known head', () => {
  const flow = new ApproveServer({ gitlab: makeGitlab(), baseUrl: `${ORIGIN}/approve` });
  const mr = { project: PROJECT, iid: IID, title: 'Example' };
  const details = { sha: SHA, draft: false, approved: false, title: 'Example' };
  // The title is a prefix of the "👍 Approved" approval fact, so look at the card's actions.
  const hasButton = (w, d, opts) => (w.buildMrCard(mr, d, opts).actions ?? []).some((a) => a.title === '👍 Approve');

  const rich = watcherWith({ rich_messages: true }, flow);
  assert.equal(hasButton(rich, details, { state: 'open' }), true);
  assert.equal(hasButton(rich, { ...details, sha: undefined }, { state: 'open' }), false, 'unknown head');
  assert.equal(hasButton(rich, { ...details, draft: true }, { state: 'open' }), false, 'draft');
  assert.equal(hasButton(rich, { ...details, approved: true }, { state: 'open' }), true, 'another user can approve');
  assert.equal(hasButton(rich, details, { state: 'merged' }), false, 'merged');
  assert.equal(hasButton(rich, details, { state: 'closed' }), false, 'closed');

  assert.equal(hasButton(watcherWith({ rich_messages: false }, flow), details, { state: 'open' }), false, 'rich mode off');
  assert.equal(hasButton(watcherWith({ rich_messages: true }, null), details, { state: 'open' }), false, 'flow disabled');
});

test('refreshMrCards re-checks every watched card of the merge request', async () => {
  const watcher = watcherWith({ rich_messages: true }, null);
  watcher.watched = new Map([
    ['a', { mrs: [{ project: PROJECT, iid: IID }] }],
    ['b', { mrs: [{ project: 'other/proj', iid: IID }] }],
    ['c', { mrs: [{ project: PROJECT, iid: IID }] }],
  ]);
  const checked = [];
  watcher.checkWatchedKey = async (key) => {
    checked.push(key);
    if (key === 'c') throw new Error('boom');
  };
  const result = await watcher.refreshMrCards(PROJECT, IID);
  assert.deepEqual(checked.sort(), ['a', 'c']);
  assert.deepEqual(result, { matched: 2, completed: 1, failed: 1 });
});

// --- review fixes ---

test('junk tokens cannot lock out a valid token: lookup first, the invalid counter only gates unknown tokens', async () => {
  const ctx = await setup();
  try {
    for (let i = 0; i < 65; i++) await ctx.bootstrap(crypto.randomBytes(32).toString('base64url'));
    assert.equal((await ctx.bootstrap(crypto.randomBytes(32).toString('base64url'))).status, 429, 'junk is throttled');
    assert.equal((await ctx.bootstrap()).status, 200, 'the valid token still works');
  } finally {
    await ctx.server.stop();
  }
});

test('a first approve attempt that landed followed by a 401/403 is recognised as approved', async () => {
  for (const status of [401, 403]) {
    const gitlab = makeGitlab();
    gitlab.approveError = new Error(`GitLab error (${status}): already approved`);
    gitlab.userState = () => ({ known: true, user: { id: 1 }, hasApproved: gitlab.calls.approve.length > 0, canApprove: true });
    const ctx = await setup({ gitlab });
    try {
      const res = await ctx.confirm();
      assert.equal(res.status, 200, String(status));
      assert.match(await res.text(), /Approved in GitLab/);
      assert.equal(ctx.server.store.byId(ctx.record.id).status, 'open');
    } finally {
      await ctx.server.stop();
    }
  }

  // A 401/403 with the recheck unavailable is an unknown outcome, not a definitive refusal.
  const g = makeGitlab();
  g.approveError = new Error('GitLab error (401): unauthorized');
  g.userState = () => (g.calls.approve.length === 0 ? { known: true, user: { id: 1 }, hasApproved: false, canApprove: true } : { known: false });
  const ctx = await setup({ gitlab: g });
  try {
    const res = await ctx.confirm();
    assert.equal(res.status, 502);
    assert.match(await res.text(), /did not confirm|outcome unknown/i);
    assert.equal(ctx.server.store.byId(ctx.record.id).status, 'open');
  } finally {
    await ctx.server.stop();
  }
});

test('approveMr does not retry a thrown fetch error; reads still do', async () => {
  const { GitLabClient } = await import('../src/gitlab.mjs');
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new TypeError('fetch failed', { cause: new Error('socket hang up') });
  };
  try {
    const client = new GitLabClient({ baseUrl: 'https://gitlab.example.com', token: 'test-token' });
    await assert.rejects(() => client.approveMr('group/app', 7, { sha: SHA }), /GitLab request failed/);
    assert.equal(calls, 1, 'a mutation is sent once');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a full store refuses to mint, never evicts open links and drops terminal records first', () => {
  let now = 1_000_000;
  const store = new ApprovalStore({ max: 3, now: () => ++now });
  const a = store.linkFor({ project: PROJECT, iid: 1, sha: SHA });
  const b = store.linkFor({ project: PROJECT, iid: 2, sha: SHA });
  const c = store.linkFor({ project: PROJECT, iid: 3, sha: SHA });
  assert.ok(a && b && c);
  assert.equal(store.linkFor({ project: PROJECT, iid: 4, sha: SHA }), null, 'refused when full');
  for (const x of [a, b, c]) assert.equal(store.byToken(x.token)?.status, 'open', 'advertised links survive');
  assert.equal(store.records.size, 3);

  // A consumed record makes room, and the open ones are still intact.
  store.markApproved(PROJECT, 1, SHA);
  const d = store.linkFor({ project: PROJECT, iid: 4, sha: SHA });
  assert.ok(d, 'room after a terminal record is dropped');
  assert.equal(store.records.size, 3);
  assert.equal(store.byToken(b.token)?.status, 'open');
  assert.equal(store.byToken(c.token)?.status, 'open');
});

test('linkFor persists only when something changed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-test-'));
  const file = path.join(dir, 'links.json');
  try {
    const store = new ApprovalStore({ file });
    store.linkFor({ project: PROJECT, iid: IID, sha: SHA });
    let writes = 0;
    const persist = store.persist.bind(store);
    store.persist = () => {
      writes++;
      persist();
    };
    for (let i = 0; i < 5; i++) store.linkFor({ project: PROJECT, iid: IID, sha: SHA });
    assert.equal(writes, 0, 'cached renders do not write');
    store.linkFor({ project: PROJECT, iid: IID, sha: 'b'.repeat(40) });
    assert.ok(writes > 0, 'a new head does');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no new link is minted for a head the account already approved, also after a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-test-'));
  const file = path.join(dir, 'links.json');
  try {
    const first = new ApprovalStore({ file });
    first.linkFor({ project: PROJECT, iid: IID, sha: SHA });
    first.markApproved(PROJECT, IID, SHA);
    assert.equal(first.linkFor({ project: PROJECT, iid: IID, sha: SHA }), null);
    const second = new ApprovalStore({ file });
    second.load();
    assert.equal(second.linkFor({ project: PROJECT, iid: IID, sha: SHA }), null, 'remembered across a restart');
    assert.ok(second.linkFor({ project: PROJECT, iid: IID, sha: 'c'.repeat(40) }), 'a new head gets a link again');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a link holds at most three sessions and cannot evict the sessions of other links; bootstraps are rate limited per link', async () => {
  const ctx = await setup();
  try {
    const other = ctx.server.store.linkFor({ project: PROJECT, iid: 99, sha: SHA });
    const otherCookie = await ctx.open(other.token);
    assert.ok(otherCookie);
    const cookies = [];
    for (let i = 0; i < 6; i++) cookies.push(await ctx.open());
    assert.equal((await ctx.page(cookies[5])).status, 200, 'newest session works');
    assert.equal((await ctx.page(cookies[0])).status !== 200, true, 'oldest own session was replaced');
    assert.equal((await ctx.page(otherCookie)).status, 200, 'the other link keeps its session');
    // 7 successes so far for this link; the rest of the minute allows 3 more, then 429.
    let last;
    for (let i = 0; i < 5; i++) last = await ctx.bootstrap();
    assert.equal(last.status, 429);
    assert.equal((await ctx.bootstrap(other.token)).status, 200, 'the limit is per link');
  } finally {
    await ctx.server.stop();
  }
});

test('confirmation reads are coalesced for a few seconds; the approving POST always evaluates fresh', async () => {
  let now = 5_000_000;
  const ctx = await setup({ now: () => now });
  try {
    const cookie = await ctx.open();
    for (let i = 0; i < 4; i++) assert.equal((await ctx.page(cookie)).status, 200);
    assert.ok(ctx.gitlab.calls.getMr >= 4, 'each GET checks the signed-in user against GitLab');
    const csrf = await ctx.csrfFrom(await ctx.page(cookie));
    const before = ctx.gitlab.calls.getMr;
    const res = await ctx.post(cookie, { csrf });
    assert.equal(res.status, 200);
    assert.ok(ctx.gitlab.calls.getMr > before, 'the POST re-reads');
    assert.equal(ctx.gitlab.calls.approve.length, 1);
  } finally {
    await ctx.server.stop();
  }
});

test('a prior bot approval does not hide the user approval link', async () => {
  const ctx = await setup();
  try {
    ctx.server.store.markApproved(PROJECT, IID, SHA);
    const args = { project: PROJECT, iid: IID, sha: SHA };
    assert.match(ctx.server.linkFor(args) || '', /#[A-Za-z0-9_-]{43}$/);
    assert.equal(ctx.server.store.hasApprovedHead(PROJECT, IID, SHA), false);
  } finally {
    await ctx.server.stop();
  }
});

test('after a restart with a full store of open links nothing is evicted and the warning is rate limited', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-test-'));
  const file = path.join(dir, 'links.json');
  try {
    let now = 5_000_000;
    const first = new ApprovalStore({ file, max: 5, now: () => now });
    const tokens = [];
    for (let i = 1; i <= 5; i++) tokens.push(first.linkFor({ project: PROJECT, iid: i, sha: SHA }).token);

    const logs = [];
    const restarted = new ApprovalStore({ file, max: 5, now: () => now, logger: (m) => logs.push(m) });
    restarted.load();
    assert.equal(restarted.records.size, 5);
    // the restart lost the raw tokens: new MRs get no link, nobody is evicted
    for (let i = 6; i < 40; i++) assert.equal(restarted.linkFor({ project: PROJECT, iid: i, sha: SHA }), null);
    for (const t of tokens) assert.equal(restarted.byToken(t)?.status, 'open', 'advertised links stay valid');
    assert.equal(restarted.records.size, 5);
    assert.equal(logs.length, 1, 'one warning for 34 refusals');
    assert.equal(logs.join('').includes(tokens[0]), false);

    now += 11 * 60 * 1000;
    assert.equal(restarted.linkFor({ project: PROJECT, iid: 99, sha: SHA }), null);
    assert.equal(logs.length, 2, 'warns again after the interval');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Reopen (closed, not merged merge requests). All GitLab calls are mocked. ---

const closedGitlab = (overrides = {}) => {
  const gitlab = makeGitlab(overrides);
  gitlab.mr = { state: 'closed', title: 'Example change' };
  return gitlab;
};

test('reopen links need no head commit, are independent of approval links and are used up by a reopen', () => {
  const store = new ApprovalStore();
  assert.equal(store.linkFor({ project: PROJECT, iid: IID, sha: null }), null, 'an approval still needs a head');
  assert.equal(store.linkFor({ project: PROJECT, iid: IID, action: 'bogus' }), null);
  const approve = store.linkFor({ project: PROJECT, iid: IID, sha: SHA });
  const reopen = store.linkFor({ project: PROJECT, iid: IID, action: 'reopen' });
  assert.equal(reopen.record.action, 'reopen');
  assert.equal(approve.record.action, 'approve');
  assert.notEqual(reopen.token, approve.token);
  assert.equal(store.linkFor({ project: PROJECT.toUpperCase(), iid: IID, action: 'reopen' }).token, reopen.token, 'reused');

  // A new head supersedes approvals only; an approval leaves the reopen link alone.
  store.linkFor({ project: PROJECT, iid: IID, sha: 'b'.repeat(40) });
  assert.equal(store.byId(approve.record.id).status, 'stale');
  assert.equal(store.byId(reopen.record.id).status, 'open');
  store.markApproved(PROJECT, IID, 'b'.repeat(40));
  assert.equal(store.byId(reopen.record.id).status, 'open');
  store.invalidate(PROJECT, IID);
  assert.equal(store.byId(reopen.record.id).status, 'open', 'invalidating approvals keeps reopen links');

  store.markReopened(PROJECT, IID);
  assert.equal(store.byId(reopen.record.id).status, 'used');
  // Closed again later: a fresh link is minted (nothing remembers the reopen).
  const again = store.linkFor({ project: PROJECT, iid: IID, action: 'reopen' });
  assert.notEqual(again.token, reopen.token);
  assert.equal(again.record.status, 'open');
});

test('the action and the used status survive a restart; old records count as approvals', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-reopen-'));
  const file = path.join(dir, 'approve.json');
  try {
    const store = new ApprovalStore({ file });
    const reopen = store.linkFor({ project: PROJECT, iid: IID, action: 'reopen' });
    const used = store.linkFor({ project: PROJECT, iid: 8, action: 'reopen' });
    store.markReopened(PROJECT, 8);
    const loaded = new ApprovalStore({ file });
    loaded.load();
    assert.equal(loaded.byId(reopen.record.id).action, 'reopen');
    assert.equal(loaded.byId(used.record.id).status, 'used');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete raw.records[0].action;
    fs.writeFileSync(file, JSON.stringify(raw));
    const legacy = new ApprovalStore({ file });
    legacy.load();
    assert.equal(legacy.byId(reopen.record.id).action, 'approve');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a confirmed POST reopens a closed merge request once, uses the link up and refreshes the card', async () => {
  const refreshes = [];
  const ctx = await setup({
    gitlab: closedGitlab(),
    action: 'reopen',
    refreshCards: async (project, iid) => {
      refreshes.push([project, iid]);
      return { matched: 1, completed: 1, failed: 0 };
    },
  });
  try {
    // The entry page is generic, the confirmation page says what will happen.
    const entry = await (await ctx.entry()).text();
    assert.match(entry, /<h1>Opening link<\/h1>/);
    assert.doesNotMatch(entry, /GitLab approval|Approve merge request/);
    const cookie = await ctx.open();
    const res = await ctx.page(cookie);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<title>Reopen merge request · teams-live<\/title>/);
    assert.match(html, /<button class="btn" type="submit" data-busy="Reopening…">Reopen merge request<\/button>/);
    assert.match(html, /Reopen this merge request\?/);
    assert.match(html, /pill-closed/);
    assert.match(html, /not as you personally/);
    assert.doesNotMatch(html, /Head commit|approval|Approve/);
    assert.equal(ctx.gitlab.calls.reopen.length, 0, 'GET never reopens');

    const posted = await ctx.post(cookie, { csrf: await ctx.csrfFrom(await ctx.page(cookie)) });
    assert.equal(posted.status, 200);
    const done = await posted.text();
    assert.match(done, /Reopened in GitLab/);
    assert.match(done, /refresh was run/);
    assert.deepEqual(ctx.gitlab.calls.reopen, [{ project: PROJECT, iid: String(IID) }]);
    assert.deepEqual(ctx.gitlab.calls.approve, []);
    assert.deepEqual(refreshes, [[PROJECT, String(IID)]]);
    assert.equal(ctx.server.store.byId(ctx.record.id).status, 'used');

    assert.equal((await ctx.bootstrap()).status, 410);
    const replay = await ctx.page(cookie);
    assert.equal(replay.status, 410);
    assert.match(await replay.text(), /already used to reopen/);
    assert.equal(ctx.gitlab.calls.reopen.length, 1);
  } finally {
    await ctx.server.stop();
  }
});

test('reopen checks CSRF and origin like the approval and does not reopen without them', async () => {
  const ctx = await setup({ gitlab: closedGitlab(), action: 'reopen' });
  try {
    const cookie = await ctx.open();
    const csrf = await ctx.csrfFrom(await ctx.page(cookie));
    assert.equal((await ctx.post(cookie, { csrf }, { Origin: 'https://evil.example.com' })).status, 403);
    const noCsrf = await ctx.post(cookie, { csrf: 'x' });
    assert.equal(noCsrf.status, 403);
    assert.match(await noCsrf.text(), /Nothing was reopened/);
    assert.equal((await ctx.post(null, { csrf })).status, 401);
    assert.equal(ctx.gitlab.calls.reopen.length, 0);
    assert.equal(ctx.server.store.byId(ctx.record.id).status, 'open');
  } finally {
    await ctx.server.stop();
  }
});

test('only a closed merge request can be reopened: open is reported as such, merged is refused', async () => {
  // Either way the link is superseded on sight (a GET changes nothing in GitLab).
  for (const [state, status, pattern] of [
    ['opened', 200, /already open/],
    ['merged', 409, /merged and cannot be reopened/],
  ]) {
    const gitlab = closedGitlab();
    gitlab.mr = { ...gitlab.mr, state };
    const ctx = await setup({ gitlab, action: 'reopen' });
    try {
      const cookie = await ctx.open();
      const page = await ctx.page(cookie);
      assert.equal(page.status, status);
      assert.match(await page.text(), pattern);
      assert.doesNotMatch(await (await ctx.page(cookie)).text(), /<button/);
      assert.equal(gitlab.calls.reopen.length, 0);
      assert.equal(ctx.server.store.byId(ctx.record.id).status, 'stale');
    } finally {
      await ctx.server.stop();
    }
  }

  // The state changes between the page and the click: the POST evaluates fresh.
  const gitlab = closedGitlab();
  const ctx = await setup({ gitlab, action: 'reopen' });
  try {
    const cookie = await ctx.open();
    const csrf = await ctx.csrfFrom(await ctx.page(cookie));
    gitlab.mr = { ...gitlab.mr, state: 'merged' };
    const res = await ctx.post(cookie, { csrf });
    assert.equal(res.status, 409);
    assert.match(await res.text(), /merged/);
    assert.equal(gitlab.calls.reopen.length, 0);
    assert.equal(ctx.server.store.byId(ctx.record.id).status, 'stale');
  } finally {
    await ctx.server.stop();
  }

  // Somebody else reopened it first: nothing is sent, the link is used up.
  const g2 = closedGitlab();
  const c2 = await setup({ gitlab: g2, action: 'reopen' });
  try {
    const cookie = await c2.open();
    const csrf = await c2.csrfFrom(await c2.page(cookie));
    g2.mr = { ...g2.mr, state: 'opened' };
    const res = await c2.post(cookie, { csrf });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /already open in GitLab\. Nothing was sent/);
    assert.equal(g2.calls.reopen.length, 0);
    assert.equal(c2.server.store.byId(c2.record.id).status, 'stale');
  } finally {
    await c2.server.stop();
  }
});

test('a GitLab read failure blocks the reopen page without leaking GitLab text', async () => {
  const gitlab = closedGitlab({
    async getMr() {
      throw new Error('GitLab error (500): <script>alert(1)</script>');
    },
  });
  const ctx = await setup({ gitlab, action: 'reopen' });
  try {
    const page = await ctx.page(await ctx.open());
    assert.equal(page.status, 409);
    const html = await page.text();
    assert.match(html, /could not be reached/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.equal(gitlab.calls.reopen.length, 0);
  } finally {
    await ctx.server.stop();
  }
});

test('reopen failures are reported honestly and only a confirmed reopen consumes the link', async () => {
  const run = async (error, mrAfter) => {
    const gitlab = closedGitlab();
    gitlab.reopenError = error;
    const ctx = await setup({ gitlab, action: 'reopen' });
    try {
      const reopened = gitlab.reopenMr;
      gitlab.reopenMr = async (...args) => {
        try {
          return await reopened(...args);
        } finally {
          if (mrAfter) gitlab.mr = { ...gitlab.mr, state: mrAfter };
        }
      };
      const res = await ctx.confirm();
      return { status: res.status, html: await res.text(), link: ctx.server.store.byId(ctx.record.id).status };
    } finally {
      await ctx.server.stop();
    }
  };

  const refused = await run(new Error('GitLab error (403): Forbidden'));
  assert.equal(refused.status, 403);
  assert.match(refused.html, /Nothing was reopened/);
  assert.equal(refused.link, 'open');

  const missing = await run(new Error('GitLab error (404): Not found'));
  assert.equal(missing.status, 404);
  assert.equal(missing.link, 'open');

  const rejected = await run(new Error('GitLab error (409): Cannot reopen'));
  assert.equal(rejected.status, 409);
  assert.match(rejected.html, /HTTP 409/);
  assert.equal(rejected.link, 'open');

  // The answer is lost but GitLab applied it: the recheck finds it open.
  const landed = await run(new Error('GitLab request failed (network)'), 'opened');
  assert.equal(landed.status, 200);
  assert.match(landed.html, /Reopened in GitLab/);
  assert.equal(landed.link, 'used');

  // Not applied: still closed, so nothing is consumed.
  const notApplied = await run(new Error('GitLab error (502): bad gateway'));
  assert.equal(notApplied.status, 502);
  assert.match(notApplied.html, /still closed\. Nothing was reopened/);
  assert.equal(notApplied.link, 'open');
});

test('an unanswered reopen whose result cannot be checked is reported as unknown and not consumed', async () => {
  const gitlab = closedGitlab();
  gitlab.reopenError = new Error('GitLab request failed (network)');
  let reads = 0;
  gitlab.getMr = async () => {
    reads++;
    if (reads > 2) throw new Error('GitLab request failed (network)');
    return gitlab.mr;
  };
  const ctx = await setup({ gitlab, action: 'reopen' });
  try {
    const res = await ctx.confirm();
    assert.equal(res.status, 502);
    assert.match(await res.text(), /may or may not be open again/);
    assert.equal(ctx.server.store.byId(ctx.record.id).status, 'open');
  } finally {
    await ctx.server.stop();
  }
});

test('a reopen answer that does not say "opened" is read back and never counted as success', async () => {
  const run = async (answer, after) => {
    const gitlab = closedGitlab();
    gitlab.reopenMr = async (project, iid) => {
      gitlab.calls.reopen.push({ project, iid });
      gitlab.mr = { ...gitlab.mr, ...after };
      return answer;
    };
    const refreshes = [];
    const ctx = await setup({
      gitlab,
      action: 'reopen',
      refreshCards: async (...args) => {
        refreshes.push(args);
        return { edited: 1 };
      },
    });
    try {
      const readsBefore = gitlab.calls.getMr;
      const res = await ctx.confirm();
      return {
        status: res.status,
        html: await res.text(),
        link: ctx.server.store.byId(ctx.record.id).status,
        refreshes: refreshes.length,
        sends: gitlab.calls.reopen.length,
        readsAfterConfirm: gitlab.calls.getMr - readsBefore,
      };
    } finally {
      await ctx.server.stop();
    }
  };

  // The body says opened: no extra read is needed to accept it.
  const ok = await run({ state: 'opened' }, { state: 'opened' });
  assert.equal(ok.status, 200);
  assert.equal(ok.link, 'used');
  assert.equal(ok.refreshes, 1);

  // The body says closed and the readback agrees: nothing used, nothing refreshed.
  const closed = await run({ state: 'closed' }, { state: 'closed' });
  assert.equal(closed.status, 502);
  assert.match(closed.html, /still closed\. Nothing was reopened/);
  assert.doesNotMatch(closed.html, /Reopened in GitLab/);
  assert.equal(closed.link, 'open');
  assert.equal(closed.refreshes, 0);
  assert.equal(closed.sends, 1, 'sent once, never resent');

  // Merged in the meantime: the link is retired, nothing refreshed.
  const merged = await run({ state: 'merged' }, { state: 'merged' });
  assert.equal(merged.status, 409);
  assert.match(merged.html, /merged and cannot be reopened/);
  assert.equal(merged.link, 'stale');
  assert.equal(merged.refreshes, 0);

  // A stale or odd body but the readback shows it open: confirmed, so it counts.
  const confirmed = await run({ state: 'closed' }, { state: 'opened' });
  assert.equal(confirmed.status, 200);
  assert.match(confirmed.html, /Reopened in GitLab/);
  assert.equal(confirmed.link, 'used');
  assert.equal(confirmed.refreshes, 1);

  // No usable body at all: read back too.
  for (const answer of [null, {}, 'ok']) {
    const odd = await run(answer, { state: 'closed' });
    assert.equal(odd.status, 502, JSON.stringify(answer));
    assert.equal(odd.link, 'open');
    assert.equal(odd.refreshes, 0);
  }

  // An unexpected state is not success either.
  const weird = await run({ state: 'locked' }, { state: 'locked' });
  assert.equal(weird.status, 502);
  assert.match(weird.html, /unexpected state/);
  assert.equal(weird.link, 'open');
  assert.equal(weird.refreshes, 0);
});

test('a reopen answer that is not "opened" and cannot be read back is reported as unknown', async () => {
  const gitlab = closedGitlab();
  gitlab.reopenMr = async () => ({ state: 'closed' });
  let reads = 0;
  gitlab.getMr = async () => {
    reads++;
    if (reads > 2) throw new Error('GitLab request failed (network)');
    return gitlab.mr;
  };
  const refreshes = [];
  const ctx = await setup({ gitlab, action: 'reopen', refreshCards: async (...a) => refreshes.push(a) });
  try {
    const res = await ctx.confirm();
    assert.equal(res.status, 502);
    assert.match(await res.text(), /may or may not be open again/);
    assert.equal(ctx.server.store.byId(ctx.record.id).status, 'open');
    assert.equal(refreshes.length, 0);
  } finally {
    await ctx.server.stop();
  }
});

test('writes are sent exactly once on a thrown fetch error, while reads keep their retry', async () => {
  const { GitLabClient } = await import('../src/gitlab.mjs');
  const realFetch = globalThis.fetch;
  const realTimeout = globalThis.setTimeout;
  let calls = 0;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    calls++;
    bodies.push(init?.body);
    throw new TypeError('fetch failed', { cause: new Error('socket hang up') });
  };
  // The retry path waits one second; do not make the test wait for it.
  globalThis.setTimeout = (fn, _ms, ...args) => realTimeout(fn, 0, ...args);
  try {
    const client = new GitLabClient({ baseUrl: 'https://gitlab.example.com', token: 'test-token' });
    await assert.rejects(() => client.reopenMr('group/app', 7), /GitLab request failed/);
    assert.equal(calls, 1, 'reopen is sent once');
    assert.equal(bodies[0], JSON.stringify({ state_event: 'reopen' }));

    // No write is repeated after an ambiguous failure, whoever the caller is.
    calls = 0;
    await assert.rejects(() => client.closeMr('group/app', 7), /GitLab request failed/);
    assert.equal(calls, 1, 'close is sent once as well');

    calls = 0;
    await assert.rejects(() => client.getMr('group/app', 7), /GitLab request failed/);
    assert.equal(calls, 2, 'reads keep their retry');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realTimeout;
  }
});

test('the card has the Reopen button only for a closed merge request with a link', () => {
  const base = { iid: 7, project: PROJECT, title: 'Example', url: 'https://gitlab.example.com/x', approved: false };
  const card = (extra) => {
    const built = buildMergeRequestCard({ ...base, ...extra });
    return JSON.stringify(built.card ?? built);
  };
  const reopenUrl = `${ORIGIN}/approve/#${'A'.repeat(43)}`;
  const closed = card({ state: 'closed', reopenUrl });
  assert.match(closed, /"type":"Action.OpenUrl"/);
  assert.match(closed, /"title":"🔄 Reopen"/);
  assert.ok(closed.includes(reopenUrl));
  assert.doesNotMatch(closed, /Approve/);
  assert.doesNotMatch(withoutTitleAction(card({ state: 'closed' })), /Action\.OpenUrl/);
  assert.doesNotMatch(withoutTitleAction(card({ state: 'closed', reopenUrl: 'javascript:alert(1)' })), /Action\.OpenUrl/);
  for (const state of ['merged', 'open', 'rebase', 'rebased']) {
    assert.doesNotMatch(card({ state, reopenUrl }), /Reopen/, state);
  }
  // An approve link never shows on a closed card.
  assert.doesNotMatch(withoutTitleAction(card({ state: 'closed', approveUrl: reopenUrl })), /Action\.OpenUrl/);
});

test('the watcher offers Reopen only on closed cards with the flow enabled in rich mode', () => {
  const flow = new ApproveServer({ gitlab: makeGitlab(), baseUrl: `${ORIGIN}/approve` });
  const mr = { project: PROJECT, iid: IID, title: 'Example' };
  const details = { sha: SHA, draft: false, title: 'Example' };
  const text = (w, opts) => JSON.stringify(w.buildMrCard(mr, details, opts));
  const rich = watcherWith({ rich_messages: true }, flow);

  const closed = text(rich, { state: 'closed' });
  assert.match(closed, /🔄 Reopen/);
  assert.doesNotMatch(closed, /"title":"👍 Approve"/);
  for (const state of ['merged', 'open', 'rebase', 'rebased']) {
    assert.doesNotMatch(text(rich, { state }), /Reopen/, state);
  }
  assert.doesNotMatch(text(watcherWith({ rich_messages: false }, flow), { state: 'closed' }), /Reopen/, 'rich mode off');
  assert.doesNotMatch(text(watcherWith({ rich_messages: true }, null), { state: 'closed' }), /Reopen/, 'flow disabled');

  // The same link is shown again on a refresh and carries a reopen record.
  const url = (w) => /https:\/\/approve\.example\.com\/approve\/#[A-Za-z0-9_-]{43}/.exec(text(w, { state: 'closed' }))?.[0];
  assert.equal(url(rich), url(rich));
  assert.equal([...flow.store.records.values()].filter((r) => r.action === 'reopen').length, 1);
});

// ---------------------------------------------------------------------------
// Merge action. Generic mocks only: nothing here talks to a real GitLab.
// ---------------------------------------------------------------------------

const mergeableGitlab = (overrides = {}) => {
  const gitlab = makeGitlab(overrides);
  gitlab.mr = { state: 'opened', draft: false, sha: SHA, title: 'Example change', detailed_merge_status: 'mergeable' };
  return gitlab;
};

test('merge links are pinned to the head commit, independent of approve/reopen links and used up by a merge', () => {
  const store = new ApprovalStore();
  assert.equal(store.linkFor({ project: PROJECT, iid: IID, sha: null, action: 'merge' }), null, 'a merge needs a head');
  const approve = store.linkFor({ project: PROJECT, iid: IID, sha: SHA });
  const merge = store.linkFor({ project: PROJECT, iid: IID, sha: SHA, action: 'merge' });
  assert.equal(merge.record.action, 'merge');
  assert.notEqual(merge.token, approve.token);
  assert.equal(store.linkFor({ project: PROJECT.toUpperCase(), iid: IID, sha: SHA, action: 'merge' }).token, merge.token, 'reused');
  assert.equal(store.byId(approve.record.id).status, 'open', 'minting a merge link leaves the approval alone');

  // An approval does not use up the merge link and suppresses nothing about it.
  store.markApproved(PROJECT, IID, SHA);
  assert.equal(store.byId(merge.record.id).status, 'open');
  assert.equal(store.linkFor({ project: PROJECT, iid: IID, sha: SHA, action: 'merge' }).token, merge.token);

  // A new head supersedes the merge link (and the approval).
  const next = store.linkFor({ project: PROJECT, iid: IID, sha: 'b'.repeat(40), action: 'merge' });
  assert.notEqual(next.token, merge.token);
  assert.equal(store.byId(merge.record.id).status, 'stale');
  assert.equal(next.record.status, 'open');
  assert.equal(store.byId(approve.record.id).status !== 'used', true);

  store.invalidate(PROJECT, IID);
  assert.equal(store.byId(next.record.id).status, 'open', 'invalidating approvals keeps merge links');
  store.invalidate(PROJECT, IID, 'merge');
  assert.equal(store.byId(next.record.id).status, 'stale');

  const fresh = store.linkFor({ project: PROJECT, iid: IID, sha: 'c'.repeat(40), action: 'merge' });
  store.markMerged(PROJECT, IID);
  assert.equal(store.byId(fresh.record.id).status, 'used');
  assert.notEqual(store.linkFor({ project: PROJECT, iid: IID, sha: 'c'.repeat(40), action: 'merge' }).token, fresh.token, 'no memory of the merge');
});

test('the merge action and its used status survive a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-merge-'));
  const file = path.join(dir, 'approve.json');
  try {
    const store = new ApprovalStore({ file });
    const open = store.linkFor({ project: PROJECT, iid: IID, sha: SHA, action: 'merge' });
    const used = store.linkFor({ project: PROJECT, iid: 8, sha: SHA, action: 'merge' });
    store.markMerged(PROJECT, 8);
    const loaded = new ApprovalStore({ file });
    loaded.load();
    assert.equal(loaded.byId(open.record.id).action, 'merge');
    assert.equal(loaded.byId(open.record.id).sha, SHA);
    assert.equal(loaded.byId(used.record.id).status, 'used');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeBlockReason maps what GitLab says about mergeability and lets the PUT decide when it says nothing', () => {
  assert.equal(mergeBlockReason({ detailed_merge_status: 'mergeable' }), null);
  assert.match(mergeBlockReason({ detailed_merge_status: 'not_approved' }), /approvals/);
  assert.match(mergeBlockReason({ detailed_merge_status: 'ci_must_pass' }), /pipeline/);
  assert.match(mergeBlockReason({ detailed_merge_status: 'ci_still_running' }), /running/);
  assert.match(mergeBlockReason({ detailed_merge_status: 'need_rebase' }), /rebase/);
  assert.match(mergeBlockReason({ detailed_merge_status: 'conflict' }), /conflicts/);
  assert.match(mergeBlockReason({ detailed_merge_status: 'checking' }), /Reload/);
  assert.match(mergeBlockReason({ detailed_merge_status: 'brand_new_status' }), /brand_new_status/, 'unknown statuses block too');
  assert.match(mergeBlockReason({ has_conflicts: true }), /conflicts/);
  assert.match(mergeBlockReason({ merge_status: 'cannot_be_merged' }), /not mergeable/);
  assert.equal(mergeBlockReason({}), null);
  assert.equal(mergeBlockReason(null), null);
});

test('a confirmed POST merges once, with only the head sha, uses the link up and refreshes the card', async () => {
  const refreshes = [];
  const ctx = await setup({
    gitlab: mergeableGitlab(),
    action: 'merge',
    refreshCards: async (project, iid) => {
      refreshes.push([project, iid]);
      return { matched: 1, completed: 1, failed: 0 };
    },
  });
  try {
    // The entry page is generic; the confirmation page says what will happen and with which account.
    const entry = await (await ctx.entry()).text();
    assert.match(entry, /<h1>Opening link<\/h1>/);
    assert.doesNotMatch(entry, /Merge merge request/);
    const cookie = await ctx.open();
    const res = await ctx.page(cookie);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<title>Merge merge request · teams-live<\/title>/);
    assert.match(html, /<button class="btn" type="submit" data-busy="Merging…">Merge merge request<\/button>/);
    assert.match(html, /Merge this merge request\?/);
    assert.match(html, /configured GitLab account <code>owner<\/code>, not as you personally/);
    assert.match(html, /not bypassed/);
    assert.match(html, new RegExp(SHA.slice(0, 12)));
    assert.equal(ctx.gitlab.calls.merge.length, 0, 'GET never merges');
    assert.equal(ctx.gitlab.calls.approve.length, 0);
    assert.equal(ctx.gitlab.calls.reopen.length, 0);

    const posted = await ctx.post(cookie, { csrf: await ctx.csrfFrom(await ctx.page(cookie)) });
    assert.equal(posted.status, 200);
    const done = await posted.text();
    assert.match(done, /Merged in GitLab/);
    assert.match(done, /refresh was run/);
    assert.deepEqual(ctx.gitlab.calls.merge, [{ project: PROJECT, iid: String(IID), opts: { sha: SHA } }]);
    assert.deepEqual(ctx.gitlab.calls.approve, []);
    assert.deepEqual(refreshes, [[PROJECT, String(IID)]]);
    assert.equal(ctx.server.store.byId(ctx.record.id).status, 'used');

    assert.equal((await ctx.bootstrap()).status, 410);
    const replay = await ctx.page(cookie);
    assert.equal(replay.status, 410);
    assert.match(await replay.text(), /already used to merge/);
    assert.equal(ctx.gitlab.calls.merge.length, 1, 'never merged twice');
  } finally {
    await ctx.server.stop();
  }
});

test('merge checks CSRF and origin like the approval and does not merge without them', async () => {
  const ctx = await setup({ gitlab: mergeableGitlab(), action: 'merge' });
  try {
    const cookie = await ctx.open();
    const csrf = await ctx.csrfFrom(await ctx.page(cookie));
    assert.equal((await ctx.post(cookie, { csrf }, { Origin: 'https://evil.example.com' })).status, 403);
    const noCsrf = await ctx.post(cookie, { csrf: 'x' });
    assert.equal(noCsrf.status, 403);
    assert.match(await noCsrf.text(), /Nothing was merged/);
    assert.equal((await ctx.post(null, { csrf })).status, 401);
    // A GET with a (form-like) query changes nothing either.
    assert.equal((await ctx.page(cookie)).status, 200);
    assert.equal(ctx.gitlab.calls.merge.length, 0);
    assert.equal(ctx.server.store.byId(ctx.record.id).status, 'open');
  } finally {
    await ctx.server.stop();
  }
});

test('the merge page blocks drafts, other states, moved heads and unmergeable states without a button or a PUT', async () => {
  const cases = [
    ['draft', { draft: true }, 409, /draft/, 'open'],
    ['draft status', { detailed_merge_status: 'draft_status' }, 409, /draft/, 'open'],
    ['not approved', { detailed_merge_status: 'not_approved' }, 409, /approvals/, 'open'],
    ['pipeline', { detailed_merge_status: 'ci_must_pass' }, 409, /pipeline/, 'open'],
    ['rebase needed', { detailed_merge_status: 'need_rebase' }, 409, /rebase/, 'open'],
    ['conflicts', { detailed_merge_status: 'conflict' }, 409, /conflicts/, 'open'],
    ['locked', { state: 'locked' }, 409, /merging this merge request right now/, 'open'],
    ['closed', { state: 'closed' }, 409, /closed/, 'stale'],
    ['new head', { sha: 'b'.repeat(40) }, 409, /changed after this card/, 'stale'],
    ['merged elsewhere at another head', { state: 'merged', sha: 'b'.repeat(40) }, 409, /not at the head commit/, 'stale'],
    ['no head', { sha: undefined }, 409, /head commit of the merge request is unknown/, 'open'],
  ];
  for (const [name, patch, status, pattern, link] of cases) {
    const gitlab = mergeableGitlab();
    gitlab.mr = { ...gitlab.mr, ...patch };
    const ctx = await setup({ gitlab, action: 'merge' });
    try {
      const cookie = await ctx.open();
      const page = await ctx.page(cookie);
      assert.equal(page.status, status, name);
      const html = await page.text();
      assert.match(html, pattern, name);
      assert.doesNotMatch(html, /<button/, name);
      const posted = await ctx.post(cookie, { csrf: 'x' });
      assert.equal(posted.status, 403, name);
      assert.equal(gitlab.calls.merge.length, 0, name);
      assert.equal(ctx.server.store.byId(ctx.record.id).status, link, name);
    } finally {
      await ctx.server.stop();
    }
  }
});

test('the POST re-evaluates fresh: a state change between page and click is not merged', async () => {
  for (const [name, patch, status, pattern] of [
    ['new commits', { sha: 'c'.repeat(40) }, 409, /changed after this card/],
    ['pipeline failed', { detailed_merge_status: 'ci_must_pass' }, 409, /pipeline/],
    ['became draft', { draft: true }, 409, /draft/],
    ['closed', { state: 'closed' }, 409, /closed/],
  ]) {
    const gitlab = mergeableGitlab();
    const ctx = await setup({ gitlab, action: 'merge' });
    try {
      const cookie = await ctx.open();
      const csrf = await ctx.csrfFrom(await ctx.page(cookie));
      gitlab.mr = { ...gitlab.mr, ...patch };
      const res = await ctx.post(cookie, { csrf });
      assert.equal(res.status, status, name);
      assert.match(await res.text(), pattern, name);
      assert.equal(gitlab.calls.merge.length, 0, name);
    } finally {
      await ctx.server.stop();
    }
  }
});

test('already merged at the expected head: nothing is sent and the link is used up', async () => {
  const gitlab = mergeableGitlab();
  const ctx = await setup({ gitlab, action: 'merge' });
  try {
    const cookie = await ctx.open();
    const csrf = await ctx.csrfFrom(await ctx.page(cookie));
    gitlab.mr = { ...gitlab.mr, state: 'merged' };
    const res = await ctx.post(cookie, { csrf });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /already merged in GitLab\. Nothing was sent/);
    assert.equal(gitlab.calls.merge.length, 0);
    assert.equal(ctx.server.store.byId(ctx.record.id).status, 'used');
  } finally {
    await ctx.server.stop();
  }
});

test('a GitLab read failure blocks the merge page without leaking GitLab text', async () => {
  const gitlab = mergeableGitlab({
    async getMr() {
      throw new Error('GitLab error (500): <script>alert(1)</script>');
    },
  });
  const ctx = await setup({ gitlab, action: 'merge' });
  try {
    const page = await ctx.page(await ctx.open());
    assert.equal(page.status, 409);
    const html = await page.text();
    assert.match(html, /could not be reached/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.equal(gitlab.calls.merge.length, 0);
  } finally {
    await ctx.server.stop();
  }
});

test('GitLab rejections of the merge are read back, never retried and never consume the link', async () => {
  const run = async (error, { after, unreadable } = {}) => {
    const gitlab = mergeableGitlab();
    gitlab.mergeError = error;
    if (after) {
      const send = gitlab.mergeMrOnce;
      gitlab.mergeMrOnce = async (...args) => {
        try {
          return await send(...args);
        } catch (err) {
          gitlab.mr = { ...gitlab.mr, ...after };
          throw err;
        }
      };
    }
    if (unreadable) {
      gitlab.getMr = async () => {
        if (gitlab.calls.merge.length > 0) throw new Error('GitLab request failed (network)');
        return gitlab.mr;
      };
    }
    const ctx = await setup({ gitlab, action: 'merge' });
    try {
      const res = await ctx.confirm();
      return { status: res.status, html: await res.text(), sends: gitlab.calls.merge.length, link: ctx.server.store.byId(ctx.record.id).status };
    } finally {
      await ctx.server.stop();
    }
  };
  for (const [code, status, pattern] of [
    [401, 403, /may not be allowed/],
    [403, 403, /may not be allowed/],
    [404, 404, /HTTP 404/],
    [405, 409, /HTTP 405/],
    [406, 409, /HTTP 406/],
    [409, 409, /HTTP 409/],
    [422, 409, /HTTP 422/],
  ]) {
    // The read shows the merge request still open: only then is "not merged" said.
    const r = await run(new Error(`GitLab error (${code}): rejected`));
    assert.equal(r.status, status, String(code));
    assert.match(r.html, pattern, String(code));
    assert.match(r.html, /still open in GitLab, so it was not merged/, String(code));
    assert.equal(r.sends, 1, `${code}: sent once`);
    assert.equal(r.link, 'open', `${code}: link kept`);
  }

  // A rejection whose readback says merged at our head (a double click, a merge that
  // landed another way) is a success and must not say "nothing was merged".
  const landed = await run(new Error('GitLab error (405): Method Not Allowed'), { after: { state: 'merged' } });
  assert.equal(landed.status, 200);
  assert.match(landed.html, /Merged in GitLab/);
  assert.doesNotMatch(landed.html, /not merged|Nothing was merged/);
  assert.equal(landed.link, 'used');
  assert.equal(landed.sends, 1);

  // Merged at another head: not ours, and not "nothing was merged" either.
  const other = await run(new Error('GitLab error (409): sha'), { after: { state: 'merged', sha: 'b'.repeat(40) } });
  assert.equal(other.status, 409);
  assert.match(other.html, /not at the head commit/);
  assert.doesNotMatch(other.html, /Nothing was merged/);

  // Being merged right now: no claim either way.
  const locked = await run(new Error('GitLab error (422): busy'), { after: { state: 'locked' } });
  assert.equal(locked.status, 502);
  assert.match(locked.html, /still merging/);
  assert.doesNotMatch(locked.html, /Nothing was merged|so it was not merged/);

  // Cannot be read back: unknown, never "nothing was merged".
  for (const code of [403, 404, 405, 409, 422]) {
    const unknown = await run(new Error(`GitLab error (${code}): rejected`), { unreadable: true });
    assert.equal(unknown.status, 502, String(code));
    assert.match(unknown.html, /may or may not be merged/, String(code));
    assert.match(unknown.html, new RegExp(`HTTP ${code}`), String(code));
    assert.doesNotMatch(unknown.html, /Nothing was merged|so it was not merged/, String(code));
    assert.equal(unknown.link, 'open');
    assert.equal(unknown.sends, 1);
  }
});

test('a lost or 5xx merge answer is read back: only a merge confirmed at the expected head counts', async () => {
  const run = async ({ error, after, reads }) => {
    const gitlab = mergeableGitlab();
    gitlab.mergeError = error;
    const send = gitlab.mergeMrOnce;
    gitlab.mergeMrOnce = async (...args) => {
      try {
        return await send(...args);
      } catch (err) {
        if (after) gitlab.mr = { ...gitlab.mr, ...after };
        throw err;
      }
    };
    if (reads) {
      const get = gitlab.getMr;
      let n = 0;
      gitlab.getMr = async (...a) => {
        n++;
        return reads(n, () => get(...a), gitlab);
      };
    }
    const refreshes = [];
    const ctx = await setup({
      gitlab,
      action: 'merge',
      refreshCards: async (...a) => {
        refreshes.push(a);
        return { edited: 1 };
      },
    });
    try {
      const res = await ctx.confirm();
      return { status: res.status, html: await res.text(), sends: gitlab.calls.merge.length, link: ctx.server.store.byId(ctx.record.id).status, refreshes: refreshes.length };
    } finally {
      await ctx.server.stop();
    }
  };
  const lost = new Error('GitLab request failed (network)');
  const bad = new Error('GitLab error (502): bad gateway');

  // The answer is lost but GitLab merged it at our head: confirmed.
  for (const error of [lost, bad]) {
    const landed = await run({ error, after: { state: 'merged' } });
    assert.equal(landed.status, 200);
    assert.match(landed.html, /Merged in GitLab/);
    assert.equal(landed.link, 'used');
    assert.equal(landed.refreshes, 1);
    assert.equal(landed.sends, 1, 'sent once');
  }

  // Not applied: still open. Nothing consumed, nothing refreshed, never resent.
  const open = await run({ error: lost });
  assert.equal(open.status, 502);
  assert.match(open.html, /still shows as open|still open/);
  assert.doesNotMatch(open.html, /Nothing was merged|so it was not merged/, 'an unclear outcome claims nothing');
  assert.match(open.html, /queued/);
  assert.doesNotMatch(open.html, /Merged in GitLab/);
  assert.equal(open.link, 'open');
  assert.equal(open.refreshes, 0);
  assert.equal(open.sends, 1);

  // Merged, but at another head: not ours, so no false success.
  const other = await run({ error: lost, after: { state: 'merged', sha: 'b'.repeat(40) } });
  assert.equal(other.status, 409);
  assert.match(other.html, /not at the head commit/);
  assert.equal(other.link, 'stale');
  assert.equal(other.refreshes, 0);

  // Still being merged (locked) after every read: no success.
  const locked = await run({ error: lost, after: { state: 'locked' } });
  assert.equal(locked.status, 502);
  assert.match(locked.html, /still merging/);
  assert.equal(locked.link, 'open');
  assert.equal(locked.refreshes, 0);

  // Locked first, merged a moment later: the poll sees it.
  const late = await run({
    error: lost,
    after: { state: 'locked' },
    reads: async (n, get, gitlab) => {
      if (n >= 4) gitlab.mr = { ...gitlab.mr, state: 'merged' };
      return get();
    },
  });
  assert.equal(late.status, 200);
  assert.equal(late.link, 'used');
  assert.equal(late.sends, 1);

  // Closed meanwhile.
  const closed = await run({ error: lost, after: { state: 'closed' } });
  assert.equal(closed.status, 409);
  assert.match(closed.html, /closed/);
  assert.equal(closed.refreshes, 0);

  // Unreadable: outcome unknown, link kept.
  const unknown = await run({
    error: lost,
    reads: async (n, get) => {
      if (n > 2) throw new Error('GitLab request failed (network)');
      return get();
    },
  });
  assert.equal(unknown.status, 502);
  assert.match(unknown.html, /may or may not be merged/);
  assert.equal(unknown.link, 'open');
  assert.equal(unknown.refreshes, 0);
  assert.equal(unknown.sends, 1);
});

test('a merge answer that is not "merged" at the expected head is read back and never counted as success', async () => {
  const run = async (answer, after) => {
    const gitlab = mergeableGitlab();
    gitlab.mergeMrOnce = async (project, iid, opts) => {
      gitlab.calls.merge.push({ project, iid, opts });
      gitlab.mr = { ...gitlab.mr, ...after };
      return answer;
    };
    const refreshes = [];
    const ctx = await setup({
      gitlab,
      action: 'merge',
      refreshCards: async (...a) => {
        refreshes.push(a);
        return { edited: 1 };
      },
    });
    try {
      const res = await ctx.confirm();
      return { status: res.status, html: await res.text(), link: ctx.server.store.byId(ctx.record.id).status, refreshes: refreshes.length, sends: gitlab.calls.merge.length };
    } finally {
      await ctx.server.stop();
    }
  };

  // Body says merged at our head: accepted.
  const ok = await run({ state: 'merged', sha: SHA }, { state: 'merged' });
  assert.equal(ok.status, 200);
  assert.equal(ok.link, 'used');
  assert.equal(ok.refreshes, 1);

  // Body says merged but names another head and the readback does not confirm: no success.
  const wrongHead = await run({ state: 'merged', sha: 'b'.repeat(40) }, { state: 'opened' });
  assert.equal(wrongHead.status, 502);
  assert.equal(wrongHead.link, 'open');
  assert.equal(wrongHead.refreshes, 0);

  // Odd or empty bodies are read back (still open): no success, sent once.
  for (const answer of [null, {}, 'ok', { state: 'opened' }, { state: 'locked' }]) {
    const odd = await run(answer, { state: 'opened' });
    assert.equal(odd.status, 502, JSON.stringify(answer));
    assert.equal(odd.link, 'open', JSON.stringify(answer));
    assert.equal(odd.refreshes, 0, JSON.stringify(answer));
    assert.equal(odd.sends, 1, JSON.stringify(answer));
  }

  // An odd body but the readback confirms the merge at our head: counts.
  const confirmed = await run({}, { state: 'merged' });
  assert.equal(confirmed.status, 200);
  assert.match(confirmed.html, /Merged in GitLab/);
  assert.equal(confirmed.link, 'used');
  assert.equal(confirmed.sends, 1);

  // An unexpected state is not success either.
  const weird = await run({}, { state: 'weird' });
  assert.equal(weird.status, 502);
  assert.match(weird.html, /unexpected state/);
  assert.equal(weird.link, 'open');
});

test('concurrent confirmed POSTs on one merge link send a single merge', async () => {
  const gitlab = mergeableGitlab();
  const send = gitlab.mergeMrOnce;
  gitlab.mergeMrOnce = async (...args) => {
    await new Promise((r) => setTimeout(r, 30));
    return send(...args);
  };
  const ctx = await setup({ gitlab, action: 'merge' });
  try {
    const cookie = await ctx.open();
    const csrf = await ctx.csrfFrom(await ctx.page(cookie));
    const results = await Promise.all([ctx.post(cookie, { csrf }), ctx.post(cookie, { csrf }), ctx.post(cookie, { csrf })]);
    assert.equal(gitlab.calls.merge.length, 1);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 410, 410]);
  } finally {
    await ctx.server.stop();
  }
});

test('mergeMrOnce sends one PUT with only the sha and never resends on a thrown fetch error', async () => {
  const { GitLabClient } = await import('../src/gitlab.mjs');
  const realFetch = globalThis.fetch;
  const realTimeout = globalThis.setTimeout;
  let calls = 0;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    calls++;
    seen.push({ url: String(url), method: init?.method, body: init?.body });
    throw new TypeError('fetch failed', { cause: new Error('socket hang up') });
  };
  globalThis.setTimeout = (fn, _ms, ...args) => realTimeout(fn, 0, ...args);
  try {
    const client = new GitLabClient({ baseUrl: 'https://gitlab.example.com', token: 'test-token' });
    await assert.rejects(() => client.mergeMrOnce('group/app', 7, { sha: SHA }), /GitLab request failed/);
    assert.equal(calls, 1, 'merge is sent once');
    assert.equal(seen[0].method, 'PUT');
    assert.match(seen[0].url, /\/projects\/group%2Fapp\/merge_requests\/7\/merge$/);
    assert.equal(seen[0].body, JSON.stringify({ sha: SHA }));
    await assert.rejects(() => client.mergeMrOnce('group/app', 7, {}), /sha/i, 'a head is mandatory');
    await assert.rejects(() => client.mergeMrOnce('group/app', 7), /sha/i);
    assert.equal(calls, 1, 'nothing is sent without a head');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realTimeout;
  }
});

test('the card has the Merge button only for a live, non-draft merge request with a link', () => {
  const base = { iid: 7, project: PROJECT, title: 'Example', url: 'https://gitlab.example.com/x', approved: false };
  const card = (extra) => JSON.stringify(buildMergeRequestCard({ ...base, ...extra }).card ?? buildMergeRequestCard({ ...base, ...extra }));
  const mergeUrl = `${ORIGIN}/approve/#${'M'.repeat(43)}`;
  const approveUrl = `${ORIGIN}/approve/#${'A'.repeat(43)}`;

  const live = card({ state: 'open', mergeUrl, approveUrl });
  assert.match(live, /"title":"🔀 Merge"/);
  assert.ok(live.includes(mergeUrl));
  assert.match(live, /Approve/, 'approve stays next to it');
  assert.match(card({ state: 'open', mergeUrl }), /🔀 Merge/);
  assert.match(card({ state: 'rebased', mergeUrl }), /🔀 Merge/);
  assert.doesNotMatch(card({ state: 'open' }), /Merge"/);
  assert.doesNotMatch(card({ state: 'open', mergeUrl: 'javascript:alert(1)' }), /alert/);
  for (const state of ['merged', 'closed', 'rebase']) {
    assert.doesNotMatch(card({ state, mergeUrl }), /🔀 Merge/, state);
  }
  assert.doesNotMatch(card({ state: 'open', draft: true, mergeUrl }), /🔀 Merge/, 'drafts have none');
  // The Reopen button on closed cards is untouched.
  assert.match(card({ state: 'closed', reopenUrl: approveUrl }), /🔄 Reopen/);
});

test('the watcher offers Merge only on live, non-draft cards with the flow enabled in rich mode', () => {
  const flow = new ApproveServer({ gitlab: makeGitlab(), baseUrl: `${ORIGIN}/approve`, mergeEnabled: true });
  const mr = { project: PROJECT, iid: IID, title: 'Example' };
  const details = { sha: SHA, draft: false, title: 'Example', detailedMergeStatus: 'mergeable' };
  const text = (w, opts, d = details) => JSON.stringify(w.buildMrCard(mr, d, opts));
  const rich = watcherWith({ rich_messages: true }, flow);

  assert.match(text(rich, { state: 'open' }), /🔀 Merge/);
  assert.match(text(rich, { state: 'rebased' }), /🔀 Merge/);
  for (const state of ['merged', 'closed', 'rebase']) {
    assert.doesNotMatch(text(rich, { state }), /🔀 Merge/, state);
  }
  assert.doesNotMatch(text(rich, { state: 'open' }, { ...details, draft: true }), /🔀 Merge/, 'draft');
  for (const detailedMergeStatus of ['not_approved', 'ci_still_running', 'need_rebase', 'conflict', 'discussions_not_resolved', 'checking', undefined]) {
    assert.doesNotMatch(text(rich, { state: 'open' }, { ...details, detailedMergeStatus }), /🔀 Merge/, `not mergeable: ${detailedMergeStatus}`);
  }
  assert.doesNotMatch(text(rich, { state: 'open' }, { ...details, sha: null }), /🔀 Merge/, 'no head');
  assert.doesNotMatch(text(watcherWith({ rich_messages: false }, flow), { state: 'open' }), /🔀 Merge/, 'rich mode off');
  assert.doesNotMatch(text(watcherWith({ rich_messages: true }, null), { state: 'open' }), /🔀 Merge/, 'flow disabled');

  const url = (w) => /https:\/\/approve\.example\.com\/approve\/#[A-Za-z0-9_-]{43}/g;
  const records = [...flow.store.records.values()];
  const merges = records.filter((r) => r.action === 'merge');
  assert.equal(merges.length, 1, 'one merge link, reused across refreshes');
  assert.equal(merges[0].sha, SHA);
  assert.ok(url(rich));
});

test('merge records are persisted under their own key and an older build reads no merge link as an approval', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-merge-split-'));
  const file = path.join(dir, 'approve.json');
  // The loader of the build before the Merge action: it reads `records` only and
  // treats any action it does not know as an approval.
  const oldLoader = (data) =>
    (Array.isArray(data?.records) ? data.records : []).map((r) => ({ ...r, action: ['approve', 'reopen'].includes(r.action) ? r.action : 'approve' }));
  try {
    const store = new ApprovalStore({ file });
    const approve = store.linkFor({ project: PROJECT, iid: IID, sha: SHA });
    const reopen = store.linkFor({ project: PROJECT, iid: 9, action: 'reopen' });
    const merge = store.linkFor({ project: PROJECT, iid: IID, sha: SHA, action: 'merge' });
    const usedMerge = store.linkFor({ project: PROJECT, iid: 8, sha: SHA, action: 'merge' });
    store.markMerged(PROJECT, 8);

    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(raw.records.map((r) => r.id).sort(), [approve.record.id, reopen.record.id].sort());
    assert.deepEqual(raw.mergeRecords.map((r) => r.id).sort(), [merge.record.id, usedMerge.record.id].sort());
    assert.ok(raw.records.every((r) => r.action !== 'merge'), 'no merge record under `records`');

    // Rollback: the old build keeps its approve and reopen links and sees no merge link at all.
    const seen = oldLoader(raw);
    assert.deepEqual(seen.map((r) => [r.id, r.action]).sort(), [[approve.record.id, 'approve'], [reopen.record.id, 'reopen']].sort());
    assert.equal(
      seen.some((r) => r.id === merge.record.id || r.id === usedMerge.record.id),
      false,
      'a merge link must never become an approval link',
    );

    // Roll forward again: the current build restores everything, merge links still merge.
    const loaded = new ApprovalStore({ file });
    loaded.load();
    assert.equal(loaded.byId(approve.record.id).action, 'approve');
    assert.equal(loaded.byId(reopen.record.id).action, 'reopen');
    assert.equal(loaded.byId(merge.record.id).action, 'merge');
    assert.equal(loaded.byId(merge.record.id).status, 'open');
    assert.equal(loaded.byId(usedMerge.record.id).status, 'used');

    // The older build rewrote the file without merge records (it never saw them): loads cleanly.
    fs.writeFileSync(file, JSON.stringify({ version: 4, records: seen, approvedHeads: [] }));
    const back = new ApprovalStore({ file });
    back.load();
    assert.equal(back.byId(merge.record.id), null);
    assert.equal(back.byId(approve.record.id).action, 'approve');

    // A file from before the Merge action has no `mergeRecords`: fine.
    assert.doesNotThrow(() => new ApprovalStore({ file }).load());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a merge record can not smuggle itself in as an approval through the persisted file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-merge-smuggle-'));
  const file = path.join(dir, 'approve.json');
  try {
    const store = new ApprovalStore({ file });
    const merge = store.linkFor({ project: PROJECT, iid: IID, sha: SHA, action: 'merge' });
    // Whatever `action` a record under `mergeRecords` claims, it is a merge link; and one
    // under `records` with an unknown action is an approval (the older, safe default).
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.mergeRecords[0].action = 'approve';
    fs.writeFileSync(file, JSON.stringify(raw));
    const loaded = new ApprovalStore({ file });
    loaded.load();
    assert.equal(loaded.byId(merge.record.id).action, 'merge');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('merging is off by default: no merge link, no button, and an existing link stops working', async () => {
  // Default: the server mints no merge link, the watcher shows no button.
  const off = new ApproveServer({ gitlab: mergeableGitlab(), baseUrl: `${ORIGIN}/approve` });
  assert.equal(off.mergeEnabled, false);
  assert.equal(off.linkFor({ project: PROJECT, iid: IID, sha: SHA, action: 'merge' }), null);
  assert.ok(off.linkFor({ project: PROJECT, iid: IID, sha: SHA }), 'approve links are unaffected');
  const mr = { project: PROJECT, iid: IID, title: 'Example' };
  const details = { sha: SHA, draft: false, title: 'Example', detailedMergeStatus: 'mergeable' };
  const card = (flow) => JSON.stringify(watcherWith({ rich_messages: true }, flow).buildMrCard(mr, details, { state: 'open' }));
  assert.doesNotMatch(card(off), /🔀 Merge/);
  assert.match(card(off), /Approve/);
  for (const v of ['true', 1, 'yes', undefined, null]) {
    assert.equal(new ApproveServer({ gitlab: mergeableGitlab(), baseUrl: `${ORIGIN}/approve`, mergeEnabled: v }).mergeEnabled, false, String(v));
  }

  // On: the button appears.
  const on = new ApproveServer({ gitlab: mergeableGitlab(), baseUrl: `${ORIGIN}/approve`, mergeEnabled: true });
  assert.match(card(on), /🔀 Merge/);

  // A merge link that exists (minted while it was on) does nothing while it is off:
  // no confirmation button, no PUT, even with a valid session and CSRF token.
  const gitlab = mergeableGitlab();
  const ctx = await setup({ gitlab, action: 'merge' });
  try {
    const cookie = await ctx.open();
    const csrf = await ctx.csrfFrom(await ctx.page(cookie));
    ctx.server.mergeEnabled = false;
    const page = await ctx.page(cookie);
    const html = await page.text();
    assert.doesNotMatch(html, /name="csrf"/, 'no confirm form');
    assert.match(html, /turned off/);
    const res = await ctx.post(cookie, { csrf });
    assert.equal(res.status, 409);
    assert.match(await res.text(), /turned off/);
    assert.equal(gitlab.calls.merge.length, 0, 'nothing was sent');
    assert.equal(ctx.server.store.byId(ctx.record.id).status, 'open', 'the link is kept for when it is switched on');

    // Switched on again: the same link works.
    ctx.server.mergeEnabled = true;
    ctx.server.readCache.clear();
    const ok = await ctx.post(cookie, { csrf: await ctx.csrfFrom(await ctx.page(cookie)) });
    assert.ok([200, 502].includes(ok.status), 'the merge was attempted');
    assert.equal(gitlab.calls.merge.length, 1);
  } finally {
    await ctx.server.stop();
  }
});

test('a plain rejection is read back once; an unclear outcome is read back several times, spaced out', async () => {
  const run = async ({ error, answer }) => {
    const gitlab = mergeableGitlab();
    gitlab.mergeError = error || null;
    if (answer !== undefined) {
      gitlab.mergeMrOnce = async (project, iid, opts) => {
        gitlab.calls.merge.push({ project, iid, opts });
        return answer;
      };
    }
    const sleeps = [];
    let reads = 0;
    const get = gitlab.getMr;
    gitlab.getMr = async (...a) => {
      if (gitlab.calls.merge.length > 0) reads++;
      return get(...a);
    };
    const ctx = await setup({ gitlab, action: 'merge', serverOpts: { mergePollAttempts: 5, mergePollMs: 2000, sleep: async (ms) => sleeps.push(ms) } });
    try {
      const res = await ctx.confirm();
      return { status: res.status, html: await res.text(), reads, sleeps, sends: gitlab.calls.merge.length };
    } finally {
      await ctx.server.stop();
    }
  };
  const rejected = await run({ error: new Error('GitLab error (422): no') });
  assert.equal(rejected.reads, 1);
  assert.deepEqual(rejected.sleeps, []);
  assert.equal(rejected.sends, 1);

  for (const input of [{ error: new Error('GitLab request failed (network)') }, { error: new Error('GitLab error (503): busy') }, { answer: { state: 'opened' } }]) {
    const r = await run(input);
    assert.equal(r.reads, 5, JSON.stringify(Object.keys(input)));
    assert.deepEqual(r.sleeps, [2000, 2000, 2000, 2000]);
    assert.equal(r.status, 502);
    assert.match(r.html, /8 seconds/);
    assert.match(r.html, /queued/);
    assert.doesNotMatch(r.html, /Nothing was merged|so it was not merged/);
    assert.equal(r.sends, 1, 'never resent');
  }
});

test('the merge switch is read from gitlab.approve.merge_enabled and defaults to off', async () => {
  const { loadConfig } = await import('../src/config.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-merge-cfg-'));
  try {
    const write = (approve) => {
      const configPath = path.join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
      fs.writeFileSync(configPath, JSON.stringify({ conversations: [{ id: '48:notes', name: 'Notes' }], ...(approve ? { gitlab: { approve } } : {}) }));
      return loadConfig(configPath).gitlab.approve;
    };
    assert.equal(write().merge_enabled, false);
    assert.equal(write({ enable: true }).merge_enabled, false, 'enabling approvals does not enable merging');
    assert.equal(write({ enable: true, merge_enabled: true }).merge_enabled, true);
    assert.equal(write({ enable: true, merge_enabled: false }).merge_enabled, false);
    // Strict: only the boolean true enables it (a destructive opt-in must not be switched on by a stray string or number).
    for (const stray of ['false', 'true', 'yes', '1', 0, 1, null, {}, []]) {
      assert.equal(write({ enable: true, merge_enabled: stray }).merge_enabled, false, `merge_enabled ${JSON.stringify(stray)} stays off`);
    }
    // The environment is only read when the file does not set it, and only "true"/"1" enable.
    const keep = process.env.TEAMS_GITLAB_APPROVE_MERGE_ENABLED;
    try {
      process.env.TEAMS_GITLAB_APPROVE_MERGE_ENABLED = 'true';
      assert.equal(write({ enable: true }).merge_enabled, true);
      assert.equal(write({ enable: true, merge_enabled: false }).merge_enabled, false, 'the file wins over the environment');
      process.env.TEAMS_GITLAB_APPROVE_MERGE_ENABLED = 'false';
      assert.equal(write({ enable: true }).merge_enabled, false);
      process.env.TEAMS_GITLAB_APPROVE_MERGE_ENABLED = 'yes';
      assert.equal(write({ enable: true }).merge_enabled, false);
    } finally {
      if (keep === undefined) delete process.env.TEAMS_GITLAB_APPROVE_MERGE_ENABLED;
      else process.env.TEAMS_GITLAB_APPROVE_MERGE_ENABLED = keep;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── the page looks like GitLab's merge request, links to it, and updates itself ───────────────

const FULL_MR = {
  state: 'opened',
  draft: false,
  sha: SHA,
  title: 'feat: update the example makefile',
  web_url: 'https://git.example.com/group/app/-/merge_requests/7',
  source_branch: 'feat/example',
  target_branch: 'main',
  author: { name: 'Alice Example', username: 'alice', web_url: 'https://git.example.com/alice' },
  head_pipeline: { id: 42, status: 'running', web_url: 'https://git.example.com/group/app/-/pipelines/42' },
  detailed_merge_status: 'ci_still_running',
};

function gitlabWithLinks(extra = {}) {
  const gitlab = makeGitlab({
    host: 'git.example.com',
    mrLink: (project, iid) => `https://git.example.com/${project}/-/merge_requests/${iid}`,
    async getApprovalSummary() {
      return { known: true, approved: true, approvedBy: ['MS Teams bot'], approvalsGiven: 1, approvalsRequired: 1 };
    },
    ...extra,
  });
  gitlab.mr = { ...FULL_MR };
  return gitlab;
}

test('the page shows the merge request like GitLab does and links to it: title, project, branches, author, pipeline, commit', async () => {
  const ctx = await setup({ gitlab: gitlabWithLinks() });
  try {
    const html = await (await ctx.page(await ctx.open())).text();
    const href = (text) => new RegExp(`<a href="([^"]+)" target="_blank" rel="noopener noreferrer">(?:<[^>]+>)*${text}`);
    assert.equal(href('feat: update the example makefile').exec(html)[1], 'https://git.example.com/group/app/-/merge_requests/7');
    assert.ok(html.includes('href="https://git.example.com/group/app/-/merge_requests/7" target="_blank" rel="noopener noreferrer"><span class="ref">'), 'reference');
    assert.ok(html.includes('href="https://git.example.com/group/app/-/tree/feat%2Fexample"'), 'source branch');
    assert.ok(html.includes('href="https://git.example.com/group/app/-/tree/main"'), 'target branch');
    assert.ok(html.includes('href="https://git.example.com/alice"'), 'author');
    assert.ok(html.includes('href="https://git.example.com/group/app/-/pipelines/42"'), 'pipeline');
    assert.ok(html.includes(`href="https://git.example.com/group/app/-/commit/${SHA}"`), 'head commit');
    assert.match(html, /Running #42/);
    assert.match(html, /1 of 1 required by <span class="person"><img class="av" src="data:image\/png;base64,[^"]+" alt="MS Teams bot" width="20" height="20">MS Teams bot<\/span>/, 'the approver with a picture (initials without a photo)');
    assert.match(html, /Pipeline running/);
  } finally {
    await ctx.server.stop();
  }
});

test('links point at the GitLab host only, and what GitLab sends is escaped', async () => {
  const gitlab = gitlabWithLinks();
  gitlab.mr = {
    ...FULL_MR,
    web_url: 'https://evil.example.net/group/app/-/merge_requests/7',
    author: { name: '<b>Eve</b>', username: 'eve', web_url: 'javascript:alert(1)' },
    head_pipeline: { id: 1, status: 'success', web_url: 'https://evil.example.net/p' },
    source_branch: '"><script>x</script>',
  };
  const ctx = await setup({ gitlab });
  try {
    const html = await (await ctx.page(await ctx.open())).text();
    assert.doesNotMatch(html, /evil\.example\.net|javascript:/);
    assert.doesNotMatch(html, /<b>Eve|<script>x/);
    assert.match(html, /&lt;b&gt;Eve&lt;\/b&gt;/);
  } finally {
    await ctx.server.stop();
  }
});

test('the live state endpoint needs the session, answers JSON and reads GitLab once per few seconds', async () => {
  const gitlab = gitlabWithLinks();
  let reads = 0;
  const original = gitlab.getMr;
  gitlab.getMr = async () => {
    reads++;
    return original.call(gitlab);
  };
  const ctx = await setup({ gitlab });
  try {
    const url = `${ctx.base}/approve/state`;
    assert.equal((await fetch(url)).status, 401, 'no session');
    const cookie = await ctx.open();
    const res = await fetch(url, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const data = await res.json();
    assert.equal(data.actionable, true);
    assert.match(data.slots.state, /pill-open/);
    assert.match(data.slots.pipeline, /Running #42/);
    assert.match(data.slots.merge, /Pipeline running/);
    const before = reads;
    await fetch(url, { headers: { Cookie: cookie } });
    await fetch(url, { headers: { Cookie: cookie } });
    assert.equal(reads, before + 2, 'each request rechecks the user while the display snapshot is cached');
    assert.equal((await fetch(url, { method: 'POST', headers: { Cookie: cookie } })).status, 405);
  } finally {
    await ctx.server.stop();
  }
});

test('when the merge request is merged the live state says so and the action goes away', async () => {
  const gitlab = gitlabWithLinks();
  gitlab.mr = { ...FULL_MR, state: 'merged', detailed_merge_status: 'not_open', head_pipeline: { id: 42, status: 'success', web_url: 'https://git.example.com/group/app/-/pipelines/42' } };
  const ctx = await setup({ gitlab });
  try {
    const cookie = await ctx.open();
    const data = await (await fetch(`${ctx.base}/approve/state`, { headers: { Cookie: cookie } })).json();
    assert.equal(data.actionable, false);
    assert.match(data.slots.state, /pill-merged/);
    assert.match(data.slots.pipeline, /Passed #42/);
    assert.equal(data.slots.notice, 'This merge request has been merged.');
  } finally {
    await ctx.server.stop();
  }
});

test('after an approval the page leads on: the merge request in GitLab and the Teams card', async () => {
  const ctx = await setup({
    gitlab: gitlabWithLinks(),
    serverOpts: { locateCard: () => ({ conversationId: '19:x@thread.v2', messageId: '1700000000000' }) },
  });
  try {
    const res = await ctx.confirm();
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Approved in GitLab/);
    assert.match(html, /<a class="btn" href="https:\/\/git\.example\.com\/group\/app\/-\/merge_requests\/7" target="_blank" rel="noopener noreferrer">View merge request in GitLab<\/a>/);
    assert.match(html, /<a class="btn btn-secondary" href="https:\/\/teams\.microsoft\.com\/l\/message\/19%3Ax%40thread\.v2\/1700000000000"[^>]*>Open the Teams card<\/a>/);
  } finally {
    await ctx.server.stop();
  }
});

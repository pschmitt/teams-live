import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { acquireFromBrowserDaemon, closePendingBrowserAuth, trackBrowserAuth } from '../src/browser-auth.mjs';
import { AuthManager } from '../src/auth.mjs';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('opens and closes its authentication tab in the configured profile session', async () => {
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url, method: options.method || 'GET' });
    if (url.pathname === '/api/mesh/overview') {
      return { ok: true, json: async () => ({
        local_node: { name: 'local' },
        profiles: [{ name: 'work', node_name: 'local', session_id: 'profile-session' }],
        targets: [],
      }) };
    }
    if (url.pathname === '/json/new') {
      return { ok: true, json: async () => ({ id: url.searchParams.get('url') === 'about:blank' ? 'blank-tab' : 'owned-tab' }) };
    }
    if (url.pathname === '/api/pages/owned-tab/auth') {
      return { ok: false, status: 403, text: async () => 'test error' };
    }
    if (url.pathname === '/api/sessions/profile-session') {
      return { ok: true, json: async () => ({ session: { tabs_count: 1 } }) };
    }
    if (url.pathname === '/json/close/owned-tab') {
      return { ok: true };
    }
    throw new Error(`Unexpected request path: ${url.pathname}`);
  };

  await assert.rejects(
    acquireFromBrowserDaemon({ url: 'https://browser.invalid', profile: 'work' }),
    /Auth export failed/,
  );

  const open = calls.find((call) => call.url.searchParams.get('url') === 'https://teams.cloud.microsoft/');
  assert.equal(open.method, 'PUT');
  assert.equal(open.url.searchParams.get('session_id'), 'profile-session');
  assert.equal(open.url.searchParams.get('url'), 'https://teams.cloud.microsoft/');
  const blank = calls.find((call) => call.url.searchParams.get('url') === 'about:blank');
  assert.equal(blank.method, 'PUT');
  assert.equal(blank.url.searchParams.get('session_id'), 'profile-session');
  const close = calls.find((call) => call.url.pathname === '/json/close/owned-tab');
  assert.equal(close.method, 'PUT');
  assert.ok(calls.indexOf(blank) < calls.indexOf(close));
});

test('does not close an existing Teams tab', async () => {
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url, method: options.method || 'GET' });
    if (url.pathname === '/api/mesh/overview') {
      return { ok: true, json: async () => ({
        local_node: { name: 'local' },
        profiles: [{ name: 'work', node_name: 'local', session_id: 'profile-session' }],
        targets: [{ id: 'existing-tab', type: 'page', sessionId: 'profile-session', url: 'https://teams.cloud.microsoft/' }],
      }) };
    }
    if (url.pathname === '/api/pages/existing-tab/auth') {
      return { ok: false, status: 403, text: async () => 'test error' };
    }
    throw new Error(`Unexpected request path: ${url.pathname}`);
  };

  await assert.rejects(
    acquireFromBrowserDaemon({ url: 'https://browser.invalid', profile: 'work' }),
    /Auth export failed/,
  );
  assert.equal(calls.some((call) => call.url.pathname.startsWith('/json/close/')), false);
});

test('keeps the session alive and closes its tab if usage cannot be checked', async () => {
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url, method: options.method || 'GET' });
    if (url.pathname === '/api/mesh/overview') {
      return { ok: true, json: async () => ({
        local_node: { name: 'local' },
        profiles: [{ name: 'work', node_name: 'local', session_id: 'profile-session' }],
        targets: [],
      }) };
    }
    if (url.pathname === '/json/new') {
      return { ok: true, json: async () => ({ id: url.searchParams.get('url') === 'about:blank' ? 'blank-tab' : 'owned-tab' }) };
    }
    if (url.pathname === '/api/pages/owned-tab/auth') {
      return { ok: false, status: 403, text: async () => 'test error' };
    }
    if (url.pathname === '/api/sessions/profile-session') {
      return { ok: false };
    }
    if (url.pathname === '/json/close/owned-tab') return { ok: true };
    throw new Error(`Unexpected request path: ${url.pathname}`);
  };

  await assert.rejects(
    acquireFromBrowserDaemon({ url: 'https://browser.invalid', profile: 'work' }),
    /Auth export failed/,
  );
  const blank = calls.findIndex((call) => call.url.searchParams.get('url') === 'about:blank');
  const close = calls.findIndex((call) => call.url.pathname === '/json/close/owned-tab');
  assert.ok(blank >= 0 && close > blank);
});

test('retries with an owned tab when the advertised Teams tab has closed', async () => {
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url, method: options.method || 'GET' });
    if (url.pathname === '/api/mesh/overview') {
      return { ok: true, json: async () => ({
        local_node: { name: 'local' },
        profiles: [{ name: 'work', node_name: 'local', session_id: 'profile-session' }],
        targets: [{ id: 'stale-tab', type: 'page', sessionId: 'profile-session', url: 'https://teams.cloud.microsoft/' }],
      }) };
    }
    if (url.pathname === '/api/pages/stale-tab/auth') return { ok: false, status: 502 };
    if (url.pathname === '/json/new') return { ok: true, json: async () => ({ id: 'owned-tab' }) };
    if (url.pathname === '/api/pages/owned-tab/auth') {
      return { ok: false, status: 403, text: async () => 'test error' };
    }
    if (url.pathname === '/api/sessions/profile-session') {
      return { ok: true, json: async () => ({ session: { tabs_count: 2 } }) };
    }
    if (url.pathname === '/json/close/owned-tab') return { ok: true };
    throw new Error(`Unexpected request path: ${url.pathname}`);
  };

  await assert.rejects(
    acquireFromBrowserDaemon({ url: 'https://browser.invalid', profile: 'work' }),
    /Auth export failed/,
  );
  assert.ok(calls.some((call) => call.url.pathname === '/api/pages/owned-tab/auth'));
  assert.ok(calls.some((call) => call.url.pathname === '/json/close/owned-tab'));
  assert.equal(calls.some((call) => call.url.pathname === '/json/close/stale-tab'), false);
  assert.equal(calls.some((call) => call.url.searchParams.get('url') === 'about:blank'), false);
});

test('reaches a profile on another node through the peer proxy and closes the session it created', async () => {
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url, method: options.method || 'GET' });
    if (url.pathname === '/api/mesh/placement') return { ok: true, json: async () => ({ node: 'remote' }) };
    if (url.pathname === '/api/mesh/overview') {
      return { ok: true, json: async () => ({
        local_node: { name: 'local' },
        profiles: [{ name: 'ha-msteams', node_name: 'remote', session_id: null }],
        targets: [],
      }) };
    }
    if (url.pathname === '/api/peers/remote/sessions' && options.method === 'POST') {
      return { ok: true, json: async () => ({ id: 'new-session' }) };
    }
    if (url.pathname === '/api/peers/remote/json/new') {
      return { ok: true, json: async () => ({ id: url.searchParams.get('url') === 'about:blank' ? 'blank-tab' : 'owned-tab' }) };
    }
    if (url.pathname === '/api/peers/remote/pages/owned-tab/auth') {
      return { ok: false, status: 403, text: async () => 'test error' };
    }
    if (url.pathname === '/api/peers/remote/sessions/new-session' && options.method === 'DELETE') {
      return { ok: true, json: async () => ({ status: 'terminated' }) };
    }
    throw new Error(`Unexpected request path: ${url.pathname}`);
  };

  await assert.rejects(
    acquireFromBrowserDaemon({ url: 'https://browser.invalid', profile: 'ha-msteams', node_group: 'cloud' }),
    /Auth export failed/,
  );

  assert.equal(calls[0].url.pathname, '/api/mesh/placement');
  assert.ok(calls.some((c) => c.url.pathname === '/api/peers/remote/sessions' && c.method === 'POST'));
  assert.ok(calls.some((c) => c.url.pathname === '/api/peers/remote/pages/owned-tab/auth'));
  assert.ok(calls.some((c) => c.url.pathname === '/api/peers/remote/sessions/new-session' && c.method === 'DELETE'));
  // The whole session goes, so no blank tab is kept and no tab closed one by one.
  assert.ok(!calls.some((c) => c.url.searchParams.get('url') === 'about:blank'));
  assert.ok(!calls.some((c) => c.url.pathname.includes('/remote/api/')));
});

test('requires cloud placement before accessing the profile', async () => {
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ path: url.pathname, body: options.body && JSON.parse(options.body) });
    if (url.pathname === '/api/mesh/placement') return { ok: false, status: 409 };
    throw new Error(`Unexpected request path: ${url.pathname}`);
  };

  await assert.rejects(
    acquireFromBrowserDaemon({ url: 'https://browser.invalid', profile: 'work', node_group: 'cloud' }),
    /Browser placement failed: HTTP 409/,
  );
  assert.deepEqual(calls, [{ path: '/api/mesh/placement', body: { profile: 'work', group: 'cloud', engine: 'chromium', create: true } }]);
});


test('shutdown cancels authentication and closes its tab in a shared session', async () => {
  const calls = [];
  let opened;
  const openedPromise = new Promise(resolve => { opened = resolve; });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    calls.push(`${options.method || 'GET'} ${url.pathname}`);
    if (url.pathname === '/api/mesh/overview') return { ok: true, json: async () => ({
      local_node: { name: 'local' },
      profiles: [{ name: 'work', node_name: 'local', session_id: 'shared' }], targets: [],
    }) };
    if (url.pathname === '/json/new') return { ok: true, json: async () => { opened(); return { id: 'owned-tab' }; } };
    if (url.pathname === '/api/sessions/shared') return { ok: true, json: async () => ({ session: { tabs_count: 2 } }) };
    if (url.pathname === '/json/close/owned-tab') return { ok: true };
    throw new Error(`Unexpected request path: ${url.pathname}`);
  };
  const acquisition = acquireFromBrowserDaemon({ url: 'https://browser.invalid', profile: 'work' });
  const rejected = assert.rejects(acquisition, { name: 'AbortError' });
  await openedPromise;
  await new Promise(setImmediate);
  await closePendingBrowserAuth();
  await rejected;
  assert.ok(calls.includes('PUT /json/close/owned-tab'));
  assert.ok(!calls.includes('DELETE /api/sessions/shared'));
});

test('shutdown closes the session created for authentication', async () => {
  const calls = [];
  let opened;
  const openedPromise = new Promise(resolve => { opened = resolve; });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    calls.push([url.pathname, options.method || 'GET']);
    if (url.pathname === '/api/mesh/overview') return { ok: true, json: async () => ({
      local_node: { name: 'local' },
      profiles: [{ name: 'work', node_name: 'local', session_id: null }], targets: [],
    }) };
    if (url.pathname === '/api/sessions' && options.method === 'POST') return { ok: true, json: async () => ({ id: 'owned-session' }) };
    if (url.pathname === '/json/new') return { ok: true, json: async () => { opened(); return { id: 'owned-tab' }; } };
    if (url.pathname === '/api/sessions/owned-session' && options.method === 'DELETE') return { ok: true };
    throw new Error(`Unexpected request path: ${url.pathname}`);
  };
  const acquisition = acquireFromBrowserDaemon({ url: 'https://browser.invalid', profile: 'work' });
  const rejected = assert.rejects(acquisition, { name: 'AbortError' });
  await openedPromise;
  await new Promise(setImmediate);
  await closePendingBrowserAuth();
  await rejected;
  assert.ok(calls.some(([path, method]) => path === '/api/sessions/owned-session' && method === 'DELETE'));
});


test('shutdown waits for the shared sign-in helper to finish its cleanup', async () => {
  let finish;
  const helper = trackBrowserAuth(new Promise(resolve => { finish = resolve; }));
  let stopped = false;
  const shutdown = closePendingBrowserAuth().then(() => { stopped = true; });
  await new Promise(setImmediate);
  assert.equal(stopped, false);
  finish();
  await helper;
  await shutdown;
  assert.equal(stopped, true);
});

test('shutdown waits for an in-flight tab creation before closing the new tab', async () => {
  let opened;
  let completeOpen;
  const opening = new Promise(resolve => { opened = resolve; });
  const response = new Promise(resolve => { completeOpen = resolve; });
  const closed = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === '/api/mesh/overview') return { ok: true, json: async () => ({
      local_node: { name: 'local' },
      profiles: [{ name: 'work', node_name: 'local', session_id: 'shared' }], targets: [],
    }) };
    if (url.pathname === '/json/new') { opened(); return response; }
    if (url.pathname === '/api/sessions/shared') return { ok: true, json: async () => ({ session: { tabs_count: 2 } }) };
    if (url.pathname === '/json/close/owned-tab') { closed.push(options.method); return { ok: true }; }
    throw new Error(`Unexpected request path: ${url.pathname}`);
  };
  const acquisition = acquireFromBrowserDaemon({ url: 'https://browser.invalid', profile: 'work' });
  const rejected = assert.rejects(acquisition, { name: 'AbortError' });
  await opening;
  let stopped = false;
  const shutdown = closePendingBrowserAuth().then(() => { stopped = true; });
  await new Promise(setImmediate);
  assert.equal(stopped, false);
  completeOpen({ ok: true, json: async () => ({ id: 'owned-tab' }) });
  await shutdown;
  await rejected;
  assert.deepEqual(closed, ['PUT']);
});


test('a stopped authentication manager does not begin another browser login', async () => {
  const manager = new AuthManager({ teams: {}, browser_daemon: {} });
  manager.stop();
  await assert.rejects(manager.ensureValidAuth(), { name: 'AbortError' });
});

test('shutdown waits for an in-flight session creation and closes that session', async () => {
  let started;
  let complete;
  const starting = new Promise(resolve => { started = resolve; });
  const response = new Promise(resolve => { complete = resolve; });
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    calls.push([url.pathname, options.method || 'GET']);
    if (url.pathname === '/api/mesh/overview') return { ok: true, json: async () => ({
      local_node: { name: 'local' },
      profiles: [{ name: 'work', node_name: 'local', session_id: null }], targets: [],
    }) };
    if (url.pathname === '/api/sessions' && options.method === 'POST') { started(); return response; }
    if (url.pathname === '/api/sessions/owned-session' && options.method === 'DELETE') return { ok: true };
    throw new Error(`Unexpected request path: ${url.pathname}`);
  };
  const acquisition = acquireFromBrowserDaemon({ url: 'https://browser.invalid', profile: 'work' });
  const rejected = assert.rejects(acquisition, { name: 'AbortError' });
  await starting;
  const shutdown = closePendingBrowserAuth();
  complete({ ok: true, json: async () => ({ id: 'owned-session' }) });
  await shutdown;
  await rejected;
  assert.ok(calls.some(([path, method]) => path === '/api/sessions/owned-session' && method === 'DELETE'));
  assert.ok(!calls.some(([path]) => path === '/json/new'));
});

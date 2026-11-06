import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { acquireFromBrowserDaemon } from '../src/browser-auth.mjs';

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

test('keeps the authentication tab if session usage cannot be checked', async () => {
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
      return { ok: true, json: async () => ({ id: 'owned-tab' }) };
    }
    if (url.pathname === '/api/pages/owned-tab/auth') {
      return { ok: false, status: 403, text: async () => 'test error' };
    }
    if (url.pathname === '/api/sessions/profile-session') {
      return { ok: false };
    }
    throw new Error(`Unexpected request path: ${url.pathname}`);
  };

  await assert.rejects(
    acquireFromBrowserDaemon({ url: 'https://browser.invalid', profile: 'work' }),
    /Auth export failed/,
  );
  assert.equal(calls.some((call) => call.url.pathname.startsWith('/json/close/')), false);
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

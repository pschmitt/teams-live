import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { GitLabClient } from '../src/gitlab.mjs';
import { GitLabWebhookServer } from '../src/webhook.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';

function postRequest(urlStr, { headers = {}, body = null } = {}) {
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        let resBody = '';
        res.on('data', (chunk) => {
          resBody += chunk;
        });
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(resBody);
          } catch {
            parsed = resBody;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function getRequest(urlStr) {
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET' }, (res) => {
      let resBody = '';
      res.on('data', (chunk) => {
        resBody += chunk;
      });
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(resBody);
        } catch {
          parsed = resBody;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('GitLabWebhookServer verifies secret token and handles events', async () => {
  const events = [];
  const server = new GitLabWebhookServer({
    port: 0, // OS assigned port
    host: '127.0.0.1',
    path: '/webhook/gitlab',
    secret: 'test-secret-token',
    onEvent: (type, payload) => events.push({ type, payload }),
  });

  await server.start();
  const address = server.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Health check
    const health = await getRequest(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { status: 'ok' });

    // 2. 404 for wrong path
    const wrongPath = await postRequest(`${baseUrl}/other-path`, { body: {} });
    assert.equal(wrongPath.status, 404);

    // 3. 401 for missing/invalid token when secret is configured
    const noToken = await postRequest(`${baseUrl}/webhook/gitlab`, {
      body: { test: true },
    });
    assert.equal(noToken.status, 401);

    const badToken = await postRequest(`${baseUrl}/webhook/gitlab`, {
      headers: { 'X-Gitlab-Token': 'wrong-token' },
      body: { test: true },
    });
    assert.equal(badToken.status, 401);

    // 4. 200 for valid token
    const valid = await postRequest(`${baseUrl}/webhook/gitlab`, {
      headers: {
        'X-Gitlab-Token': 'test-secret-token',
        'X-Gitlab-Event': 'Merge Request Hook',
      },
      body: {
        object_kind: 'merge_request',
        object_attributes: { iid: 42, title: 'Test MR' },
      },
    });
    assert.equal(valid.status, 200);
    assert.deepEqual(valid.body, { ok: true });

    // Allow event dispatch
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'Merge Request Hook');
    assert.equal(events[0].payload.object_attributes.iid, 42);
  } finally {
    await server.stop();
  }
});

test('GitLabClient.ensureGroupWebhook creates or updates group hook', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];

  let existingHooks = [
    {
      id: 10,
      url: 'https://other.example.com/hook',
      merge_requests_events: true,
      pipeline_events: true,
      enable_ssl_verification: true,
    },
  ];

  globalThis.fetch = async (url, opts = {}) => {
    requests.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });

    if (url.endsWith('/api/v4/groups/my-group/hooks')) {
      if ((opts.method || 'GET') === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => existingHooks,
        };
      }
      if (opts.method === 'POST') {
        const newHook = { id: 11, ...JSON.parse(opts.body) };
        existingHooks.push(newHook);
        return {
          ok: true,
          status: 201,
          json: async () => newHook,
        };
      }
    }

    if (url.includes('/api/v4/groups/my-group/hooks/')) {
      if (opts.method === 'PUT') {
        const id = Number(url.split('/').pop());
        const hook = existingHooks.find((h) => h.id === id);
        Object.assign(hook, JSON.parse(opts.body));
        return {
          ok: true,
          status: 200,
          json: async () => hook,
        };
      }
    }

    return { ok: false, status: 404, text: async () => 'Not found' };
  };

  try {
    const client = new GitLabClient({
      host: 'git.example.com',
      token: 'dummy-token',
      group: 'my-group',
    });

    // Case 1: Hook does not exist -> creates it
    const res1 = await client.ensureGroupWebhook({
      url: 'https://teams-live.example.com/webhook/gitlab',
      secretToken: 'my-secret',
    });
    assert.equal(res1.action, 'created');
    assert.equal(res1.hook.id, 11);
    assert.equal(res1.hook.url, 'https://teams-live.example.com/webhook/gitlab');

    // Case 2: Hook exists and secretToken is provided -> updates it
    const res2 = await client.ensureGroupWebhook({
      url: 'https://teams-live.example.com/webhook/gitlab',
      secretToken: 'my-secret',
    });
    assert.equal(res2.action, 'updated');

    // Case 3: Hook exists and no update needed (secretToken omitted and events match)
    const res3 = await client.ensureGroupWebhook({
      url: 'https://teams-live.example.com/webhook/gitlab',
    });
    assert.equal(res3.action, 'unchanged');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('MergeRequestWatcher.handleWebhookEvent triggers checkWatchedKey on matching MR', async () => {
  const checkedKeys = [];
  const watcher = new MergeRequestWatcher({
    config: {
      gitlab: {
        host: 'git.example.com',
        group: 'my-group',
        poll_interval_seconds: 60,
      },
      teams: {},
      conversations: [],
    },
    gitlab: {
      findMrLinks: () => [],
      getMrStatus: async () => ({ status: 'opened' }),
    },
    jira: null,
    opsgenie: null,
    authManager: { getCachedAuth: () => ({ userMri: '8:orgid:me' }) },
  });

  // Mock checkWatchedKey and checkAllWatched
  watcher.checkWatchedKey = async (key) => {
    checkedKeys.push(key);
  };
  let allWatchedCalled = false;
  watcher.checkAllWatched = async () => {
    allWatchedCalled = true;
  };

  // Add a watched entry for my-group/app!42
  watcher.watched.set('conv1/msg1', {
    conversationId: 'conv1',
    messageId: 'msg1',
    mrs: [{ project: 'my-group/app', iid: 42 }],
  });

  // 1. Webhook for matching MR
  await watcher.handleWebhookEvent('Merge Request Hook', {
    object_kind: 'merge_request',
    project: { path_with_namespace: 'my-group/app' },
    object_attributes: { iid: 42, action: 'update' },
  });
  assert.equal(checkedKeys.length, 1);
  assert.equal(checkedKeys[0], 'conv1/msg1');

  // 2. Webhook for pipeline on matching MR
  await watcher.handleWebhookEvent('Pipeline Hook', {
    object_kind: 'pipeline',
    project: { path_with_namespace: 'my-group/app' },
    object_attributes: { id: 999, status: 'success' },
    merge_request: { iid: 42 },
  });
  assert.equal(checkedKeys.length, 2);
  assert.equal(checkedKeys[1], 'conv1/msg1');

  // 3. Webhook for unknown MR -> triggers checkAllWatched
  await watcher.handleWebhookEvent('Merge Request Hook', {
    object_kind: 'merge_request',
    project: { path_with_namespace: 'my-group/other-app' },
    object_attributes: { iid: 100, action: 'open' },
  });
  assert.equal(allWatchedCalled, true);
});

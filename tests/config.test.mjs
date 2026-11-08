import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig, resolveSecrets } from '../src/config.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'teams-live-config-'));
}

test('resolveSecrets replaces _secret references with trimmed file contents', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'key'), 'abc123\n');
  fs.writeFileSync(path.join(dir, 'conv'), '19:xyz@thread.v2\n');

  const resolved = resolveSecrets({
    opsgenie: { on_call_key: { _secret: path.join(dir, 'key') }, base_url: 'https://example.com' },
    conversations: [{ id: { _secret: path.join(dir, 'conv') }, name: 'Team' }],
    other: { _secret: path.join(dir, 'key'), extra: true },
  });

  assert.equal(resolved.opsgenie.on_call_key, 'abc123');
  assert.equal(resolved.opsgenie.base_url, 'https://example.com');
  assert.equal(resolved.conversations[0].id, '19:xyz@thread.v2');
  // Only an object with nothing but `_secret` is a reference.
  assert.deepEqual(resolved.other, { _secret: path.join(dir, 'key'), extra: true });
});

test('resolveSecrets names the config key when a secret file is missing', () => {
  assert.throws(
    () => resolveSecrets({ jira: { url: { _secret: '/nonexistent/teams-live-secret' } } }),
    /config\.jira\.url/,
  );
});

test('loadConfig resolves secrets before reading values', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'host'), 'https://git.example.com/\n');
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      gitlab: { host: { _secret: path.join(dir, 'host') } },
      conversations: [{ id: '48:notes', name: 'Notes' }],
    }),
  );

  const config = loadConfig(configPath);
  assert.equal(config.gitlab.host, 'git.example.com');
  assert.equal(config.conversations[0].id, '48:notes');
});

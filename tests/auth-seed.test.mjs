import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The session store resolves its directories at import time: point them at a
// throwaway directory before loading anything from msteams-mcp.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-live-auth-seed-'));
process.env.XDG_STATE_HOME = path.join(tmp, 'state');
process.env.XDG_CACHE_HOME = path.join(tmp, 'cache');

const { readSessionState, writeSessionState } = await import('msteams-mcp/dist/auth/session-store.js');
const { AuthManager, sessionTokenExpiry } = await import('../src/auth.mjs');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function jwt(payload) {
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`;
}

function sessionState(label, expSeconds) {
  return {
    cookies: [
      { domain: 'teams.microsoft.com', name: 'skypetoken_asm', value: jwt({ exp: expSeconds, skypeid: 'orgid:00000000-0000-0000-0000-000000000001' }) },
      { domain: 'teams.microsoft.com', name: 'authtoken', value: `Bearer=${label}` },
    ],
    origins: [{ origin: 'https://teams.microsoft.com', localStorage: [{ name: 'DISCOVER-REGION-GTM', value: '{}' }] }],
  };
}

function managerWithFile(state) {
  const file = path.join(tmp, `credentials-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(state));
  return new AuthManager({ teams: { credentials_file: file } });
}

const now = Math.floor(Date.now() / 1000);

test('reads the Skype token expiry of a session state', () => {
  assert.equal(sessionTokenExpiry(sessionState('a', now + 60)), (now + 60) * 1000);
  assert.equal(sessionTokenExpiry(null), null);
  assert.equal(sessionTokenExpiry({ cookies: [] }), null);
});

test('keeps a cached session that is newer than the credentials file', async () => {
  writeSessionState(sessionState('cached', now + 3600));
  const auth = await managerWithFile(sessionState('stale', now - 3600)).ensureValidAuth();
  assert.equal(auth.authToken, 'cached');
  assert.equal(sessionTokenExpiry(readSessionState()), (now + 3600) * 1000);
});

test('seeds the store from a credentials file that is newer than the cache', async () => {
  writeSessionState(sessionState('cached', now - 3600));
  const auth = await managerWithFile(sessionState('fresh', now + 7200)).ensureValidAuth();
  assert.equal(auth.authToken, 'fresh');
  assert.equal(sessionTokenExpiry(readSessionState()), (now + 7200) * 1000);
});

test('seeds an empty store from the credentials file', async () => {
  fs.rmSync(path.join(tmp, 'state'), { recursive: true, force: true });
  const auth = await managerWithFile(sessionState('fresh', now + 7200)).ensureValidAuth();
  assert.equal(auth.authToken, 'fresh');
});

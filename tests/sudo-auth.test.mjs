import test from 'node:test';
import assert from 'node:assert/strict';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { extractUserOid } from '../src/users.mjs';

test('extractUserOid correctly parses Azure AD Object IDs', () => {
  const oid = 'f94ccd0d-d140-4d1d-9fee-b00e642b9c11';
  assert.equal(extractUserOid(oid), oid);
  assert.equal(extractUserOid(`8:orgid:${oid}`), oid);
  assert.equal(extractUserOid(`https://teams.microsoft.com/contacts/8:orgid:${oid}`), oid);
  assert.equal(extractUserOid(oid.toUpperCase()), oid);
  assert.equal(extractUserOid('invalid-string'), null);
  assert.equal(extractUserOid(''), null);
  assert.equal(extractUserOid(null), null);
});

test('isAdmin and isSenderSelf enforce immutable user IDs and reject spoofed display names', () => {
  const selfOid = 'f94ccd0d-d140-4d1d-9fee-b00e642b9c11';
  const selfMri = `8:orgid:${selfOid}`;
  const attackerOid = '11111111-2222-3333-4444-555555555555';
  const attackerMri = `8:orgid:${attackerOid}`;
  const trustedAdminOid = '99999999-8888-7777-6666-555555555555';

  const watcher = new MergeRequestWatcher({
    config: {
      conversations: [],
      gitlab: {},
      teams: {
        admin_ids: [trustedAdminOid],
      },
    },
    gitlab: { findMrLinks: () => [] },
    jira: null,
    opsgenie: null,
  });

  watcher.setSelfMri(selfMri);

  // 1. Spoofed display name from attacker MUST BE REJECTED
  const spoofedEvent = {
    from: 'Philipp Schmitt',
    fromMri: attackerMri,
    sender: {
      displayName: 'Philipp Schmitt',
      mri: attackerMri,
    },
  };
  assert.equal(watcher.isSenderSelf(spoofedEvent), false, 'isSenderSelf must reject spoofed display name');
  assert.equal(watcher.isAdmin(spoofedEvent), false, 'isAdmin must reject spoofed display name');

  // 2. Spoofed display name without MRI MUST BE REJECTED
  const anonymousSpoof = {
    from: 'Philipp Schmitt',
    sender: {
      displayName: 'Philipp Schmitt',
    },
  };
  assert.equal(watcher.isSenderSelf(anonymousSpoof), false);
  assert.equal(watcher.isAdmin(anonymousSpoof), false);

  // 3. Legitimate self event with matching OID/MRI MUST BE ACCEPTED
  const legitSelfEvent = {
    from: 'Any Display Name',
    fromMri: selfMri,
    sender: {
      mri: selfMri,
    },
  };
  assert.equal(watcher.isSenderSelf(legitSelfEvent), true);
  assert.equal(watcher.isAdmin(legitSelfEvent), true);

  // 4. Configured trusted admin in admin_ids MUST BE ACCEPTED for isAdmin but NOT isSenderSelf
  const trustedAdminEvent = {
    from: 'Admin User',
    fromMri: `8:orgid:${trustedAdminOid}`,
  };
  assert.equal(watcher.isAdmin(trustedAdminEvent), true);
  assert.equal(watcher.isSenderSelf(trustedAdminEvent), false);
});

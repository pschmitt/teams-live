import test from 'node:test';
import assert from 'node:assert/strict';
import { MergeRequestWatcher } from '../src/watcher.mjs';

const lookup = (results, hrworks = null) => MergeRequestWatcher.prototype.personInfo.bind({
  userDirectory: { searchDirectory: async () => results },
  hrworks,
});
const absenceOf = (hrworks) => MergeRequestWatcher.prototype.personAbsence.bind({ hrworks });

test('person info: one exact directory match, keeping its entry for HR WORKS', async () => {
  const info = await lookup([
    { displayName: 'Bob Example-Other', email: 'other@example.com' },
    { displayName: 'Bob Example', email: 'bob@example.com', jobTitle: 'Engineer', department: 'Platform', companyName: 'Example Corp' },
  ])('Bob Example');
  assert.equal(info.found, true);
  assert.equal(info.email, 'bob@example.com');
  assert.equal(info.company, 'Example Corp');
  assert.equal(info.presence, null, 'no presence without an MRI');
  assert.equal(info.directory.email, 'bob@example.com');
  assert.equal('absence' in info && info.absence !== null, false, 'the absence is not part of the cached answer');
});

test('person info: an ambiguous name is not guessed, a single result is taken', async () => {
  const twins = await lookup([{ displayName: 'Bob Example', mri: '8:orgid:a' }, { displayName: 'Bob Example', mri: '8:orgid:b' }])('Bob Example');
  assert.equal(twins.found, false);
  assert.match(twins.reason, /Several people/);
  assert.equal((await lookup([])('Nobody Example')).found, false);
  assert.equal((await lookup([{ displayName: 'Robert Example', email: 'r@example.com' }])('Bob Example')).found, true);
});

test('person absence: read offline from HR WORKS for every panel; pending until the calendar is loaded', async () => {
  const info = { found: true, directory: { displayName: 'Bob Example' } };
  const calls = [];
  const away = absenceOf({ findPersonAbsence: async (person, opts) => { calls.push([person.displayName, opts]); return { absence: { category: 'Vacation' } }; } });
  assert.deepEqual(await away(info), { state: 'away', current: { category: 'Vacation' } });
  assert.deepEqual(calls, [['Bob Example', { offline: true }]]);
  assert.deepEqual(await absenceOf({ findPersonAbsence: async () => ({ reason: 'calendar_unavailable' }) })(info), { state: 'pending' });
  assert.deepEqual(await absenceOf({ findPersonAbsence: async () => ({ reason: 'not_found' }) })(info), { state: 'not_found' });
  assert.deepEqual(await absenceOf({ findPersonAbsence: async () => { throw new Error('x'); } })(info), { state: 'unavailable' });
  assert.equal(await absenceOf(null)(info), null, 'no HR WORKS');
  assert.equal(await away({ found: false }), null);
});

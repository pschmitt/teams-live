import test from 'node:test';
import assert from 'node:assert/strict';
import { MergeRequestWatcher } from '../src/watcher.mjs';

const lookup = (results, hrworks = null) => MergeRequestWatcher.prototype.personInfo.bind({
  userDirectory: { searchDirectory: async () => results },
  hrworks,
});

test('person info: one exact directory match, with its HR WORKS absence', async () => {
  const hrworks = { findPersonAbsence: async () => ({ checked: true, absence: { category: 'Vacation', startDate: '2026-11-24', endDate: '2026-11-28' } }) };
  const info = await lookup([
    { displayName: 'Bob Example-Other', email: 'other@example.com' },
    { displayName: 'Bob Example', email: 'bob@example.com', jobTitle: 'Engineer', department: 'Platform', companyName: 'Example Corp' },
  ], hrworks)('Bob Example');
  assert.equal(info.found, true);
  assert.equal(info.email, 'bob@example.com');
  assert.equal(info.company, 'Example Corp');
  assert.equal(info.presence, null, 'no presence without an MRI');
  assert.deepEqual(info.absence, { state: 'away', current: { category: 'Vacation', startDate: '2026-11-24', endDate: '2026-11-28' } });
});

test('person info: an ambiguous name is not guessed, a single result is taken, HR WORKS failures read as unavailable', async () => {
  const twins = await lookup([{ displayName: 'Bob Example', mri: '8:orgid:a' }, { displayName: 'Bob Example', mri: '8:orgid:b' }])('Bob Example');
  assert.equal(twins.found, false);
  assert.match(twins.reason, /Several people/);
  assert.equal((await lookup([])('Nobody Example')).found, false);
  const failing = { findPersonAbsence: async () => { throw new Error('down'); } };
  const single = await lookup([{ displayName: 'Robert Example', email: 'r@example.com' }], failing)('Bob Example');
  assert.equal(single.found, true);
  assert.deepEqual(single.absence, { state: 'unavailable' });
});

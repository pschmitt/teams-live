import test from 'node:test';
import assert from 'node:assert/strict';
import { OpsGenieClient } from '../src/opsgenie.mjs';

test('fetchShifts reads the final timeline, keeps users only and merges adjacent periods of one person', async () => {
  const client = new OpsGenieClient({ on_call_key: 'k', base_url: 'https://api.example.com/v2' });
  const original = globalThis.fetch;
  let asked = '';
  globalThis.fetch = async (url) => {
    asked = String(url);
    return Response.json({ data: { finalTimeline: { rotations: [
      { periods: [
        { startDate: '2026-12-01T08:00:00Z', endDate: '2026-12-02T08:00:00Z', recipient: { type: 'user', name: 'alice@example.com' } },
        { startDate: '2026-12-02T08:00:00Z', endDate: '2026-12-03T08:00:00Z', recipient: { type: 'user', name: 'alice@example.com' } },
        { startDate: '2026-12-03T08:00:00Z', endDate: '2026-12-04T08:00:00Z', recipient: { type: 'team', name: 'ops' } },
      ] },
      { periods: [{ startDate: '2026-11-30T08:00:00Z', endDate: '2026-12-01T08:00:00Z', recipient: { type: 'user', name: 'bob@example.com' } }] },
    ] } } });
  };
  try {
    const shifts = await client.fetchShifts('k', 'sched-1');
    assert.match(asked, /\/schedules\/sched-1\/timeline\?intervalUnit=weeks&interval=4$/);
    assert.deepEqual(shifts, [
      { start: '2026-11-30T08:00:00Z', end: '2026-12-01T08:00:00Z', recipient: 'bob@example.com' },
      { start: '2026-12-01T08:00:00Z', end: '2026-12-03T08:00:00Z', recipient: 'alice@example.com' },
    ]);
    assert.deepEqual(await client.fetchShifts('', 'sched-1'), [], 'no key, no request');
  } finally { globalThis.fetch = original; }
});

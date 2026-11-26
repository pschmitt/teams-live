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

test('alertAction acknowledges with the first key OpsGenie accepts and follows the request to its result', async () => {
  const client = new OpsGenieClient({ on_call_key: 'k1', support_key: 'k2', base_url: 'https://api.example.com/v2' });
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), key: options.headers?.Authorization, body: options.body });
    if (String(url).includes('/alerts/requests/')) return Response.json({ data: { success: true, status: 'Acknowledged' } });
    if (options.headers?.Authorization === 'GenieKey k1') return new Response('{}', { status: 403 });
    return Response.json({ requestId: 'r1' }, { status: 202 });
  };
  try {
    const r = await client.alertAction('a1', 'acknowledge', { user: 'Alice Example', note: 'by Alice' });
    assert.deepEqual(r, { status: 'done', text: '' });
    assert.match(calls[1].url, /\/alerts\/a1\/acknowledge\?identifierType=id$/);
    assert.equal(calls[1].key, 'GenieKey k2', 'the queue key that may act');
    assert.deepEqual(JSON.parse(calls[1].body), { user: 'Alice Example', source: 'teams-live dashboard', note: 'by Alice' });
    await assert.rejects(client.alertAction('a1', 'delete'), /invalid alert action/);
  } finally { globalThis.fetch = original; }
});

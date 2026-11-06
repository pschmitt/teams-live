import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { HRWorksClient, getInclusiveDateRange } from '../src/hrworks.mjs';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('getInclusiveDateRange subtracts 1 second for midnight ends', () => {
  const range1 = getInclusiveDateRange('2026-11-06T00:00:00.0+01:00', '2026-11-07T00:00:00.0+01:00');
  assert.equal(range1.start, '2026-11-06');
  assert.equal(range1.end, '2026-11-06');

  const range2 = getInclusiveDateRange('2026-11-06T00:00:00.0+01:00', '2026-11-08T00:00:00.0+01:00');
  assert.equal(range2.start, '2026-11-06');
  assert.equal(range2.end, '2026-11-07');
});

test('HRWorksClient unwraps service_response and matches employee absence', async () => {
  const mockClient = new HRWorksClient({ url: 'https://ha.brkn.lol', token: 'fake-token' });

  globalThis.fetch = async (url) => {
    assert.match(url, /\/api\/services\/hrworks\/get_team_absences/);
    return {
      ok: true,
      json: async () => ({
        changed_states: [],
        service_response: {
          employees: [
            { id: '0-1', rawName: 'Schmitt, Philipp', displayName: 'Philipp Schmitt' },
          ],
          absences: [
            {
              resourceId: '0-1',
              category: 'Ausgleich Ü',
              start: '2026-11-06T00:00:00.0+01:00',
              end: '2026-11-07T00:00:00.0+01:00',
              status: 'Checked, OK',
            },
          ],
        },
      }),
    };
  };

  const person = { displayName: 'Philipp Schmitt', email: 'philipp.schmitt@wiit.cloud' };
  const res = await mockClient.findPersonAbsence(person);

  assert.ok(res);
  assert.equal(res.employee.displayName, 'Philipp Schmitt');
  assert.ok(res.absence);
  assert.equal(res.absence.category, 'Ausgleich Ü');
  assert.equal(res.absence.startDate, '2026-11-06');
  assert.equal(res.absence.endDate, '2026-11-06');
});

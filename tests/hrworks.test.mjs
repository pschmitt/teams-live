import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

import { HRWorksClient, getInclusiveDateRange } from '../src/hrworks.mjs';
import { formatWhereisCard } from '../src/users.mjs';

const originalFetch = globalThis.fetch;

// The fixtures describe absences on 2026-11-06, and HRWorksClient compares them
// with the current date in Berlin, so pin the clock to that day.
const FIXTURE_NOW = new Date('2026-11-06T12:00:00+01:00');
const pinClock = () => mock.timers.enable({ apis: ['Date'], now: FIXTURE_NOW });

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.timers.reset();
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
  pinClock();
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
            { id: '0-2', rawName: 'Herzig, Nils', displayName: 'Nils Herzig' },
          ],
          absences: [
            {
              resourceId: '0-1',
              rawName: 'Schmitt, Philipp',
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

  // Test employee with no absence
  const person2 = { displayName: 'Nils Herzig', email: 'nils.herzig@wiit.cloud' };
  const res2 = await mockClient.findPersonAbsence(person2);
  assert.ok(res2);
  assert.equal(res2.employee.displayName, 'Nils Herzig');
  assert.equal(res2.absence, null);
  assert.equal(res2.upcomingAbsence, null);

  // Test employee not in team calendar
  const person3 = { displayName: 'Jane Doe', email: 'jane.doe@wiit.cloud' };
  const res3 = await mockClient.findPersonAbsence(person3);
  assert.ok(res3);
  assert.equal(res3.employee, null);
  assert.equal(res3.reason, 'not_found');
});

test('HRWorksClient prefetchAllAbsences batches organizational units and serves findPersonAbsence from memory', async () => {
  pinClock();
  const mockClient = new HRWorksClient({ url: 'https://ha.brkn.lol', token: 'fake-token', batchSize: 2 });
  const calls = [];

  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    calls.push({ url, body });

    if (url.includes('get_team_absences')) {
      return {
        ok: true,
        json: async () => ({
          service_response: {
            employees: [{ id: 'Schmitt, Philipp', rawName: 'Schmitt, Philipp', displayName: 'Philipp Schmitt' }],
            absences: [],
          },
        }),
      };
    }

    if (url.includes('get_company_absences')) {
      if (!body.units || body.units.length === 0) {
        return {
          ok: true,
          json: async () => ({
            service_response: {
              available_organizational_units: ['OpenStack', 'K8s', 'Unix CC'],
              employees: [],
              absences: [],
            },
          }),
        };
      }
      if (body.units.includes('OpenStack')) {
        return {
          ok: true,
          json: async () => ({
            service_response: {
              available_organizational_units: ['OpenStack', 'K8s', 'Unix CC'],
              employees: [
                {
                  id: 'Seelbach, David',
                  rawName: 'Seelbach, David',
                  displayName: 'David Seelbach',
                  firstName: 'David',
                  lastName: 'Seelbach',
                  unit: 'OpenStack',
                },
              ],
              absences: [
                {
                  employee: 'David Seelbach',
                  rawName: 'Seelbach, David',
                  resourceId: 'Seelbach, David',
                  category: 'Absent',
                  start: '2026-09-27T00:00:00.0+02:00',
                  end: '2026-11-07T00:00:00.0+01:00',
                  status: '',
                  unit: 'OpenStack',
                },
              ],
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          service_response: {
            available_organizational_units: ['OpenStack', 'K8s', 'Unix CC'],
            employees: [
              {
                id: 'Doe, John',
                rawName: 'Doe, John',
                displayName: 'John Doe',
                firstName: 'John',
                lastName: 'Doe',
                unit: 'Unix CC',
              },
            ],
            absences: [],
          },
        }),
      };
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  await mockClient.prefetchAllAbsences();
  // 1 team call + 1 discovery call + 2 batch calls (size 2 for 3 units) = 4 calls
  assert.equal(calls.length, 4);

  const countBeforeLookup = calls.length;
  const david = await mockClient.findPersonAbsence({
    displayName: 'David Seelbach',
    givenName: 'David',
    surname: 'Seelbach',
    email: 'david.seelbach@wiit.cloud',
  });
  // Resolved straight from prefetched cache without extra HTTP calls
  assert.equal(calls.length, countBeforeLookup);
  assert.ok(david);
  assert.equal(david.employee.displayName, 'David Seelbach');
  assert.ok(david.absence);
  assert.equal(david.absence.category, 'Absent');
  assert.equal(david.absence.startDate, '2026-09-27');
  assert.equal(david.absence.endDate, '2026-11-06');
});

test('formatWhereisCard formats HRworks line for active, none, upcoming, and error', () => {
  const person = { displayName: 'Test User', email: 'test@wiit.cloud' };
  const presence = { availability: 'Available', activity: 'Available' };

  // 1. Active today
  const card1 = formatWhereisCard(person, presence, {
    hrworksAbsence: {
      absence: {
        category: 'Ausgleich Ü',
        isToday: true,
        startDate: '2026-11-06',
        endDate: '2026-11-06',
        status: 'Checked, OK',
      },
    },
  });
  assert.match(card1, /🟢 \*\*Status\*\*: \*\*Available\*\*/);
  assert.match(card1, /\*\*HRworks Today\*\*: \*\*Ausgleich Ü\*\* \[2026-11-06\] \(Checked, OK\)/);

  // 2. None registered (present)
  const card2 = formatWhereisCard(person, presence, {
    hrworksAbsence: {
      employee: { displayName: 'Test User' },
      absence: null,
      upcomingAbsence: null,
    },
  });
  assert.match(card2, /🏢 \*\*HRworks\*\*: Present \(not on leave\/sick\)/);

  // 3. Upcoming absence
  const card3 = formatWhereisCard(person, presence, {
    hrworksAbsence: {
      employee: { displayName: 'Test User' },
      absence: null,
      upcomingAbsence: {
        category: 'Urlaub',
        startDate: '2026-11-10',
        endDate: '2026-11-12',
      },
    },
  });
  assert.match(card3, /🏢 \*\*HRworks\*\*: None today \(🌴 Upcoming: \*\*Urlaub\*\* \[2026-11-10 – 2026-11-12\]\)/);

  // 4. Lookup error
  const card4 = formatWhereisCard(person, presence, {
    hrworksAbsence: {
      error: 'Connection timed out',
    },
  });
  assert.match(card4, /⚠️ \*\*HRworks\*\*: Lookup failed \(Connection timed out\)/);

  // 5. Not found in calendar
  const card5 = formatWhereisCard(person, presence, {
    hrworksAbsence: {
      reason: 'not_found',
    },
  });
  assert.match(card5, /🏢 \*\*HRworks\*\*: Person not found in HRworks calendar/);
});

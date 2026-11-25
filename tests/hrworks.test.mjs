import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

import { HRWorksClient, getInclusiveDateRange, summarizeErrorBody } from '../src/hrworks.mjs';
import { formatWhereisCard } from '../src/users.mjs';
import { HealthMonitor } from '../src/health.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';

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
            { id: '0-1', rawName: 'Example, Alice', displayName: 'Alice Example' },
            { id: '0-2', rawName: 'Example, Bob', displayName: 'Bob Example' },
          ],
          absences: [
            {
              resourceId: '0-1',
              rawName: 'Example, Alice',
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

  const person = { displayName: 'Alice Example', email: 'alice@example.com' };
  const res = await mockClient.findPersonAbsence(person);

  assert.ok(res);
  assert.equal(res.employee.displayName, 'Alice Example');
  assert.ok(res.absence);
  assert.equal(res.absence.category, 'Ausgleich Ü');
  assert.equal(res.absence.startDate, '2026-11-06');
  assert.equal(res.absence.endDate, '2026-11-06');

  // Test employee with no absence
  const person2 = { displayName: 'Bob Example', email: 'bob@example.com' };
  const res2 = await mockClient.findPersonAbsence(person2);
  assert.ok(res2);
  assert.equal(res2.employee.displayName, 'Bob Example');
  assert.equal(res2.absence, null);
  assert.equal(res2.upcomingAbsence, null);

  // Test employee not in team calendar
  const person3 = { displayName: 'Jane Doe', email: 'jane.doe@example.com' };
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
            employees: [{ id: 'Example, Alice', rawName: 'Example, Alice', displayName: 'Alice Example' }],
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
              available_organizational_units: ['Team A', 'Team B', 'Team C'],
              employees: [],
              absences: [],
            },
          }),
        };
      }
      if (body.units.includes('Team A')) {
        return {
          ok: true,
          json: async () => ({
            service_response: {
              available_organizational_units: ['Team A', 'Team B', 'Team C'],
              employees: [
                {
                  id: 'Example, Carol',
                  rawName: 'Example, Carol',
                  displayName: 'Carol Example',
                  firstName: 'David',
                  lastName: 'Example',
                  unit: 'Team A',
                },
              ],
              absences: [
                {
                  employee: 'Carol Example',
                  rawName: 'Example, Carol',
                  resourceId: 'Example, Carol',
                  category: 'Absent',
                  start: '2026-09-27T00:00:00.0+02:00',
                  end: '2026-11-07T00:00:00.0+01:00',
                  status: '',
                  unit: 'Team A',
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
            available_organizational_units: ['Team A', 'Team B', 'Team C'],
            employees: [
              {
                id: 'Doe, John',
                rawName: 'Doe, John',
                displayName: 'John Doe',
                firstName: 'John',
                lastName: 'Doe',
                unit: 'Team C',
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
    displayName: 'Carol Example',
    givenName: 'David',
    surname: 'Example',
    email: 'carol@example.com',
  });
  // Resolved straight from prefetched cache without extra HTTP calls
  assert.equal(calls.length, countBeforeLookup);
  assert.ok(david);
  assert.equal(david.employee.displayName, 'Carol Example');
  assert.ok(david.absence);
  assert.equal(david.absence.category, 'Absent');
  assert.equal(david.absence.startDate, '2026-09-27');
  assert.equal(david.absence.endDate, '2026-11-06');
});

test('formatWhereisCard formats HRworks line for active, none, upcoming, and error', () => {
  const person = { displayName: 'Test User', email: 'test@example.com' };
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

test('prefetchAllAbsences stops at a failed batch and resumes there on the next run', async () => {
  const client = new HRWorksClient({ url: 'https://ha.example.com', token: 'fake-token', batchSize: 2 });
  const units = ['A', 'B', 'C', 'D', 'E'];
  const companyCalls = [];
  let failBatchWith = 'C';

  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    if (url.includes('get_team_absences')) {
      return { ok: true, json: async () => ({ service_response: { employees: [], absences: [] } }) };
    }
    if (!body.units || body.units.length === 0) {
      return {
        ok: true,
        json: async () => ({ service_response: { available_organizational_units: units, employees: [], absences: [] } }),
      };
    }
    companyCalls.push(body.units.join(','));
    if (failBatchWith && body.units.includes(failBatchWith)) {
      return { ok: false, status: 504, text: async () => '<html><head><title>504 Gateway Time-out</title></head></html>' };
    }
    return { ok: true, json: async () => ({ service_response: { employees: [], absences: [] } }) };
  };

  await client.prefetchAllAbsences();
  // A,B succeeds, C,D fails, E is never tried and the prefetch is not done.
  assert.deepEqual(companyCalls, ['A,B', 'C,D']);
  assert.equal(client.companyData.lastFullPrefetchAt, 0);
  assert.equal(client.companyData.resumeIndex, 2);

  failBatchWith = null;
  await client.prefetchAllAbsences();
  assert.deepEqual(companyCalls, ['A,B', 'C,D', 'C,D', 'E']);
  assert.ok(client.companyData.lastFullPrefetchAt > 0);
  assert.equal(client.companyData.resumeIndex, 0);
});

test('summarizeErrorBody keeps error logs to one short line', () => {
  const html = '<html>\n<head><title>504 Gateway Time-out</title></head>\n<body><center><h1>504</h1></center></body></html>';
  assert.equal(summarizeErrorBody(html), '504 Gateway Time-out');
  assert.equal(summarizeErrorBody('{"message":"calendar_failed"}'), '{"message":"calendar_failed"}');
  assert.equal(summarizeErrorBody('x'.repeat(300)).length, 201);
});

test('HRWorksClient isConfigured, checkConnection, and getStats', async () => {
  const unconfigured = new HRWorksClient({ url: 'https://ha.brkn.lol' });
  assert.equal(unconfigured.isConfigured(), false);
  const unconfCheck = await unconfigured.checkConnection();
  assert.equal(unconfCheck.ok, false);
  assert.equal(unconfCheck.status, 'unconfigured');

  let authErrorMsg = null;
  let successCount = 0;
  const client = new HRWorksClient({
    url: 'https://ha.brkn.lol',
    token: 'test-token',
    onAuthError: (msg) => { authErrorMsg = msg; },
    onSuccess: () => { successCount++; },
  });

  assert.equal(client.isConfigured(), true);
  const stats = client.getStats();
  assert.equal(stats.configured, true);
  assert.equal(stats.url, 'https://ha.brkn.lol');
  assert.equal(stats.employees, 0);

  // 1. Successful connection check
  globalThis.fetch = async (url, opts) => {
    assert.equal(url, 'https://ha.brkn.lol/api/');
    assert.equal(opts.headers.Authorization, 'Bearer test-token');
    return { ok: true, status: 200, json: async () => ({ message: 'API running.' }) };
  };

  const okCheck = await client.checkConnection();
  assert.equal(okCheck.ok, true);
  assert.equal(okCheck.status, 'ok');
  assert.equal(successCount, 1);

  // 2. Auth failure
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => '401: Unauthorized',
  });

  const authCheck = await client.checkConnection();
  assert.equal(authCheck.ok, false);
  assert.equal(authCheck.status, 'auth_expired');
  assert.match(authErrorMsg, /Home Assistant HTTP 401/);

  // 3. Network error
  globalThis.fetch = async () => {
    throw new Error('fetch failed (ECONNREFUSED)');
  };

  const errCheck = await client.checkConnection();
  assert.equal(errCheck.ok, false);
  assert.equal(errCheck.status, 'error');
  assert.match(errCheck.error, /fetch failed/);
});

test('HealthMonitor tracks homeassistant service and watcher.getConnectorsStatus includes Home Assistant', async () => {
  const hrworks = new HRWorksClient({
    url: 'https://ha.brkn.lol',
    token: 'test-token',
  });
  hrworks.companyData.employeesByRaw.set('1', { displayName: 'Alice' });
  hrworks.companyData.absencesByKey.set('1', { category: 'Urlaub' });
  hrworks.companyData.availableUnits = ['Engineering'];
  hrworks.companyData.lastFullPrefetchAt = Date.now() - 5000;

  const health = new HealthMonitor({
    hrworks,
  });

  const h1 = health.getHealth();
  assert.equal(h1.services.homeassistant.status, 'ok');

  health.setServiceStatus('HomeAssistant', false, '401 Unauthorized');
  const h2 = health.getHealth();
  assert.equal(h2.services.homeassistant.status, 'auth_expired');

  health.setServiceStatus('hrworks', true);
  const h3 = health.getHealth();
  assert.equal(h3.services.homeassistant.status, 'ok');

  const watcher = new MergeRequestWatcher({
    config: { gitlab: {}, conversations: [] },
    hrworks,
    health,
  });

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ message: 'API running.' }),
  });

  const conn = await watcher.getConnectorsStatus();
  assert.ok(conn.homeassistant);
  assert.equal(conn.homeassistant.name, 'Home Assistant (HR works)');
  assert.equal(conn.homeassistant.configured, true);
  assert.equal(conn.homeassistant.status, 'ok');
  assert.equal(conn.homeassistant.url, 'https://ha.brkn.lol');
  assert.match(conn.homeassistant.details, /1 employees, 1 absences, 1 units/);

  const cacheLines = watcher.getPrecomputeCacheLines();
  assert.equal(cacheLines.length, 5);
  assert.match(cacheLines[0], /`\/mrs`/);
  assert.match(cacheLines[1], /`\/alerts`/);
  assert.match(cacheLines[2], /`\/sprint`/);
  assert.match(cacheLines[3], /`\/meetings`/);
  assert.match(cacheLines[4], /`\/whereis` \(HR works\): \d+s ago \(1 employees, 1 absences\)/);
});

test('findPersonAbsence offline: answers from the prefetched company data and never calls Home Assistant', async () => {
  const client = new HRWorksClient({ url: 'https://ha.example.com', token: 't' });
  client.callService = async () => { throw new Error('must not be called'); };
  assert.equal((await client.findPersonAbsence({ displayName: 'Bob Example' }, { offline: true })).reason, 'calendar_unavailable', 'nothing prefetched yet');
  client.mergeIntoCompanyCache({
    employees: [{ id: 'e1', rawName: 'Example, Bob', displayName: 'Bob Example' }],
    absences: [{ resourceId: 'e1', start: '2000-01-01', end: '2999-01-01', category: 'Vacation' }],
  });
  const found = await client.findPersonAbsence({ displayName: 'Bob Example' }, { offline: true });
  assert.equal(found.absence?.category, 'Vacation');
  assert.equal((await client.findPersonAbsence({ displayName: 'Nobody Example' }, { offline: true })).reason, 'not_found');
});

test('the HR WORKS calendars survive a restart through the cache file, and one read is shared', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hrworks-'));
  const file = path.join(dir, 'hrworks-cache.json');
  try {
    let calls = 0;
    let release;
    const first = new HRWorksClient({ url: 'https://ha.example.com', token: 't', cache_file: file });
    first.callService = () => { calls++; return new Promise((resolve) => { release = resolve; }); };
    const a = first.getTeamAbsences();
    const b = first.getTeamAbsences();
    release({ employees: [{ id: 'e1', rawName: 'Example, Bob', displayName: 'Bob Example' }], absences: [{ resourceId: 'e1', start: '2999-01-01', end: '2999-01-02', category: 'Vacation' }] });
    assert.equal(await a, await b);
    assert.equal(calls, 1, 'one request for both callers');
    first.saveCacheFile();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const second = new HRWorksClient({ url: 'https://ha.example.com', token: 't', cache_file: file });
    second.callService = async () => { throw new Error('must not be called'); };
    assert.equal(second.cachedTeamAbsences().data.employees[0].displayName, 'Bob Example');
    assert.equal((await second.findPersonAbsence({ displayName: 'Bob Example' }, { offline: true })).upcomingAbsence?.category, 'Vacation');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HR WORKS: the team calendar is refreshed hourly, the company every six hours; a failed or empty read keeps serving the saved one', async () => {
  const client = new HRWorksClient({ url: 'https://ha.example.com', token: 't' });
  assert.equal(client.cacheTtlMs, 60 * 60 * 1000);
  assert.equal(client.companyTtlMs, 6 * 60 * 60 * 1000);
  const good = { employees: [{ id: 'e1', rawName: 'Example, Bob', displayName: 'Bob Example' }], absences: [] };
  let calls = 0;
  let answer = good;
  client.callService = async () => { calls++; return answer; };
  assert.equal(await client.getTeamAbsences(), good);
  assert.equal(await client.getTeamAbsences(), good);
  assert.equal(calls, 1, 'fresh: no second read');
  client.cache.get('team:current').expiresAt = 0;
  answer = { employees: [], absences: [] };
  assert.equal(await client.getTeamAbsences(), good, 'an empty answer does not replace the saved calendar');
  assert.equal(calls, 2);
  assert.equal(client.cache.get('team:current').data, good);
  answer = null;
  assert.equal(await client.getTeamAbsences(), good, 'no new read right after a failure');
  assert.equal(calls, 2);
  client.failedAt.set('team:current', Date.now() - 16 * 60 * 1000);
  assert.equal(await client.getTeamAbsences(), good, 'a failed retry still serves the saved calendar');
  assert.equal(calls, 3);
});

test('team leave: the team from the team calendar, their absences from everything HR WORKS answered', () => {
  const client = new HRWorksClient({ url: 'https://ha.example.com', token: 't' });
  const team = {
    employees: [{ id: 't1', rawName: 'Example, Mark', displayName: 'Mark Example' }, { id: 't2', rawName: 'Example, Alice', displayName: 'Alice Example' }],
    absences: [{ resourceId: 't1', start: '2026-11-27T00:00:00', end: '2026-11-28T00:00:00', category: 'Absent' }],
  };
  client.mergeIntoCompanyCache(team);
  // The company calendar (another read) knows the longer leave the team view does not reach.
  client.mergeIntoCompanyCache({
    employees: [{ id: 'c9', rawName: 'Example, Mark', displayName: 'Mark Example' }],
    absences: [
      { resourceId: 'c9', start: '2026-11-30T00:00:00', end: '2026-12-19T00:00:00', category: 'Absent' },
      { employee: 'Mark Example', start: '2026-11-27T00:00:00', end: '2026-11-28T00:00:00', category: 'Absent' },
    ],
  });
  const { team: names, absences } = client.teamLeave(team, '2026-11-25', '2026-12-23');
  assert.deepEqual(names, ['Alice Example', 'Mark Example']);
  assert.deepEqual(absences.map((a) => `${a.name} ${a.startDate}..${a.endDate}`), [
    'Mark Example 2026-11-27..2026-11-27',
    'Mark Example 2026-11-30..2026-12-18',
  ], 'both absences, each once');
  assert.deepEqual(client.teamLeave(team, '2026-12-20', '2026-12-31').absences, [], 'only the window asked for');
});

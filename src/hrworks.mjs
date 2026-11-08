import fs from 'node:fs';
import { normalizeName } from './users.mjs';

/**
 * Returns inclusive date strings (YYYY-MM-DD) for FullCalendar events where
 * all-day event end dates are midnight (exclusive next day).
 */
export function getInclusiveDateRange(startIso, endIso) {
  if (!startIso) return { start: '', end: '' };
  const startStr = startIso.split('T')[0];
  if (!endIso) return { start: startStr, end: startStr };

  let endDate = new Date(endIso);
  if (endIso.includes('T00:00:00')) {
    endDate = new Date(endDate.getTime() - 1000);
  }
  const endStr = endDate.toISOString().split('T')[0];
  return { start: startStr, end: endStr };
}

// One line for the log: Home Assistant answers with JSON, the proxy in front of
// it with an HTML error page.
export function summarizeErrorBody(text) {
  const raw = String(text ?? '');
  const title = raw.match(/<title>([^<]*)<\/title>/i);
  const flat = (title ? title[1] : raw.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

export class HRWorksClient {
  constructor(config = {}) {
    this.url = (config.url || 'https://ha.brkn.lol').replace(/\/+$/, '');
    this.token = config.token || null;
    this.tokenFile = config.token_file || null;
    this.cache = new Map();
    this.cacheTtlMs = 10 * 60 * 1000; // 10 minutes cache for team/single-OU
    this.companyTtlMs = 30 * 60 * 1000; // 30 minutes cache for full company prefetch
    // Each organizational unit costs the HR WORKS integration a page load, and a
    // request that runs past the reverse proxy's read timeout (60s) fails as a
    // 504, so keep batches small.
    this.batchSize = Number(config.hrworks_batch_size ?? config.batchSize) || 4;
    this.companyData = {
      employeesByRaw: new Map(),
      absencesByKey: new Map(),
      availableUnits: [],
      lastFullPrefetchAt: 0,
      lastTeamPrefetchAt: 0,
      // Batch to continue with after a failed prefetch.
      resumeIndex: 0,
      loadingPromise: null,
    };
  }

  getToken() {
    if (!this.token && this.tokenFile) {
      try {
        if (fs.existsSync(this.tokenFile)) {
          this.token = fs.readFileSync(this.tokenFile, 'utf8').trim();
        }
      } catch (err) {
        console.warn(`[HRWorksClient] Could not read token file ${this.tokenFile}: ${err.message}`);
      }
    }
    return this.token;
  }

  async callService(service, data = {}, { timeoutMs = 60000 } = {}) {
    const token = this.getToken();
    if (!token) {
      console.warn('[HRWorksClient] No Home Assistant token configured');
      return null;
    }

    const endpoint = `${this.url}/api/services/hrworks/${service}?return_response=true`;
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        console.warn(`[HRWorksClient] Service ${service} returned ${resp.status}: ${summarizeErrorBody(text)}`);
        return null;
      }

      const json = await resp.json();
      return json.service_response || json.response || json;
    } catch (err) {
      console.warn(`[HRWorksClient] Call to ${service} failed: ${err.message}`);
      return null;
    }
  }

  mergeIntoCompanyCache(data) {
    if (!data) return;
    if (Array.isArray(data.available_organizational_units) && data.available_organizational_units.length > 0) {
      this.companyData.availableUnits = data.available_organizational_units;
    }
    if (Array.isArray(data.employees)) {
      for (const emp of data.employees) {
        const key = emp.rawName || emp.displayName || emp.id;
        if (key && emp.rawName && emp.rawName.includes(',')) {
          this.companyData.employeesByRaw.set(key, emp);
        } else if (key && emp.displayName && !this.companyData.employeesByRaw.has(key)) {
          this.companyData.employeesByRaw.set(key, emp);
        }
      }
    }
    if (Array.isArray(data.absences)) {
      for (const ab of data.absences) {
        const key = `${ab.rawName || ab.employee || ab.resourceId}|${ab.start}|${ab.end}|${ab.category}`;
        this.companyData.absencesByKey.set(key, ab);
      }
    }
  }

  getAggregatedCompanyData() {
    if (this.companyData.employeesByRaw.size === 0) return null;
    return {
      employees: Array.from(this.companyData.employeesByRaw.values()),
      absences: Array.from(this.companyData.absencesByKey.values()),
    };
  }

  async getTeamAbsences({ organizationalUnit = null, date = null } = {}) {
    const cacheKey = `${organizationalUnit || 'team'}:${date || 'current'}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }

    const payload = {};
    if (organizationalUnit) payload.organizational_unit = organizationalUnit;
    if (date) payload.date = date;

    const data = await this.callService('get_team_absences', payload, { timeoutMs: 90000 });
    if (data && Array.isArray(data.employees)) {
      this.cache.set(cacheKey, {
        data,
        expiresAt: Date.now() + this.cacheTtlMs,
      });
      this.mergeIntoCompanyCache(data);
      return data;
    }
    return null;
  }

  async getCompanyAbsences({ units = [] } = {}) {
    const payload = {};
    if (Array.isArray(units) && units.length > 0) {
      payload.units = units;
    }
    const data = await this.callService('get_company_absences', payload, { timeoutMs: 180000 });
    if (data) {
      this.mergeIntoCompanyCache(data);
      return data;
    }
    return null;
  }

  /**
   * Periodically prefetches team absences and batches of organizational units across
   * the company so `/whereis <anyone>` resolves immediately from memory.
   */
  async prefetchAllAbsences({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.companyData.lastFullPrefetchAt && now - this.companyData.lastFullPrefetchAt < this.companyTtlMs) {
      // Still refresh immediate team if its 10m TTL expired
      if (now - this.companyData.lastTeamPrefetchAt >= this.cacheTtlMs) {
        await this.getTeamAbsences().catch(() => null);
        this.companyData.lastTeamPrefetchAt = Date.now();
      }
      return this.getAggregatedCompanyData();
    }

    if (this.companyData.loadingPromise) {
      return await this.companyData.loadingPromise;
    }

    this.companyData.loadingPromise = (async () => {
      try {
        // 1. Always fetch immediate team first (fast)
        await this.getTeamAbsences().catch(() => null);
        this.companyData.lastTeamPrefetchAt = Date.now();

        // 2. Discover organizational units if needed
        let units = this.companyData.availableUnits;
        if (!Array.isArray(units) || units.length === 0) {
          const disc = await this.getCompanyAbsences({ units: [] });
          units = disc?.available_organizational_units || [];
        }

        if (!Array.isArray(units) || units.length === 0) {
          return this.getAggregatedCompanyData();
        }

        // 3. Fetch organizational units in batches. Stop at the first failure (the
        // integration's browser is usually down then, and the remaining batches
        // would fail the same way) and resume from that batch on the next run.
        const start = this.companyData.resumeIndex < units.length ? this.companyData.resumeIndex : 0;
        for (let i = start; i < units.length; i += this.batchSize) {
          const batch = units.slice(i, i + this.batchSize);
          if (!(await this.getCompanyAbsences({ units: batch }))) {
            this.companyData.resumeIndex = i;
            console.warn(
              `[HRWorksClient] Company prefetch stopped at units ${i + 1}-${i + batch.length} of ${units.length}; resuming there next run`
            );
            return this.getAggregatedCompanyData();
          }
        }

        this.companyData.resumeIndex = 0;
        this.companyData.lastFullPrefetchAt = Date.now();
        return this.getAggregatedCompanyData();
      } finally {
        this.companyData.loadingPromise = null;
      }
    })();

    return await this.companyData.loadingPromise;
  }

  /**
   * Matches a person from Teams directory to an HRworks employee and determines
   * their active or upcoming absence.
   */
  async findPersonAbsence(person, { organizationalUnit = null } = {}) {
    if (!person) return null;

    let calData = null;
    let employee = null;

    // 1. If a specific organizationalUnit wasn't forced, check the prefetched company-wide cache first!
    if (!organizationalUnit) {
      const companyAgg = this.getAggregatedCompanyData();
      if (companyAgg) {
        employee = this.matchEmployee(person, companyAgg.employees);
        if (employee) {
          calData = companyAgg;
        }
      }
    }

    // 2. Fetch team absences (or explicit organizationalUnit) if not already matched
    if (!employee) {
      const teamData = await this.getTeamAbsences({ organizationalUnit });
      if (teamData) {
        calData = this.getAggregatedCompanyData() || teamData;
        employee = this.matchEmployee(person, calData.employees);
      }
    }

    // 3. If still not found and person has department, try querying that department via getCompanyAbsences
    if (!employee && !organizationalUnit && person.department) {
      const deptData = await this.getCompanyAbsences({ units: [person.department] });
      if (deptData && Array.isArray(deptData.employees) && deptData.employees.length > 0) {
        calData = this.getAggregatedCompanyData() || deptData;
        employee = this.matchEmployee(person, calData.employees);
      } else {
        const ouData = await this.getTeamAbsences({ organizationalUnit: person.department });
        if (ouData) {
          calData = this.getAggregatedCompanyData() || ouData;
          employee = this.matchEmployee(person, calData.employees);
        }
      }
    }

    if (!calData || !Array.isArray(calData.absences)) {
      return {
        checked: true,
        employee: employee || null,
        absence: null,
        upcomingAbsence: null,
        allAbsences: [],
        reason: 'calendar_unavailable',
      };
    }

    if (!employee) {
      return {
        checked: true,
        employee: null,
        absence: null,
        upcomingAbsence: null,
        allAbsences: [],
        reason: 'not_found',
      };
    }

    // 4. Find absences for this employee
    const empAbsences = calData.absences.filter((a) => {
      if (a.resourceId && a.resourceId === employee.id) return true;
      if (a.rawName && a.rawName === employee.rawName) return true;
      if (a.employee && normalizeName(a.employee) === normalizeName(employee.displayName)) return true;
      return false;
    });

    if (empAbsences.length === 0) {
      return {
        checked: true,
        employee,
        absence: null,
        upcomingAbsence: null,
        allAbsences: [],
      };
    }

    // 5. Calculate today in Berlin time (YYYY-MM-DD)
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());

    let activeToday = null;
    let upcoming = null;

    for (const raw of empAbsences) {
      const { start, end } = getInclusiveDateRange(raw.start, raw.end);
      const isToday = todayStr >= start && todayStr <= end;
      const isUpcoming = start > todayStr;

      const item = {
        ...raw,
        startDate: start,
        endDate: end,
        isToday,
      };

      if (isToday && !activeToday) {
        activeToday = item;
      } else if (isUpcoming) {
        if (!upcoming || item.startDate < upcoming.startDate) {
          upcoming = item;
        }
      }
    }

    return {
      checked: true,
      employee,
      absence: activeToday || null,
      upcomingAbsence: upcoming || null,
      allAbsences: empAbsences,
    };
  }

  matchEmployee(person, employees) {
    if (!Array.isArray(employees) || employees.length === 0) return null;

    const pDisplayNorm = normalizeName(person.displayName);
    const pGivenNorm = normalizeName(person.givenName);
    const pSurNorm = normalizeName(person.surname);

    // Direct display name match
    if (pDisplayNorm) {
      const match = employees.find((e) => normalizeName(e.displayName) === pDisplayNorm);
      if (match) return match;
    }

    // Surname and first name match
    if (pSurNorm && pGivenNorm) {
      const match = employees.find((e) => {
        const eSur = normalizeName(e.lastName);
        const eGiven = normalizeName(e.firstName);
        if (eSur === pSurNorm && (eGiven.startsWith(pGivenNorm) || pGivenNorm.startsWith(eGiven))) {
          return true;
        }
        return false;
      });
      if (match) return match;
    }

    // Check if employee name includes both first and last name
    if (pSurNorm && pGivenNorm) {
      const match = employees.find((e) => {
        const fullNorm = normalizeName(e.displayName || e.rawName);
        return fullNorm.includes(pSurNorm) && fullNorm.includes(pGivenNorm);
      });
      if (match) return match;
    }

    return null;
  }
}

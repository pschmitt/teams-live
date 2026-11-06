import fs from 'node:fs';
import { normalizeName, stripDiacritics } from './users.mjs';

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

export class HRWorksClient {
  constructor(config = {}) {
    this.url = (config.url || 'https://ha.brkn.lol').replace(/\/+$/, '');
    this.token = config.token || null;
    this.tokenFile = config.token_file || null;
    this.cache = new Map();
    this.cacheTtlMs = 10 * 60 * 1000; // 10 minutes cache
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

  async callService(service, data = {}) {
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
        signal: AbortSignal.timeout(60000),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        console.warn(`[HRWorksClient] Service ${service} returned ${resp.status}: ${text}`);
        return null;
      }

      const json = await resp.json();
      return json.response || json;
    } catch (err) {
      console.warn(`[HRWorksClient] Call to ${service} failed: ${err.message}`);
      return null;
    }
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

    const data = await this.callService('get_team_absences', payload);
    if (data && Array.isArray(data.employees)) {
      this.cache.set(cacheKey, {
        data,
        expiresAt: Date.now() + this.cacheTtlMs,
      });
      return data;
    }
    return null;
  }

  /**
   * Matches a person from Teams directory to an HRworks employee and determines
   * their active or upcoming absence.
   */
  async findPersonAbsence(person, { organizationalUnit = null } = {}) {
    if (!person) return null;

    // 1. Fetch team absences first
    let calData = await this.getTeamAbsences({ organizationalUnit });
    let employee = this.matchEmployee(person, calData?.employees);

    // 2. If not found and person has department, try that OU
    if (!employee && !organizationalUnit && person.department) {
      calData = await this.getTeamAbsences({ organizationalUnit: person.department });
      employee = this.matchEmployee(person, calData?.employees);
    }

    if (!employee || !calData || !Array.isArray(calData.absences)) {
      return null;
    }

    // 3. Find absences for this employee
    const empAbsences = calData.absences.filter((a) => {
      if (a.resourceId && a.resourceId === employee.id) return true;
      if (a.rawName && a.rawName === employee.rawName) return true;
      if (a.employee && normalizeName(a.employee) === normalizeName(employee.displayName)) return true;
      return false;
    });

    if (empAbsences.length === 0) {
      return { employee, absence: null, allAbsences: [] };
    }

    // 4. Calculate today in Berlin time (YYYY-MM-DD)
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
      employee,
      absence: activeToday || upcoming || null,
      allAbsences: empAbsences,
    };
  }

  matchEmployee(person, employees) {
    if (!Array.isArray(employees) || employees.length === 0) return null;

    const pDisplayNorm = normalizeName(person.displayName);
    const pGivenNorm = normalizeName(person.givenName);
    const pSurNorm = normalizeName(person.surname);
    const pEmail = (person.email || person.userPrincipalName || '').toLowerCase();
    const pEmailPrefix = pEmail ? pEmail.split('@')[0] : '';

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

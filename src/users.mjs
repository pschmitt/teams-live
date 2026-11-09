/**
 * User directory for cross-service username matching (GitLab, Jira, Teams).
 * Maps usernames and display names across platforms to enable native Teams @mentions.
 */

/**
 * Extracts the raw Azure AD Object ID (UUID) from an MRI or user URL string.
 * Examples:
 *   '8:orgid:00000000-0000-0000-0000-000000000000' -> '00000000-0000-0000-0000-000000000000'
 *   'https://.../contacts/8:orgid:00000000-0000-0000-0000-000000000000' -> '00000000-0000-0000-0000-000000000000'
 *   '00000000-0000-0000-0000-000000000000' -> '00000000-0000-0000-0000-000000000000'
 */
export function extractUserOid(mriOrUrl) {
  if (!mriOrUrl) return null;
  const str = String(mriOrUrl).trim().toLowerCase();
  const match = str.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1].toLowerCase() : null;
}

export function normalizeName(str) {
  if (!str) return '';
  return String(str)
    .trim()
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function stripDiacritics(str) {
  if (!str) return '';
  return String(str)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 's');
}

/**
 * Derives common username patterns from a display name and optional email.
 * E.g. "Jane Doe" -> ["jdoe", "jane.doe", "jane-doe", "jane", "doe"]
 * E.g. "Märta Smith" -> ["maertasmith", "martasmith", "marta.smith", ...]
 */
export function deriveCandidateUsernames(displayName, email = '') {
  const candidates = new Set();
  if (email && typeof email === 'string') {
    const emailPrefix = email.split('@')[0].toLowerCase();
    if (emailPrefix) candidates.add(emailPrefix);
  }

  if (!displayName || typeof displayName !== 'string') {
    return Array.from(candidates);
  }

  const cleanName = displayName.replace(/[()[\]<>,]/g, '').trim();
  const parts = cleanName.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return Array.from(candidates);

  const firstRaw = parts[0];
  const lastRaw = parts[parts.length - 1];

  for (const normFn of [normalizeName, stripDiacritics]) {
    const first = normFn(firstRaw);
    const last = normFn(lastRaw);
    if (!first || !last) continue;

    candidates.add(first);
    candidates.add(last);

    if (parts.length >= 2) {
      candidates.add(`${first[0]}${last}`); // e.g. jdoe
      candidates.add(`${first}.${last}`); // e.g. jane.doe
      candidates.add(`${first}-${last}`); // e.g. jane-doe
      candidates.add(`${first}_${last}`); // e.g. jane_doe
      candidates.add(`${first}${last}`); // e.g. janedoe
    }
  }

  return Array.from(candidates);
}

export const SEED_USERS = [];

export function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

export function scorePerson(person, query) {
  if (!person || !query) return 0;
  const qNorm = normalizeName(query);
  const qLower = query.toLowerCase();
  const nameNorm = normalizeName(person.displayName || '');
  const emailLower = (person.email || '').toLowerCase();
  const emailPrefix = emailLower.split('@')[0];

  let score = 0;

  // Exact matches
  if (nameNorm === qNorm || emailLower === qLower || emailPrefix === qLower) {
    score += 1000;
  }

  // Name starts with query
  if (nameNorm.startsWith(qNorm)) {
    score += 120;
  } else if (nameNorm.split(/\s+/).some((w) => w.startsWith(qNorm))) {
    score += 80;
  } else if (nameNorm.includes(qNorm)) {
    score += 40;
  }

  // Email matches
  if (emailLower.startsWith(qLower)) {
    score += 90;
  } else if (emailPrefix.split('.').some((w) => w.startsWith(qLower))) {
    score += 70;
  } else if (emailLower.includes(qLower)) {
    score += 30;
  }

  // Internal vs External
  if (emailLower.endsWith('@wiit.cloud') || emailLower.endsWith('@wiit.de') || emailLower.endsWith('@wiit.it')) {
    score += 25;
  }
  if (person.userType === 'Member') {
    score += 15;
  }
  if (!nameNorm.startsWith('ext-') && !emailPrefix.includes('.ext') && !emailPrefix.includes('-ext')) {
    score += 20;
  }

  // Completeness bonus (has job title / department)
  if (person.jobTitle) score += 10;
  if (person.department) score += 10;

  return score;
}

export class UserDirectory {
  constructor({ searchFn = null, resolveProfilesFn = null, seedUsers = SEED_USERS } = {}) {
    this.searchFn = searchFn;
    this.resolveProfilesFn = resolveProfilesFn;
    this.users = new Map(); // mri -> user
    this.byMri = new Map();
    this.byDisplayName = new Map();
    this.byGitlabUsername = new Map();
    this.byJiraName = new Map();
    this.byEmail = new Map();
    this.lookupCache = new Map(); // query -> user | null

    for (const seed of seedUsers) {
      this.addUser(seed);
    }
  }

  addUser(userData) {
    if (!userData || !userData.displayName) return null;
    const mri =
      userData.mri ||
      (userData.id ? `8:orgid:${userData.id}` : null) ||
      (userData.displayName ? `user:${normalizeName(userData.displayName)}` : null);
    if (!mri) return null;

    let user = this.users.get(mri);
    if (!user) {
      user = {
        displayName: userData.displayName,
        mri,
        email: userData.email || '',
        givenName: userData.givenName || '',
        surname: userData.surname || '',
        jobTitle: userData.jobTitle || '',
        department: userData.department || '',
        companyName: userData.companyName || userData.tenantName || '',
        userType: userData.userType || '',
        gitlabUsernames: new Set(),
        jiraUsernames: new Set(),
      };
      this.users.set(mri, user);
      this.byMri.set(mri, user);
    } else {
      if (userData.displayName && user.displayName !== userData.displayName) {
        user.displayName = userData.displayName;
      }
      if (userData.email && !user.email) {
        user.email = userData.email;
      }
      if (userData.givenName && !user.givenName) user.givenName = userData.givenName;
      if (userData.surname && !user.surname) user.surname = userData.surname;
      if (userData.jobTitle) user.jobTitle = userData.jobTitle;
      if (userData.department) user.department = userData.department;
      if (userData.companyName) user.companyName = userData.companyName;
      if (userData.tenantName && !user.companyName) user.companyName = userData.tenantName;
      if (userData.userType) user.userType = userData.userType;
    }

    // Add explicit usernames
    if (Array.isArray(userData.gitlabUsernames)) {
      for (const u of userData.gitlabUsernames) {
        if (u) user.gitlabUsernames.add(u.toLowerCase());
      }
    }
    if (Array.isArray(userData.jiraUsernames)) {
      for (const u of userData.jiraUsernames) {
        if (u) user.jiraUsernames.add(u.toLowerCase());
      }
    }

    // Derive candidate usernames from display name and email
    const candidates = deriveCandidateUsernames(user.displayName, user.email);
    for (const c of candidates) {
      user.gitlabUsernames.add(c);
      user.jiraUsernames.add(c);
    }

    // Index by displayName variants
    const normName = normalizeName(user.displayName);
    const stripName = stripDiacritics(user.displayName);
    this.byDisplayName.set(user.displayName.toLowerCase(), user);
    if (normName) this.byDisplayName.set(normName, user);
    if (stripName) this.byDisplayName.set(stripName, user);

    // Index by email
    if (user.email) {
      this.byEmail.set(user.email.toLowerCase(), user);
      const prefix = user.email.split('@')[0].toLowerCase();
      if (prefix && !this.byEmail.has(prefix)) {
        this.byEmail.set(prefix, user);
      }
    }

    // Index by gitlab usernames
    for (const gu of user.gitlabUsernames) {
      this.byGitlabUsername.set(gu, user);
    }

    // Index by jira usernames
    for (const ju of user.jiraUsernames) {
      this.byJiraName.set(ju, user);
    }

    return user;
  }

  loadInteractions(interactions) {
    if (!interactions) return;
    const entries = interactions instanceof Map ? interactions.entries() : Object.entries(interactions);
    for (const [key, val] of entries) {
      const name = val?.name || (key.startsWith('8:orgid:') ? null : key);
      const mri = val?.mri || (key.startsWith('8:orgid:') ? key : null);
      if (name) {
        this.addUser({ displayName: name, mri: mri || undefined });
      }
    }
  }

  loadConfig(config) {
    const mappings = config?.user_mappings || config?.users;
    if (!mappings) return;

    if (Array.isArray(mappings)) {
      for (const m of mappings) {
        this.addUser(m);
      }
    } else if (typeof mappings === 'object') {
      for (const [gitlabUser, details] of Object.entries(mappings)) {
        if (typeof details === 'string') {
          // e.g. "pschmitt": "Philipp Schmitt" or "pschmitt": "8:orgid:..."
          if (details.startsWith('8:orgid:')) {
            this.addUser({ mri: details, gitlabUsernames: [gitlabUser], displayName: gitlabUser });
          } else {
            this.addUser({ displayName: details, gitlabUsernames: [gitlabUser] });
          }
        } else if (details && typeof details === 'object') {
          this.addUser({
            ...details,
            gitlabUsernames: [gitlabUser, ...(details.gitlabUsernames || [])],
          });
        }
      }
    }
  }

  registerInteraction(name, mri) {
    if (name) {
      return this.addUser({ displayName: name, mri: mri || undefined });
    }
    return null;
  }

  /**
   * Synchronous lookup in local indexes by any identifier.
   */
  findUser(query) {
    if (!query) return null;

    if (typeof query === 'object') {
      if (query.mri && this.byMri.has(query.mri)) {
        return this.byMri.get(query.mri);
      }
      if (query.username) {
        const u = this.findUser(query.username);
        if (u) return u;
      }
      if (query.displayName || query.name) {
        const u = this.findUser(query.displayName || query.name);
        if (u) return u;
      }
      return null;
    }

    let q = String(query).trim();
    if (!q) return null;

    // Check for Teams mention format: @[DisplayName](mri)
    const mentionMatch = q.match(/@?\[([^\]]+)\]\(([^)]+)\)/);
    if (mentionMatch) {
      const mri = mentionMatch[2];
      if (this.byMri.has(mri)) return this.byMri.get(mri);
      q = mentionMatch[1];
    } else {
      q = q.replace(/^@+/, '');
    }

    // 1. Direct MRI match
    if (this.byMri.has(q)) return this.byMri.get(q);

    // 2. Direct email match
    const lower = q.toLowerCase();
    if (this.byEmail.has(lower)) return this.byEmail.get(lower);

    // 3. Direct GitLab username match
    if (this.byGitlabUsername.has(lower)) return this.byGitlabUsername.get(lower);

    // 4. Jira username or displayName match
    if (this.byJiraName.has(lower)) return this.byJiraName.get(lower);

    // 5. DisplayName match (exact or normalized)
    if (this.byDisplayName.has(lower)) return this.byDisplayName.get(lower);
    const norm = normalizeName(q);
    if (norm && this.byDisplayName.has(norm)) return this.byDisplayName.get(norm);
    const stripped = stripDiacritics(q);
    if (stripped && this.byDisplayName.has(stripped)) return this.byDisplayName.get(stripped);

    // 6. Partial name match across users (e.g. query "Jane" matching "Jane Doe")
    for (const user of this.users.values()) {
      const uNorm = normalizeName(user.displayName);
      if (norm && uNorm.includes(norm)) return user;
    }

    return null;
  }

  /**
   * Asynchronous user resolution.
   * If not cached locally, queries Teams Substrate search if searchFn is available.
   */
  async resolveUser(authorOrName) {
    if (!authorOrName) return null;

    // Fast synchronous path
    const cached = this.findUser(authorOrName);
    if (cached) return cached;

    const queryKey = typeof authorOrName === 'object'
      ? `${authorOrName.username || ''}:${authorOrName.name || authorOrName.displayName || ''}`
      : String(authorOrName);

    if (this.lookupCache.has(queryKey)) {
      return this.lookupCache.get(queryKey);
    }

    if (!this.searchFn) {
      this.lookupCache.set(queryKey, null);
      return null;
    }

    const searchTerms = [];
    if (typeof authorOrName === 'object') {
      if (authorOrName.name) searchTerms.push(authorOrName.name);
      if (authorOrName.displayName) searchTerms.push(authorOrName.displayName);
      if (authorOrName.username) searchTerms.push(authorOrName.username);
    } else {
      searchTerms.push(String(authorOrName).replace(/^@+/, ''));
    }

    for (const term of searchTerms) {
      if (!term || term.length < 2) continue;
      try {
        const res = await this.searchFn(term, 5);
        if (res?.ok && Array.isArray(res.value?.results) && res.value.results.length > 0) {
          const results = res.value.results;
          // Prefer exact display name match, otherwise first result if only 1
          let match = results.find(
            (r) => normalizeName(r.displayName) === normalizeName(term)
          );
          if (!match && results.length === 1) {
            match = results[0];
          }

          if (match && match.mri) {
            const added = this.addUser({
              displayName: match.displayName,
              mri: match.mri,
              email: match.email,
              givenName: match.givenName,
              surname: match.surname,
              jobTitle: match.jobTitle,
              department: match.department,
              companyName: match.companyName,
              userType: match.userType,
              gitlabUsernames: typeof authorOrName === 'object' && authorOrName.username ? [authorOrName.username] : [],
            });
            this.lookupCache.set(queryKey, added);
            return added;
          }
        }
      } catch {
        // Ignore substrate search failures
      }
    }

    this.lookupCache.set(queryKey, null);
    return null;
  }

  /**
   * Formats a user reference for Teams.
   * If a matching user with an MRI is found, formats as native Teams mention:
   * @[DisplayName](mri)
   * Otherwise falls back to plain text mention: @username
   */
  formatMention(authorOrName) {
    if (!authorOrName) return '@unknown';

    // If it's already a Teams mention string, return as-is
    if (typeof authorOrName === 'string' && /^@\[.+\]\(8:orgid:.+\)$/.test(authorOrName)) {
      return authorOrName;
    }

    const user = this.findUser(authorOrName);
    if (user && user.mri) {
      return `@[${user.displayName}](${user.mri})`;
    }

    if (typeof authorOrName === 'object') {
      const name = authorOrName.username || authorOrName.name || authorOrName.displayName || 'unknown';
      return `@${name.replace(/^@+/, '')}`;
    }

    const str = String(authorOrName).trim();
    if (str.toLowerCase() === 'unassigned') return 'Unassigned';
    return `@${str.replace(/^@+/, '')}`;
  }

  /**
   * Checks whether a GitLab MR author matches a given filter.
   * Filter can be:
   * - A user object (e.g. sender from `/mrs me` or `/mrs mine`)
   * - A string (username, display name, partial name)
   */
  matchesUser(author, filter) {
    if (!author || !filter) return false;

    const authorUsername = (author.username || '').toLowerCase();
    const authorNameNorm = normalizeName(author.name || author.displayName || '');
    const authorNameStrip = stripDiacritics(author.name || author.displayName || '');

    // Case 1: Filter is a user object
    if (typeof filter === 'object' && filter.mri) {
      // Check MRI match if author is resolved
      const resolvedAuthor = this.findUser(author);
      if (resolvedAuthor && resolvedAuthor.mri === filter.mri) return true;

      // Check if author username is in user's gitlabUsernames
      if (authorUsername && filter.gitlabUsernames?.has?.(authorUsername)) return true;
      if (authorUsername && Array.isArray(filter.gitlabUsernames) && filter.gitlabUsernames.includes(authorUsername)) return true;

      // Check display name match
      const filterNameNorm = normalizeName(filter.displayName || '');
      if (filterNameNorm && authorNameNorm && filterNameNorm === authorNameNorm) return true;

      return false;
    }

    // Case 2: Filter is a string query
    const rawQuery = String(filter).trim().replace(/^@+/, '');
    if (!rawQuery) return false;
    const lowerQuery = rawQuery.toLowerCase();
    const queryNorm = normalizeName(rawQuery);
    const queryStrip = stripDiacritics(rawQuery);

    // Exact username match
    if (authorUsername && authorUsername === lowerQuery) return true;

    // Name exact or substring match
    if (authorNameNorm && queryNorm && (authorNameNorm === queryNorm || authorNameNorm.includes(queryNorm))) return true;
    if (authorNameStrip && queryStrip && (authorNameStrip === queryStrip || authorNameStrip.includes(queryStrip))) return true;

    // Check if query resolves to a user, and compare against resolved author
    const queryUser = this.findUser(rawQuery);
    if (queryUser) {
      return this.matchesUser(author, queryUser);
    }

    return false;
  }

  /**
   * Enriches a user object or MRI with rich profile attributes from MiddleTier
   * (job title, department, company name, user type) if resolveProfilesFn is available.
   */
  async enrichUser(userOrMri) {
    if (!userOrMri) return null;
    let mri = typeof userOrMri === 'string' ? userOrMri : userOrMri.mri;
    if (!mri) return typeof userOrMri === 'object' ? userOrMri : null;

    if (!mri.startsWith('8:orgid:')) {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mri)) {
        mri = `8:orgid:${mri}`;
      } else {
        return typeof userOrMri === 'object' ? userOrMri : this.findUser(mri);
      }
    }

    if (!this.resolveProfilesFn) {
      return typeof userOrMri === 'object' ? userOrMri : this.findUser(mri);
    }

    try {
      const res = await this.resolveProfilesFn([mri]);
      if (res?.ok && res.value?.profiles instanceof Map && res.value.profiles.has(mri)) {
        const p = res.value.profiles.get(mri);
        return this.addUser({
          mri,
          displayName: p.displayName,
          email: p.email,
          givenName: p.givenName,
          surname: p.surname,
          jobTitle: p.jobTitle,
          department: p.department,
          companyName: p.companyName,
          userType: p.userType,
        });
      }
    } catch {
      // Non-fatal resolution error
    }

    return typeof userOrMri === 'object' ? userOrMri : this.findUser(mri);
  }

  /**
   * Searches the Teams directory and cross-references local known identities.
   * Handles MRIs, @mentions, email addresses, usernames, and display names.
   */
  async searchDirectory(query, { limit = 10 } = {}) {
    if (!query) return [];

    let cleanQuery = String(query).trim();
    if (!cleanQuery) return [];

    // 1. Check for Teams mention format: @[DisplayName](mri)
    const mentionMatch = cleanQuery.match(/@?\[([^\]]+)\]\(([^)]+)\)/);
    if (mentionMatch) {
      const mri = mentionMatch[2];
      const name = mentionMatch[1];
      let user = this.findUser(mri) || this.addUser({ displayName: name, mri });
      if (user) {
        user = await this.enrichUser(user);
        return [user];
      }
    }

    // 2. Direct MRI match or GUID
    if (cleanQuery.startsWith('8:orgid:') || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanQuery)) {
      const mri = cleanQuery.startsWith('8:orgid:') ? cleanQuery : `8:orgid:${cleanQuery}`;
      let user = this.findUser(mri) || this.addUser({ displayName: cleanQuery, mri });
      if (user) {
        user = await this.enrichUser(user);
        return [user];
      }
    }

    cleanQuery = cleanQuery.replace(/^@+/, '').trim();
    if (!cleanQuery) return [];

    const results = [];
    const seenMris = new Set();

    // 3. Check local directory (seed users, interactions, configured users)
    const localUser = this.findUser(cleanQuery);
    if (localUser && localUser.mri) {
      const enriched = await this.enrichUser(localUser);
      results.push(enriched || localUser);
      seenMris.add(localUser.mri);
    }

    // 4. Query live Teams directory via searchFn (Substrate People Search)
    if (this.searchFn) {
      try {
        const res = await this.searchFn(cleanQuery, limit);
        const searchList = res?.ok ? res.value?.results : (res?.results || (Array.isArray(res) ? res : []));
        if (Array.isArray(searchList) && searchList.length > 0) {
          const mrisToEnrich = [];
          for (const item of searchList) {
            const added = this.addUser(item);
            if (added && added.mri && !seenMris.has(added.mri)) {
              seenMris.add(added.mri);
              results.push(added);
              if (!added.jobTitle || !added.department || !added.companyName) {
                mrisToEnrich.push(added.mri);
              }
            }
          }

          // Batch enrich profiles with resolveProfilesFn if available
          if (mrisToEnrich.length > 0 && this.resolveProfilesFn && mrisToEnrich.length <= 10) {
            try {
              const profileRes = await this.resolveProfilesFn(mrisToEnrich);
              if (profileRes?.ok && profileRes.value?.profiles instanceof Map) {
                for (const [mri, p] of profileRes.value.profiles.entries()) {
                  this.addUser({
                    mri,
                    displayName: p.displayName,
                    email: p.email,
                    givenName: p.givenName,
                    surname: p.surname,
                    jobTitle: p.jobTitle,
                    department: p.department,
                    companyName: p.companyName,
                    userType: p.userType,
                  });
                }
              }
            } catch {
              // Batch resolution failure is non-fatal
            }
          }
        }
      } catch {
        // Substrate search error is non-fatal if local results exist
      }
    }

    // Sort results by relevance to query
    results.sort((a, b) => scorePerson(b, cleanQuery) - scorePerson(a, cleanQuery));

    return results.map((u) => (u.mri && this.users.get(u.mri)) || u);
  }

  /**
   * Finds fuzzy suggestions when no direct match is found for a query.
   */
  findSuggestions(query, maxDistance = 2) {
    if (!query || typeof query !== 'string') return [];
    const qNorm = normalizeName(query);
    if (qNorm.length < 3) return [];

    const suggestions = [];
    const seen = new Set();

    for (const user of this.users.values()) {
      if (!user.displayName || seen.has(user.displayName)) continue;

      const nameNorm = normalizeName(user.displayName);
      const nameParts = nameNorm.split(/\s+/);

      let minDist = levenshteinDistance(qNorm, nameNorm);
      for (const part of nameParts) {
        if (part.length >= 3) {
          const d = levenshteinDistance(qNorm, part);
          if (d < minDist) minDist = d;
        }
      }

      if (user.gitlabUsernames) {
        for (const u of user.gitlabUsernames) {
          const d = levenshteinDistance(qNorm, u.toLowerCase());
          if (d < minDist) minDist = d;
        }
      }

      if (user.email) {
        const prefix = user.email.split('@')[0].toLowerCase();
        const d = levenshteinDistance(qNorm, prefix);
        if (d < minDist) minDist = d;
      }

      if (minDist <= maxDistance) {
        seen.add(user.displayName);
        suggestions.push({ user, distance: minDist });
      }
    }

    suggestions.sort((a, b) => a.distance - b.distance);
    return suggestions.map((s) => s.user);
  }
}

/**
 * Formats a user's details as a rich Markdown contact card for Microsoft Teams.
 */
export function formatContactCard(person, { userDirectory = null } = {}) {
  const lines = [];
  const name = person.displayName || [person.givenName, person.surname].filter(Boolean).join(' ') || 'Unknown User';
  const mention = person.mri ? `@[${name}](${person.mri}#contact)` : `**${name}**`;

  lines.push(`🪪 **Contact Card**: ${mention}\n`);

  if (person.jobTitle) {
    lines.push(`- 💼 **Role**: ${person.jobTitle}`);
  }
  if (person.department) {
    lines.push(`- 🏢 **Department**: ${person.department}`);
  }
  if (person.companyName) {
    const userTypeStr = person.userType ? ` (${person.userType})` : '';
    lines.push(`- 🏛️ **Organization**: ${person.companyName}${userTypeStr}`);
  } else if (person.userType) {
    lines.push(`- 🏷️ **Account Type**: ${person.userType}`);
  }
  if (person.email) {
    lines.push(`- 📧 **Email**: [${person.email}](mailto:${person.email})`);
    lines.push(`- 💬 **Teams Chat**: [Start Chat](https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(person.email)})`);
  }

  // Cross-service integrations from userDirectory if available
  const targetUser = userDirectory
    ? (userDirectory.findUser(person.mri) ||
       userDirectory.findUser(person.email) ||
       userDirectory.findUser(person.displayName) ||
       person)
    : person;

  if (targetUser.gitlabUsernames?.size > 0 || (Array.isArray(targetUser.gitlabUsernames) && targetUser.gitlabUsernames.length > 0)) {
    const gitlabList = targetUser.gitlabUsernames instanceof Set
      ? Array.from(targetUser.gitlabUsernames)
      : targetUser.gitlabUsernames;
    const primary = gitlabList.find((u) => !u.includes('.') && !u.includes('-') && !u.includes('_')) || gitlabList[0];
    if (primary) {
      lines.push(`- 🦊 **GitLab**: [@${primary}](https://git.wiit.one/${primary})`);
    }
  }

  if (targetUser.jiraUsernames?.size > 0 || (Array.isArray(targetUser.jiraUsernames) && targetUser.jiraUsernames.length > 0)) {
    const jiraList = targetUser.jiraUsernames instanceof Set
      ? Array.from(targetUser.jiraUsernames)
      : targetUser.jiraUsernames;
    const primaryJira = jiraList.find((u) => !u.includes(' ') && !u.includes('.') && !u.includes('-')) || jiraList[0];
    if (primaryJira) {
      lines.push(`- 🎫 **Jira**: \`${primaryJira}\``);
    }
  }

  return lines.join('\n');
}

/**
 * Formats multiple search results into a clean, numbered disambiguation list.
 */
export function formatSearchResultsList(results, query, { command = '/whois' } = {}) {
  const lines = [`🔍 **Multiple contacts found matching "${query}"** (${results.length} results):\n`];
  const maxDisplay = 8;
  const displayed = results.slice(0, maxDisplay);

  displayed.forEach((person, idx) => {
    const num = idx + 1;
    const name = person.displayName || [person.givenName, person.surname].filter(Boolean).join(' ') || 'Unknown User';
    const mention = person.mri ? ` (@[${name}](${person.mri}))` : '';
    const roleParts = [person.jobTitle, person.department].filter(Boolean).join(' • ');
    const orgPart = person.companyName && !roleParts.includes(person.companyName) ? ` (${person.companyName})` : '';
    const detailsStr = roleParts ? `   - 💼 ${roleParts}${orgPart}` : (orgPart ? `   - 🏛️ ${orgPart}` : '');
    const emailStr = person.email ? `[${person.email}](mailto:${person.email})` : 'No email';
    const inspectCmd = person.email ? ` • 🔎 \`${command} ${person.email}\`` : '';

    lines.push(`${num}. 👤 **${name}**${mention}`);
    if (detailsStr) lines.push(detailsStr);
    lines.push(`   - 📧 ${emailStr}${inspectCmd}`);
    lines.push('');
  });

  if (results.length > maxDisplay) {
    lines.push(`_...and ${results.length - maxDisplay} more candidates. Please refine your query (e.g. with full name or email)._\n`);
  }

  lines.push(`_💡 Tip: Run \`${command} <email | full name>\` for details._`);
  return lines.join('\n');
}

/**
 * Formats a user's presence, location, and active meeting into a rich Markdown status card.
 */
export function formatWhereisCard(person, presence = {}, { activeMeeting = null, hrworksAbsence = null, userDirectory = null } = {}) {
  const lines = [];
  const name = person.displayName || [person.givenName, person.surname].filter(Boolean).join(' ') || 'Unknown User';
  const mention = person.mri ? `@[${name}](${person.mri}#contact)` : `**${name}**`;

  lines.push(`📍 **Where is ${mention}?**\n`);

  // Presence / Status
  const availability = presence.availability || 'Unknown';
  const activity = presence.activity || '';
  const isOof = presence.calendarData?.isOutOfOffice === true;

  let statusIcon = '⚪';
  let statusText = `**${availability}**`;
  if (isOof) {
    statusIcon = '🌴';
    statusText = `**Out of Office**${activity === 'OffWork' ? ' (Off work)' : ''}`;
  } else if (activity === 'InAMeeting') {
    statusIcon = '🔴';
    statusText = '**In a meeting**';
  } else if (activity === 'InACall') {
    statusIcon = '📞';
    statusText = '**In a call**';
  } else if (activity === 'Presenting') {
    statusIcon = '🖥️';
    statusText = '**Presenting** (Do Not Disturb)';
  } else if (availability === 'Busy') {
    statusIcon = '🔴';
    statusText = '**Busy**';
  } else if (availability === 'Available') {
    statusIcon = '🟢';
    statusText = '**Available**';
  } else if (availability === 'Away') {
    statusIcon = '🟡';
    statusText = '**Away**';
  } else if (availability === 'BeRightBack') {
    statusIcon = '🟡';
    statusText = '**Be Right Back**';
  } else if (availability === 'DoNotDisturb') {
    statusIcon = '⛔';
    statusText = '**Do Not Disturb**';
  } else if (availability === 'Offline') {
    statusIcon = '⚪';
    statusText = `**Offline**${activity === 'OffWork' ? ' (Off work)' : ''}`;
  }

  lines.push(`- ${statusIcon} **Status**: ${statusText}`);

  // HRworks absence details
  if (hrworksAbsence) {
    if (hrworksAbsence.error) {
      lines.push(`- ⚠️ **HRworks**: Lookup failed (${hrworksAbsence.error})`);
    } else if (hrworksAbsence.absence) {
      const ab = hrworksAbsence.absence;
      const cat = ab.category || 'Leave';
      const status = ab.status ? ` (${ab.status})` : '';
      let dates = '';
      if (ab.startDate) {
        if (ab.endDate && ab.endDate !== ab.startDate) {
          dates = ` [${ab.startDate} – ${ab.endDate}]`;
        } else {
          dates = ` [${ab.startDate}]`;
        }
      }
      const catLower = cat.toLowerCase();
      const icon = catLower.includes('krank') || catLower.includes('ill') ? '🤒' :
                   catLower.includes('home') || catLower.includes('mobil') ? '🏠' : '🌴';
      lines.push(`- ${icon} **HRworks Today**: **${cat}**${dates}${status}`);
    } else if (hrworksAbsence.upcomingAbsence) {
      const ab = hrworksAbsence.upcomingAbsence;
      const cat = ab.category || 'Leave';
      const status = ab.status ? ` (${ab.status})` : '';
      let dates = '';
      if (ab.startDate) {
        if (ab.endDate && ab.endDate !== ab.startDate) {
          dates = ` [${ab.startDate} – ${ab.endDate}]`;
        } else {
          dates = ` [${ab.startDate}]`;
        }
      }
      const catLower = cat.toLowerCase();
      const icon = catLower.includes('krank') || catLower.includes('ill') ? '🤒' :
                   catLower.includes('home') || catLower.includes('mobil') ? '🏠' : '🌴';
      lines.push(`- 🏢 **HRworks**: None today (${icon} Upcoming: **${cat}**${dates}${status})`);
    } else if (hrworksAbsence.reason === 'not_found') {
      lines.push('- 🏢 **HRworks**: Person not found in HRworks calendar');
    } else if (hrworksAbsence.reason === 'calendar_unavailable') {
      lines.push('- ⚠️ **HRworks**: Calendar data unavailable');
    } else {
      lines.push('- 🏢 **HRworks**: Present (not on leave/sick)');
    }
  }

  // Active meeting information
  if (activeMeeting) {
    let meetingLine = `- 📅 **Meeting**: **${activeMeeting.subject || 'Scheduled Meeting'}**`;
    if (activeMeeting.endTime) {
      const end = new Date(activeMeeting.endTime);
      if (!isNaN(end.getTime())) {
        const timeStr = end.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
        meetingLine += ` (until ${timeStr} CET)`;
      }
    }
    lines.push(meetingLine);

    if (activeMeeting.joinUrl) {
      lines.push(`- 🔗 **Meeting Link**: [Join Meeting](${activeMeeting.joinUrl})`);
    }
  } else if (activity === 'InAMeeting' || activity === 'InACall') {
    lines.push('- 📅 **Meeting**: In a call / meeting');
  }

  // Device & activity details
  if (presence.deviceType) {
    const devIcon = presence.deviceType.toLowerCase() === 'mobile' ? '📱' :
                    presence.deviceType.toLowerCase() === 'web' ? '🌐' : '💻';
    lines.push(`- ${devIcon} **Device**: ${presence.deviceType}`);
  }

  if (presence.lastActiveTime) {
    const lastActive = new Date(presence.lastActiveTime);
    if (!isNaN(lastActive.getTime())) {
      const diffMs = Date.now() - lastActive.getTime();
      const diffMins = Math.round(diffMs / 60000);
      let timeDesc = '';
      if (diffMins < 2) {
        timeDesc = 'Just now';
      } else if (diffMins < 60) {
        timeDesc = `${diffMins}m ago`;
      } else {
        const hours = Math.floor(diffMins / 60);
        const mins = diffMins % 60;
        timeDesc = `${hours}h ${mins}m ago`;
      }
      const timeStr = lastActive.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
      lines.push(`- 🕒 **Last active**: ${timeDesc} (${timeStr} CET)`);
    }
  }

  // Teams communication links
  const targetId = person.email || person.mri;
  if (targetId) {
    const chatUrl = `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(targetId)}`;
    const callUrl = `https://teams.microsoft.com/l/call/0/0?users=${encodeURIComponent(targetId)}`;
    lines.push(`- 💬 **Teams**: [Start Chat](${chatUrl}) • [Call in Teams](${callUrl})`);
  }

  return lines.join('\n');
}

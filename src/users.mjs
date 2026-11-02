/**
 * User directory for cross-service username matching (GitLab, Jira, Teams).
 * Maps usernames and display names across platforms to enable native Teams @mentions.
 */

export function normalizeName(str) {
  if (!str) return '';
  return String(str)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
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
 * E.g. "Philipp Schmitt" -> ["pschmitt", "philipp.schmitt", "philipp-schmitt", "philipp", "schmitt"]
 * E.g. "Mark Eisenblätter" -> ["meisenblaetter", "meisenblatter", "mark.eisenblaetter", ...]
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
      candidates.add(`${first[0]}${last}`); // e.g. pschmitt, dnagy, nherzig
      candidates.add(`${first}.${last}`); // e.g. philipp.schmitt
      candidates.add(`${first}-${last}`); // e.g. philipp-schmitt
      candidates.add(`${first}_${last}`); // e.g. philipp_schmitt
      candidates.add(`${first}${last}`); // e.g. philippschmitt
    }
  }

  return Array.from(candidates);
}

export const SEED_USERS = [
  {
    displayName: 'Philipp Schmitt',
    mri: '8:orgid:f94ccd0d-d140-4d1d-9fee-b00e642b9c11',
    email: 'philipp.schmitt@wiit.cloud',
    givenName: 'Philipp',
    surname: 'Schmitt',
    gitlabUsernames: ['pschmitt'],
    jiraUsernames: ['pschmitt', 'Philipp Schmitt'],
  },
  {
    displayName: 'Daniel Nagy',
    mri: '8:orgid:09495d48-b26a-44f7-81b8-9d551fa73774',
    email: 'daniel.nagy@wiit.cloud',
    givenName: 'Daniel',
    surname: 'Nagy',
    gitlabUsernames: ['dnagy'],
    jiraUsernames: ['dnagy', 'Daniel Nagy'],
  },
  {
    displayName: 'Mark Eisenblätter',
    mri: '8:orgid:c11e5dd1-477c-4d59-9634-bd492bf26f4a',
    email: 'mark.eisenblaetter@wiit.cloud',
    givenName: 'Mark',
    surname: 'Eisenblätter',
    gitlabUsernames: ['meisenblaetter', 'meisenblatter'],
    jiraUsernames: ['meisenblaetter', 'Mark Eisenblätter'],
  },
  {
    displayName: 'Nils Herzig',
    mri: '8:orgid:c6ad3867-bfb5-4641-a3e8-b7a462d38b03',
    email: 'nils.herzig@wiit.cloud',
    givenName: 'Nils',
    surname: 'Herzig',
    gitlabUsernames: ['nherzig'],
    jiraUsernames: ['nherzig', 'Nils Herzig'],
  },
  {
    displayName: 'Florian Müller',
    mri: '8:orgid:22f729f0-9d62-4afc-ad50-fd4215750b92',
    email: 'florian.mueller@wiit.cloud',
    givenName: 'Florian',
    surname: 'Müller',
    gitlabUsernames: ['fmueller', 'florian.mueller'],
    jiraUsernames: ['fmueller', 'Florian Müller'],
  },
];

export class UserDirectory {
  constructor({ searchFn = null, seedUsers = SEED_USERS } = {}) {
    this.searchFn = searchFn;
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
    const mri = userData.mri || (userData.id ? `8:orgid:${userData.id}` : null);
    if (!mri) return null;

    let user = this.users.get(mri);
    if (!user) {
      user = {
        displayName: userData.displayName,
        mri,
        email: userData.email || '',
        givenName: userData.givenName || '',
        surname: userData.surname || '',
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
      if (name && mri) {
        this.addUser({ displayName: name, mri });
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
    if (name && mri) {
      return this.addUser({ displayName: name, mri });
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

    const q = String(query).trim().replace(/^@+/, '');
    if (!q) return null;

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

    // 6. Partial name match across users (e.g. query "Daniel" matching "Daniel Nagy")
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
}

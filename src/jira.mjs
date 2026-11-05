export class JiraClient {
  constructor({ url = '', token = '', boardId = '', project = 'CKS', onAuthError = null, onSuccess = null } = {}) {
    this.baseUrl = (url || '').replace(/\/+$/, '');
    this.token = token || '';
    this.boardId = String(boardId || '').trim();
    this.project = String(project || 'CKS').trim();
    this.onAuthError = onAuthError;
    this.onSuccess = onSuccess;
    this.currentUser = null;
  }

  isConfigured() {
    return Boolean(this.baseUrl && this.token);
  }

  /**
   * Finds Jira issue links in text (browse URLs, RapidBoard/selectedIssue URLs, project issue URLs).
   */
  findIssueLinks(text, { allowQuotes = false } = {}) {
    const results = [];
    if (!text) return results;

    const textToSearch = allowQuotes
      ? text
      : text
          .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
          .replace(/<div[^>]*itemtype="http:\/\/schema\.skype\.com\/Reply"[\s\S]*?<\/div>/gi, '');

    const seen = new Set();
    const urlMatches = textToSearch.matchAll(/https?:\/\/[^\s"'<>]+/gi);

    for (const match of urlMatches) {
      let rawUrl = match[0];
      rawUrl = rawUrl.replace(/[.,;:!?)>]+$/, '');
      try {
        const parsed = new URL(rawUrl);
        let key = null;

        // 1. /browse/KEY-123
        const browseMatch = parsed.pathname.match(/\/browse\/([a-zA-Z][a-zA-Z0-9]+-\d+)/i);
        if (browseMatch) {
          key = browseMatch[1].toUpperCase();
        }

        // 2. Query param selectedIssue=KEY-123 (e.g. RapidBoard)
        if (!key && parsed.searchParams.has('selectedIssue')) {
          const sel = parsed.searchParams.get('selectedIssue');
          const selMatch = sel ? sel.match(/^([a-zA-Z][a-zA-Z0-9]+-\d+)$/i) : null;
          if (selMatch) {
            key = selMatch[1].toUpperCase();
          }
        }

        // 3. /projects/PROJ/issues/KEY-123
        if (!key) {
          const projMatch = parsed.pathname.match(/\/projects\/[^\/\s"'<>]+\/issues\/([a-zA-Z][a-zA-Z0-9]+-\d+)/i);
          if (projMatch) {
            key = projMatch[1].toUpperCase();
          }
        }

        // 4. /issue/KEY-123
        if (!key) {
          const issueMatch = parsed.pathname.match(/\/issue\/([a-zA-Z][a-zA-Z0-9]+-\d+)/i);
          if (issueMatch) {
            key = issueMatch[1].toUpperCase();
          }
        }

        if (key && !seen.has(key)) {
          seen.add(key);
          results.push({
            key,
            url: this.issueUrl(key) || rawUrl,
          });
        }
      } catch {
        // Not a valid URL
      }
    }

    return results;
  }

  issueUrl(key) {
    if (!key) return '';
    const cleanKey = String(key).trim().toUpperCase();
    return `${this.baseUrl || 'https://jira.wiit.one'}/browse/${cleanKey}`;
  }

  findAssociatedIssues(item = {}) {
    if (!item) return [];
    const results = [];
    const seen = new Set();

    const addKey = (rawKey) => {
      if (!rawKey) return;
      const key = String(rawKey).trim().toUpperCase();
      const parts = key.split('-');
      if (parts.length !== 2) return;
      const [proj, num] = parts;
      if (!num || /^0+$/.test(num)) return; // Skip placeholders like CKS-0000
      if (/^(cve|rfc|iso|sha|arm|x86)$/i.test(proj)) return; // Skip common false positives
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          key,
          url: this.issueUrl(key),
        });
      }
    };

    const isBot = Boolean(
      item.isBot ||
      item.author?.username?.toLowerCase().includes('renovate') ||
      item.author?.username?.toLowerCase().includes('bot') ||
      (Array.isArray(item.labels) && item.labels.includes('renovate'))
    );

    // 1. Explicit ticket label in description (e.g. "Ticket: ...", "Jira: ...", "Closes: ...", "Relates to: ...")
    if (item.description) {
      const labelMatches = item.description.matchAll(
        /(?:^|\n)\s*(?:ticket|jira|issue|closes|fixes|resolves|relates to)[\s:]+(?:https?:\/\/[^\s"'<>]+\/browse\/)?([a-zA-Z][a-zA-Z0-9]+-\d+)/gim
      );
      for (const m of labelMatches) {
        addKey(m[1]);
      }
    }

    // 2. Source branch (e.g. story/CKS-123-..., feature/HELP-1590-..., bugfix/IMGT-456-...)
    if (item.source_branch) {
      const branchMatch =
        item.source_branch.match(/^(?:story|feature|hotfix|bugfix|fix)\/([a-zA-Z][a-zA-Z0-9]+)-(\d+)/i) ||
        item.source_branch.match(/^([a-zA-Z][a-zA-Z0-9]+)-(\d+)/i);
      if (branchMatch) {
        addKey(`${branchMatch[1]}-${branchMatch[2]}`);
      }
    }

    // 3. Title (e.g. "[CKS-484] ...", "CKS-484: ...", "... (CKS-626)")
    if (item.title) {
      const titleMatches = item.title.matchAll(/(?:^|[\[\(\s])([a-zA-Z][a-zA-Z0-9]+)-([1-9]\d*)(?:[\]\)\s:]|$)/g);
      for (const m of titleMatches) {
        addKey(`${m[1]}-${m[2]}`);
      }
    }

    // 4. Description full Jira browse URL (for non-bots, searching before any "Release Notes" section)
    if (item.description && !isBot) {
      const textToSearch = item.description.split(/###?\s*Release Notes/i)[0];
      const urlMatches = textToSearch.matchAll(/https?:\/\/[^\s"'<>]+\/browse\/([a-zA-Z][a-zA-Z0-9]+-\d+)/gi);
      for (const m of urlMatches) {
        addKey(m[1]);
      }
    }

    return results;
  }

  findAssociatedIssue(item = {}) {
    const issues = this.findAssociatedIssues(item);
    return issues.length > 0 ? issues[0] : null;
  }

  async getCurrentUser() {
    if (this.currentUser) return this.currentUser;
    if (!this.isConfigured()) return null;
    try {
      this.currentUser = await this.request('rest/api/2/myself');
      return this.currentUser;
    } catch {
      return null;
    }
  }

  async request(path, { method = 'GET', body = null } = {}) {
    if (!this.baseUrl || !this.token) {
      throw new Error('Jira is not configured (missing URL or token)');
    }

    const url = `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
      'User-Agent': 'teams-live/1.0',
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const options = {
      method,
      headers,
      signal: AbortSignal.timeout(15_000),
    };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const errStr = `Jira HTTP ${res.status}: ${errText.slice(0, 150)}`;
      if (res.status === 401 || res.status === 403) {
        this.onAuthError?.(errStr);
      }
      throw new Error(errStr);
    }
    this.onSuccess?.('Jira');
    return await res.json();
  }

  /**
   * Retrieves single issue details.
   */
  async getIssue(issueKey) {
    const key = String(issueKey || '').trim().toUpperCase();
    if (!key) throw new Error('Issue key is required');
    const endpoint = `rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,status,assignee,priority,issuetype`;
    const res = await this.request(endpoint);
    const fields = res.fields || {};
    return {
      key: res.key,
      summary: fields.summary || '(No summary)',
      status: fields.status?.name || 'Unknown',
      statusCategory: fields.status?.statusCategory?.key || '',
      assignee: fields.assignee?.displayName || 'Unassigned',
      priority: fields.priority?.name || 'None',
      issueType: fields.issuetype?.name || 'Task',
      url: this.baseUrl ? `${this.baseUrl}/browse/${res.key}` : '',
    };
  }

  /**
   * Retrieves open tasks in active sprint(s) that are To Do, In Progress, or In Review.
   * Does NOT leak Jira URL, board name, or board ID.
   */
  async getActiveSprintTasks() {
    const jql = `project = ${this.project} AND sprint in openSprints() AND statusCategory != Done ORDER BY status ASC, updated DESC`;
    const endpoint = `rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=100&fields=summary,status,assignee`;
    const res = await this.request(endpoint);
    const issues = res.issues || [];

    const todo = [];
    const inProgress = [];
    const inReview = [];

    for (const issue of issues) {
      const statusObj = issue.fields?.status || {};
      const statusName = statusObj.name || '';
      const categoryKey = statusObj.statusCategory?.key || '';
      const assigneeObj = issue.fields?.assignee;
      const assigneeName = assigneeObj?.displayName || 'Unassigned';
      const summary = issue.fields?.summary || '';

      const item = {
        key: issue.key,
        summary,
        assignee: assigneeName,
        status: statusName,
        url: this.baseUrl ? `${this.baseUrl}/browse/${issue.key}` : '',
      };

      if (statusName.toLowerCase() === 'in review' || statusName.toLowerCase().includes('review')) {
        inReview.push(item);
      } else if (categoryKey === 'indeterminate' || statusName.toLowerCase().includes('progress')) {
        inProgress.push(item);
      } else {
        todo.push(item);
      }
    }

    return {
      total: issues.length,
      todo,
      inProgress,
      inReview,
    };
  }
}

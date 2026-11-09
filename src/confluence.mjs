export class ConfluenceClient {
  constructor({ url = 'https://wiki.wiit.one', token = '', onAuthError = null, onSuccess = null } = {}) {
    this.baseUrl = (url || 'https://wiki.wiit.one').replace(/\/+$/, '');
    this.token = token || '';
    this.onAuthError = onAuthError;
    this.onSuccess = onSuccess;
    this.currentUser = null;
  }

  isConfigured() {
    return Boolean(this.baseUrl && this.token);
  }

  /**
   * Finds Confluence page links in text (display URLs, viewpage.action, /spaces/.../pages/..., /x/... tiny links).
   */
  findPageLinks(text, { allowQuotes = false } = {}) {
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
        const host = parsed.hostname.toLowerCase();
        let baseHost = '';
        try {
          baseHost = this.baseUrl ? new URL(this.baseUrl).hostname.toLowerCase() : '';
        } catch {}

        const isConfluenceHost =
          (baseHost && host === baseHost) ||
          host === 'wiki.wiit.one' ||
          host.startsWith('wiki.') ||
          host.includes('confluence');

        if (!isConfluenceHost) continue;

        const info = this.parseConfluenceUrl(parsed, rawUrl);
        if (info) {
          const dedupeKey = info.key || rawUrl;
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey);
            results.push(info);
          }
        }
      } catch {
        // Not a valid URL
      }
    }

    return results;
  }

  parseConfluenceUrl(parsed, rawUrl) {
    // 1. ?pageId=12345 (e.g. /pages/viewpage.action?pageId=12345)
    if (parsed.searchParams.has('pageId')) {
      const pageId = parsed.searchParams.get('pageId');
      if (pageId && /^\d+$/.test(pageId)) {
        return {
          key: `page:${pageId}`,
          id: pageId,
          target: pageId,
          url: rawUrl,
        };
      }
    }

    // 2. /spaces/SPACE/pages/12345(/Title)?
    const spacesPagesMatch = parsed.pathname.match(/\/spaces\/[^\/\s"'<>]+\/pages\/(\d+)/i);
    if (spacesPagesMatch) {
      const pageId = spacesPagesMatch[1];
      return {
        key: `page:${pageId}`,
        id: pageId,
        target: pageId,
        url: rawUrl,
      };
    }

    // 3. /rest/api/content/12345
    const restMatch = parsed.pathname.match(/\/rest\/api\/content\/(\d+)/i);
    if (restMatch) {
      const pageId = restMatch[1];
      return {
        key: `page:${pageId}`,
        id: pageId,
        target: pageId,
        url: rawUrl,
      };
    }

    // 4. /display/SPACE/Title+With+Spaces
    const displayMatch = parsed.pathname.match(/\/display\/([^\/\s"'<>]+)\/([^\/\s"'<>]+)/i);
    if (displayMatch) {
      const spaceKey = displayMatch[1];
      const title = decodeURIComponent(displayMatch[2].replace(/\+/g, ' '));
      return {
        key: `doc:${spaceKey}:${title}`,
        spaceKey,
        title,
        target: { spaceKey, title, url: rawUrl },
        url: rawUrl,
      };
    }

    // 5. /x/ABCD (tiny links)
    const tinyMatch = parsed.pathname.match(/\/x\/([a-zA-Z0-9_\-]+)/i);
    if (tinyMatch) {
      const tinyId = tinyMatch[1];
      return {
        key: `tiny:${tinyId}`,
        tinyId,
        target: rawUrl,
        url: rawUrl,
      };
    }

    return null;
  }

  async getCurrentUser() {
    if (this.currentUser) return this.currentUser;
    if (!this.isConfigured()) return null;
    try {
      this.currentUser = await this.request('rest/api/user/current');
      return this.currentUser;
    } catch {
      return null;
    }
  }

  async request(path, { method = 'GET', body = null } = {}) {
    if (!this.baseUrl || !this.token) {
      throw new Error('Confluence is not configured (missing URL or token)');
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
      const errStr = `Confluence HTTP ${res.status}: ${errText.slice(0, 150)}`;
      if (res.status === 401 || res.status === 403) {
        this.onAuthError?.(errStr);
      }
      throw new Error(errStr);
    }
    this.onSuccess?.('Confluence');
    return await res.json();
  }

  async resolveRedirect(urlStr) {
    try {
      const headers = {
        Authorization: `Bearer ${this.token}`,
        'User-Agent': 'teams-live/1.0',
      };
      const res = await fetch(urlStr, {
        method: 'HEAD',
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(10_000),
      });
      return res.url;
    } catch {
      return null;
    }
  }

  async getPage(target) {
    if (!target) throw new Error('Page identifier or URL is required');

    // 1. Numeric ID
    if (typeof target === 'number' || (typeof target === 'string' && /^\d+$/.test(target.trim()))) {
      return await this.getPageById(String(target).trim());
    }

    // 2. Object target: { spaceKey, title }
    if (typeof target === 'object' && target !== null && target.spaceKey && target.title) {
      return await this.getPageBySpaceAndTitle(target.spaceKey, target.title, target.url);
    }

    // 3. Object target: { id }
    if (typeof target === 'object' && target !== null && target.id) {
      return await this.getPageById(target.id, target.url);
    }

    // 4. String URL
    if (typeof target === 'string') {
      const clean = target.trim();
      try {
        const parsed = new URL(clean);
        const parsedInfo = this.parseConfluenceUrl(parsed, clean);
        if (parsedInfo) {
          if (parsedInfo.id) {
            return await this.getPageById(parsedInfo.id, clean);
          }
          if (parsedInfo.spaceKey && parsedInfo.title) {
            return await this.getPageBySpaceAndTitle(parsedInfo.spaceKey, parsedInfo.title, clean);
          }
        }

        // Tiny link or redirecting URL
        const resolved = await this.resolveRedirect(clean);
        if (resolved && resolved !== clean) {
          const resolvedParsed = new URL(resolved);
          const resolvedInfo = this.parseConfluenceUrl(resolvedParsed, resolved);
          if (resolvedInfo) {
            if (resolvedInfo.id) return await this.getPageById(resolvedInfo.id, clean);
            if (resolvedInfo.spaceKey && resolvedInfo.title) {
              return await this.getPageBySpaceAndTitle(resolvedInfo.spaceKey, resolvedInfo.title, clean);
            }
          }
        }
      } catch {
        // Not a valid URL
      }
    }

    throw new Error(`Could not resolve Confluence page: ${typeof target === 'object' ? JSON.stringify(target) : target}`);
  }

  async getPageById(id, originalUrl = '') {
    const endpoint = `rest/api/content/${encodeURIComponent(id)}?expand=space,version`;
    const res = await this.request(endpoint);
    return this.formatPageResponse(res, originalUrl);
  }

  async getPageBySpaceAndTitle(spaceKey, title, originalUrl = '') {
    const params = new URLSearchParams({
      spaceKey,
      title,
      expand: 'space,version',
    });
    const res = await this.request(`rest/api/content?${params.toString()}`);
    const results = res.results || [];
    if (results.length === 0) return null;
    return this.formatPageResponse(results[0], originalUrl);
  }

  formatPageResponse(res, originalUrl = '') {
    const webui = res._links?.webui || '';
    let pageUrl = originalUrl;
    if (webui && this.baseUrl) {
      pageUrl = `${this.baseUrl}${webui.startsWith('/') ? '' : '/'}${webui}`;
    }

    return {
      id: res.id,
      title: res.title || '(No title)',
      spaceKey: res.space?.key || '',
      spaceName: res.space?.name || '',
      author: res.version?.by?.displayName || res.version?.by?.username || '',
      version: res.version?.number || null,
      url: pageUrl || originalUrl || (this.baseUrl ? `${this.baseUrl}/rest/api/content/${res.id}` : ''),
    };
  }
}

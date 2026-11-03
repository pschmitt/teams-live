export function humanizeRecipient(emailOrUsername) {
  if (!emailOrUsername) return '';
  const local = emailOrUsername.includes('@') ? emailOrUsername.split('@')[0] : emailOrUsername;
  return local
    .split('.')
    .map((part) =>
      part
        .split('-')
        .map((sub) => sub.charAt(0).toUpperCase() + sub.slice(1))
        .join('-')
    )
    .join(' ');
}

export function formatOnDuty(recipients) {
  if (!recipients || recipients.length === 0) return 'Off-duty';
  const names = recipients.map(humanizeRecipient).filter(Boolean);
  return names.length > 0 ? names.join(', ') : 'Off-duty';
}

export class OpsGenieClient {
  constructor({
    on_call_key = null,
    support_key = null,
    edge_key = null,
    on_call_schedule_id = '8aa71a67-9ddd-4571-af97-06d1ddb3c7cb',
    support_schedule_id = '5a044893-0255-4246-8606-8e76949a861d',
    base_url = 'https://api.eu.opsgenie.com/v2',
    web_base_url = 'https://germanedgecloudgmbh.app.opsgenie.com',
    onAuthError = null,
    onSuccess = null,
  } = {}) {
    this.onCallKey = on_call_key;
    this.supportKey = support_key;
    this.edgeKey = edge_key;
    this.onCallScheduleId = on_call_schedule_id;
    this.supportScheduleId = support_schedule_id;
    this.baseUrl = (base_url || 'https://api.eu.opsgenie.com/v2').replace(/\/+$/, '');
    this.webBaseUrl = (web_base_url || 'https://germanedgecloudgmbh.app.opsgenie.com').replace(/\/+$/, '');
    this.onAuthError = onAuthError;
    this.onSuccess = onSuccess;
  }

  isConfigured() {
    return Boolean(this.onCallKey || this.supportKey || this.edgeKey);
  }

  alertUrl(alert) {
    const id = alert.id || alert.tinyId;
    return `${this.webBaseUrl}/alert/detail/${id}/details`;
  }

  /**
   * Finds OpsGenie alert links in text.
   */
  findAlertLinks(text, { allowQuotes = false } = {}) {
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
        if (parsed.hostname.toLowerCase().includes('opsgenie.com')) {
          const m = parsed.pathname.match(/\/alert\/detail\/([a-zA-Z0-9\-]+)/i);
          if (m) {
            const id = m[1];
            if (!seen.has(id)) {
              seen.add(id);
              results.push({
                id,
                url: `${this.webBaseUrl}/alert/detail/${id}/details`,
              });
            }
          }
        }
      } catch {
        // Not a valid URL
      }
    }

    return results;
  }

  /**
   * Fetches single OpsGenie alert details by ID or tinyId.
   */
  async getAlert(identifier) {
    if (!identifier) throw new Error('Alert identifier is required');
    const keys = [this.onCallKey, this.supportKey, this.edgeKey].filter(Boolean);
    if (keys.length === 0) throw new Error('OpsGenie is not configured (missing API keys)');

    let lastError = null;
    for (const key of keys) {
      try {
        const url = `${this.baseUrl}/alerts/${encodeURIComponent(identifier)}?identifierType=id`;
        const res = await fetch(url, {
          headers: {
            Authorization: `GenieKey ${key}`,
            Accept: 'application/json',
            'User-Agent': 'teams-live/1.0',
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          this.onSuccess?.('OpsGenie');
          const data = await res.json();
          const alert = data.data;
          return {
            ...alert,
            url: this.alertUrl(alert),
          };
        }
        if (res.status === 401 || res.status === 403) {
          lastError = new Error(`OpsGenie HTTP ${res.status}`);
          continue;
        }
        if (res.status === 404) {
          const urlTiny = `${this.baseUrl}/alerts/${encodeURIComponent(identifier)}?identifierType=tinyId`;
          const resTiny = await fetch(urlTiny, {
            headers: {
              Authorization: `GenieKey ${key}`,
              Accept: 'application/json',
              'User-Agent': 'teams-live/1.0',
            },
            signal: AbortSignal.timeout(10_000),
          });
          if (resTiny.ok) {
            this.onSuccess?.('OpsGenie');
            const dataTiny = await resTiny.json();
            const alert = dataTiny.data;
            return {
              ...alert,
              url: this.alertUrl(alert),
            };
          }
        }
        lastError = new Error(`OpsGenie HTTP ${res.status}`);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error(`Alert ${identifier} not found`);
  }

  async fetchQueueAlerts(key, queueName) {
    if (!key) return [];
    const url = `${this.baseUrl}/alerts?query=status%3Aopen&limit=100&sort=createdAt&order=desc`;
    const makeFetch = () =>
      fetch(url, {
        headers: {
          Authorization: `GenieKey ${key}`,
          Accept: 'application/json',
          'User-Agent': 'teams-live/1.0',
        },
        signal: AbortSignal.timeout(15_000),
      });

    let res;
    try {
      res = await makeFetch();
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
      res = await makeFetch();
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const errStr = `OpsGenie HTTP ${res.status}: ${text || res.statusText}`;
      if (res.status === 401 || res.status === 403) {
        this.onAuthError?.(errStr);
      }
      throw new Error(errStr);
    }

    this.onSuccess?.('OpsGenie');
    const data = await res.json();
    return (data.data || []).map((alert) => ({
      ...alert,
      queue: queueName,
      url: this.alertUrl(alert),
    }));
  }

  async fetchOnDuty(key, scheduleId) {
    if (!key || !scheduleId) return [];
    const url = `${this.baseUrl}/schedules/${scheduleId}/on-calls?flat=true`;
    const makeFetch = () =>
      fetch(url, {
        headers: {
          Authorization: `GenieKey ${key}`,
          Accept: 'application/json',
          'User-Agent': 'teams-live/1.0',
        },
        signal: AbortSignal.timeout(10_000),
      });

    let res;
    try {
      res = await makeFetch();
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
      res = await makeFetch();
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const errStr = `OpsGenie on-call HTTP ${res.status}: ${text || res.statusText}`;
      if (res.status === 401 || res.status === 403) {
        this.onAuthError?.(errStr);
      }
      throw new Error(errStr);
    }

    this.onSuccess?.('OpsGenie');
    const data = await res.json();
    return data.data?.onCallRecipients || [];
  }

  async getAllOpenAlerts() {
    const [onCallRes, supportRes, onCallDutyRes, supportDutyRes] = await Promise.allSettled([
      this.fetchQueueAlerts(this.onCallKey, 'On-Call'),
      this.fetchQueueAlerts(this.supportKey, 'Support'),
      this.fetchOnDuty(this.onCallKey, this.onCallScheduleId),
      this.fetchOnDuty(this.supportKey, this.supportScheduleId),
    ]);

    const onCallAlerts = onCallRes.status === 'fulfilled' ? onCallRes.value : [];
    const supportAlerts = supportRes.status === 'fulfilled' ? supportRes.value : [];
    const onCallDuty = onCallDutyRes.status === 'fulfilled' ? onCallDutyRes.value : [];
    const supportDuty = supportDutyRes.status === 'fulfilled' ? supportDutyRes.value : [];

    const onCallError = onCallRes.status === 'rejected' ? onCallRes.reason.message : null;
    const supportError = supportRes.status === 'rejected' ? supportRes.reason.message : null;

    return {
      onCallAlerts,
      supportAlerts,
      onCallDuty,
      supportDuty,
      onCallError,
      supportError,
    };
  }
}

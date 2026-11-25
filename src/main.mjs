#!/usr/bin/env node
import { loadConfig } from './config.mjs';
import { AuthManager } from './auth.mjs';
import { GitLabClient } from './gitlab.mjs';
import { JiraClient } from './jira.mjs';
import { ConfluenceClient } from './confluence.mjs';
import { OpsGenieClient, humanizeRecipient } from './opsgenie.mjs';
import { getCalendarView } from './teams.mjs';
import { HRWorksClient } from './hrworks.mjs';
import { ScreenshotClient } from './screenshot.mjs';
import { TrouterClient } from './trouter.mjs';
import { MergeRequestWatcher } from './watcher.mjs';
import { GitLabWebhookServer } from './webhook.mjs';
import { ApproveServer } from './approve.mjs';
import { openGeoIp } from './geoip.mjs';
import { WebhookReconciler, isStrongSecret, MIN_SECRET_LENGTH } from './webhook-reconcile.mjs';
import { ensureOAuthApplication } from './oauth-reconcile.mjs';
import path from 'node:path';
import { SystemdWatchdog } from './systemd.mjs';
import { HealthMonitor } from './health.mjs';
import { getMessageAuthStatus } from 'msteams-mcp/dist/auth/token-extractor.js';
import { createLogger } from './logger.mjs';

const log = createLogger('main');

/**
 * What the dashboard shows besides the merge requests, read by the bot with its own accounts: the active sprint,
 * the open alerts with who is on duty, and the rest of the week's meetings (declined ones left out).
 */
function dashboardSources({ jira, opsgenie }) {
  return {
    sprint: jira.isConfigured() ? () => jira.getActiveSprintTasks() : null,
    // A ticket for the preview drawer, with what the sprint list leaves out (description, reporter, labels, dates).
    issue: jira.isConfigured()
      ? async (key) => {
          const fields = 'summary,status,assignee,reporter,priority,issuetype,description,labels,created,updated';
          const res = await jira.request(`rest/api/2/issue/${encodeURIComponent(key)}?fields=${fields}`, { resource: true });
          const f = res.fields || {};
          return {
            key: res.key,
            summary: f.summary || '(No summary)',
            status: f.status?.name || 'Unknown',
            statusCategory: f.status?.statusCategory?.key || '',
            assignee: f.assignee?.displayName || 'Unassigned',
            reporter: f.reporter?.displayName || '',
            priority: f.priority?.name || '',
            issueType: f.issuetype?.name || '',
            description: typeof f.description === 'string' ? f.description : '',
            labels: Array.isArray(f.labels) ? f.labels : [],
            created: f.created || '',
            updated: f.updated || '',
            url: jira.issueUrl(res.key),
          };
        }
      : null,
    // The tickets a merge request names in its branch or title (the same rules as the cards).
    issueKeys: jira.isConfigured() ? (mr) => jira.findAssociatedIssues({ title: mr.title, source_branch: mr.source, author: mr.author }).map((i) => i.key) : null,
    alert: opsgenie.isConfigured() ? (id) => opsgenie.getAlert(id) : null,
    // Moves a sprint ticket to a board column with the Jira transition that leads there: the target status's
    // category (to do, in progress) or, for review, a target status named like it. Returns the new status name.
    move: jira.isConfigured()
      ? async (key, column) => {
          const path = `rest/api/2/issue/${encodeURIComponent(key)}/transitions`;
          const { transitions = [] } = (await jira.request(path, { resource: true })) || {};
          const isReview = (t) => /review/i.test(t.to?.name || t.name || '');
          const pick = transitions.find((t) =>
            column === 'inReview' ? isReview(t) : column === 'inProgress' ? t.to?.statusCategory?.key === 'indeterminate' && !isReview(t) : t.to?.statusCategory?.key === 'new',
          );
          if (!pick) throw Object.assign(new Error('Jira offers no transition to that column for this ticket.'), { userFacing: true });
          await jira.request(path, { method: 'POST', body: { transition: { id: pick.id } }, resource: true });
          return pick.to?.name || pick.name;
        }
      : null,
    alerts: opsgenie.isConfigured()
      ? async () => {
          const r = await opsgenie.getAllOpenAlerts();
          if (r.onCallError && r.supportError) throw new Error(r.onCallError);
          return {
            alerts: [...r.onCallAlerts, ...r.supportAlerts],
            // Each person with the address OpsGenie knows: the dashboard finds their Teams photo by it.
            duty: [
              { queue: 'On-call', people: (r.onCallDuty || []).map((p) => ({ name: humanizeRecipient(p), email: String(p).includes('@') ? String(p) : '' })) },
              { queue: 'Support', people: (r.supportDuty || []).map((p) => ({ name: humanizeRecipient(p), email: String(p).includes('@') ? String(p) : '' })) },
            ],
          };
        }
      : null,
    meetings: async () => {
      const start = new Date();
      const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
      const res = await getCalendarView({ startDate: start.toISOString(), endDate: end.toISOString(), limit: 50 });
      if (!res.ok) throw new Error(res.error?.message || 'calendar view failed');
      return (res.value?.meetings || [])
        .filter((m) => m.myResponse !== 'Declined')
        .map((m) => ({ subject: m.subject, startTime: m.startTime, endTime: m.endTime, joinUrl: m.joinUrl || '', organizer: m.organizer?.name || '' }))
        .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
    },
  };
}

// CLI args
const args = process.argv.slice(2);
let configPath = null;
const configIdx = args.indexOf('--config');
if (configIdx !== -1 && args[configIdx + 1]) {
  configPath = args[configIdx + 1];
}

const VERBOSE = args.includes('--verbose');
const ALL = VERBOSE || args.includes('--all');
const JSON_MODE = args.includes('--json');
const COLOR = !JSON_MODE && process.stdout.isTTY && !process.env.NO_COLOR;

const paint = (code, text) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (text) => paint('2', text);
const NICK_COLORS = [31, 32, 33, 34, 35, 36, 91, 92, 93, 94, 95, 96];

function nick(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return paint(NICK_COLORS[hash % NICK_COLORS.length], name);
}

function clock(time) {
  const d = time ? new Date(time) : new Date();
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

const names = new Map();

function channelLabel(event, selfMri) {
  if (event.threadTopic) return `#${event.threadTopic}`;
  const dm = /^19:([0-9a-f-]{36})_([0-9a-f-]{36})@unq\.gbl\.spaces$/.exec(event.conversationId ?? '');
  if (dm) {
    const selfOid = selfMri?.split(':').pop();
    const otherMri = `8:orgid:${dm[1] === selfOid ? dm[2] : dm[1]}`;
    return `@${names.get(otherMri) ?? otherMri.slice(8, 16)}`;
  }
  return `#${(event.conversationId ?? '?').replace(/^19:/, '').slice(0, 16)}`;
}

function formatHuman(event, selfMri) {
  if (event.fromMri && event.from) names.set(event.fromMri, event.from);
  const prefix = `${dim(`[${clock(event.time)}]`)} ${channelLabel(event, selfMri)}`;
  const who = event.from || names.get(event.fromMri) || event.fromMri || '?';

  if (event.messageType === 'Control/Typing') return `${prefix} ${dim(`* ${who} is typing`)}`;
  if (event.messageType && !event.content) return `${prefix} ${dim(`* ${event.kind} ${event.messageType ?? ''}`.trim())}`;

  const tag = event.kind === 'MessageUpdate' ? dim(event.content ? ' (edited)' : ' (deleted)') : '';
  const body = (event.content ?? '').replace(/\n+/g, '\n    ');
  return `${prefix} <${nick(who)}>${tag} ${body}`;
}

async function main() {
  log('Starting teams-live...');
  const config = loadConfig(configPath);

  log(`Watched conversations: ${config.conversations.map((c) => `${c.name || ''} (${c.id})`).join(', ')}`);
  if (config.browser_daemon.url) {
    log(`Browser-daemon configured: ${config.browser_daemon.url} (profile: ${config.browser_daemon.profile})`);
  }
  log(`GitLab host: ${config.gitlab.host} (token present: ${!!config.gitlab.token})`);

  const authManager = new AuthManager(config);

  let watcher = null;
  let health = null;

  const handleAuthError = (service, errorMsg) => {
    if (health) health.setServiceStatus(service.toLowerCase(), false, errorMsg);
    if (watcher) watcher.notifyAdminAuthExpired(service, errorMsg);
  };

  const handleServiceSuccess = (service) => {
    if (health) health.setServiceStatus(service.toLowerCase(), true);
    if (watcher) watcher.notifyAdminAuthRecovered(service);
  };

  const gitlab = new GitLabClient({
    ...config.gitlab,
    onAuthError: (err) => handleAuthError('GitLab', err),
    onSuccess: () => handleServiceSuccess('GitLab'),
  });
  const jira = new JiraClient({
    ...config.jira,
    onAuthError: (err) => handleAuthError('Jira', err),
    onSuccess: () => handleServiceSuccess('Jira'),
  });
  const confluence = new ConfluenceClient({
    ...config.confluence,
    onAuthError: (err) => handleAuthError('Confluence', err),
    onSuccess: () => handleServiceSuccess('Confluence'),
  });
  const opsgenie = new OpsGenieClient({
    ...config.opsgenie,
    onAuthError: (err) => handleAuthError('OpsGenie', err),
    onSuccess: () => handleServiceSuccess('OpsGenie'),
  });

  let trouter = null;
  let webhookServer = null;
  let webhookReconciler = null;
  let approveServer = null;
  let stopping = false;

  const hrworks = new HRWorksClient({
    ...config.home_assistant,
    onAuthError: (err) => handleAuthError('HomeAssistant', err),
    onSuccess: () => handleServiceSuccess('HomeAssistant'),
  });

  const screenshot = new ScreenshotClient(config.browser_daemon);

  health = new HealthMonitor({
    gitlab,
    jira,
    confluence,
    opsgenie,
    hrworks,
    screenshot,
    authManager,
    getTrouter: () => trouter,
  });
  health.start(15_000);

  watcher = new MergeRequestWatcher({ config, gitlab, jira, confluence, opsgenie, hrworks, screenshot, authManager, health });
  const systemd = new SystemdWatchdog();

  const cleanup = async (signal = 'SIGTERM') => {
    if (stopping) return;
    stopping = true;
    log(`Shutting down teams-live (signal: ${signal})...`);
    systemd.notify(['--stopping', '--status=Shutting down...']);
    systemd.stop();
    if (health) health.stop();
    try {
      await watcher.sendShutdownAnnouncement(signal);
    } catch (err) {
      log(`Failed to send shutdown announcement: ${err.message}`);
    }
    watcher.stop();
    authManager.stop();
    webhookReconciler?.stop();
    if (webhookServer) {
      await webhookServer.stop().catch((e) => log(`Error stopping webhook server: ${e.message}`));
    }
    if (approveServer) {
      await approveServer.stop().catch((e) => log(`Error stopping approval server: ${e.message}`));
    }
    if (trouter) trouter.close();
    process.exit(0);
  };

  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));

  // Start GitLab webhook server and reconcile the group webhook if enabled
  if (config.gitlab?.webhook?.enable) {
    const whCfg = config.gitlab.webhook;
    const manage = Boolean(whCfg.auto_setup && whCfg.url && gitlab.token && whCfg.secret);
    if (whCfg.auto_setup && whCfg.url && whCfg.secret && !isStrongSecret(whCfg.secret)) {
      log.warn(`The GitLab webhook secret is shorter than ${MIN_SECRET_LENGTH} characters: hooks are registered but never replaced or cleaned up.`);
    }
    if (whCfg.auto_setup && whCfg.url && !whCfg.secret) {
      log.warn('No GitLab webhook secret configured: the hook is registered without one and never replaced or cleaned up.');
    }
    if (manage) {
      webhookReconciler = new WebhookReconciler({
        gitlab,
        url: whCfg.url,
        secret: whCfg.secret,
        stateFile: path.join(config.gitlab.state_dir, 'webhook-reconcile.json'),
        events: { merge_requests: true, pipeline: true },
        adoptHooks: whCfg.adopt_hooks,
        acceptSharedSecret: whCfg.accept_shared_secret,
        log,
      });
      // The receiver must know the generation tokens before any hook exists.
      try {
        webhookReconciler.loadState();
      } catch (err) {
        log.warn(`Webhook state unusable (${err.message}): hook management is off`);
        webhookReconciler = null;
      }
    }
    webhookServer = new GitLabWebhookServer({
      port: whCfg.port,
      host: whCfg.host,
      path: whCfg.path,
      secret: whCfg.secret,
      acceptedTokens: webhookReconciler && webhookReconciler.managed ? () => webhookReconciler.acceptedTokens() : null,
      onDelivery: webhookReconciler ? (genId) => webhookReconciler.noteDelivery(genId) : null,
      onEvent: (eventType, payload) => {
        watcher.handleWebhookEvent(eventType, payload);
      },
    });
    watcher.setWebhookServer(webhookServer);

    try {
      await webhookServer.start();
    } catch (err) {
      log(`Failed to start GitLab webhook server: ${err.message}`);
    }

    const publishStatus = (result) => {
      watcher.setWebhookSetupStatus({
        ok: result.ok,
        action: result.action,
        hookId: result.hook?.id ?? null,
        url: whCfg.url,
        group: gitlab.group,
        pendingCleanup: result.pendingCleanup ?? 0,
        error: result.error,
        timestamp: Date.now(),
      });
    };

    if (whCfg.auto_setup && whCfg.url && gitlab.token) {
      if (!webhookReconciler) {
        // No secret: register only, never replace or delete anything.
        webhookReconciler = new WebhookReconciler({
          gitlab,
          url: whCfg.url,
          secret: whCfg.secret,
          stateFile: path.join(config.gitlab.state_dir, 'webhook-reconcile.json'),
          events: { merge_requests: true, pipeline: true },
          adoptHooks: whCfg.adopt_hooks,
          intervalMs: 0,
          log,
        });
      }
      log(`Reconciling the GitLab group webhook for ${whCfg.url}...`);
      const result = await webhookReconciler.start();
      log(`GitLab group webhook status: ${result.action}${result.ok ? '' : ` (${result.error})`}`);
      publishStatus(result);
      webhookReconciler.onStatus = publishStatus;
    } else if (whCfg.enable) {
      watcher.setWebhookSetupStatus({
        ok: true,
        action: 'manual',
        hookId: null,
        url: whCfg.url || null,
        group: gitlab.group,
        timestamp: Date.now(),
      });
    }
  }

  // Approve button: capability-link confirmation page (fails closed when misconfigured)
  const apCfg = config.gitlab?.approve;
  if (apCfg?.enable) {
    if (config.teams?.rich_messages !== true) {
      log.warn('GitLab approval flow is enabled but teams.rich_messages is off: no Approve button will be shown.');
    }
    let geoip = null;
    if (apCfg.geoip_database) {
      try {
        geoip = openGeoIp(apCfg.geoip_database);
      } catch (err) {
        log.warn(`GeoIP database not used (${apCfg.geoip_database}): ${err.message}`);
      }
    }
    try {
      const configuredOauth = apCfg.oauth?.client_id && apCfg.oauth?.client_secret
        ? { clientId: apCfg.oauth.client_id, clientSecret: apCfg.oauth.client_secret }
        : null;
      if (!configuredOauth && (apCfg.oauth?.client_id || apCfg.oauth?.client_secret)) {
        throw new Error('Configure both GitLab OAuth client ID and secret, or neither');
      }
      let oauth = configuredOauth;
      if (apCfg.oauth?.auto_setup) {
        try {
          oauth = await ensureOAuthApplication({ gitlab, baseUrl: apCfg.base_url, stateFile: apCfg.oauth.state_file || path.join(config.gitlab.state_dir, 'gitlab-oauth.json') });
          log('GitLab OAuth application is ready');
        } catch (err) {
          if (!configuredOauth) throw new Error(`GitLab OAuth automatic setup failed: ${err.message}`);
          log.warn(`GitLab OAuth automatic setup failed${configuredOauth ? '; using configured credentials' : ''}: ${err.message}`);
        }
      }
      approveServer = new ApproveServer({
        gitlab,
        baseUrl: apCfg.base_url,
        host: apCfg.host,
        port: apCfg.port,
        linkTtlSeconds: apCfg.link_ttl_seconds,
        mergeEnabled: apCfg.merge_enabled === true,
        rebaseEnabled: apCfg.rebase_enabled !== false,
        avatarOf: (name) => watcher.webAvatarOf(name),
        avatarWarm: (names) => watcher.webAvatarWarm(names),
        // A cached photo of a person ({name, email}) or null, without the initials fallback.
        avatarPeek: (person) => (watcher.suppressAvatars ? null : watcher.avatarService?.peek?.(person)) || null,
        recordApprover: (project, iid, user) => watcher.recordWebApprover(project, iid, user),
        stateFile: path.join(config.gitlab.state_dir, 'approve-links.json'),
        dashSessionFile: path.join(config.gitlab.state_dir, 'dashboard-sessions.json'),
        pushFile: path.join(config.gitlab.state_dir, 'dashboard-push.json'),
        refreshCards: (project, iid) => watcher.refreshMrCards(project, iid),
        locateCard: (project, iid) => watcher.mrCardMessage(project, iid),
        geoip,
        oauth: oauth ? { ...oauth, allowedUsers: apCfg.oauth.allowed_users } : null,
        dashboard: apCfg.dashboard?.enable
          ? {
              enable: true,
              group: config.gitlab.group,
              path: apCfg.dashboard.path,
              timeZone: apCfg.dashboard.time_zone,
              push: apCfg.dashboard.push,
              sources: dashboardSources({ jira, opsgenie }),
            }
          : null,
      });
      await approveServer.start();
      watcher.setApproveFlow(approveServer);
    } catch (err) {
      log.warn(`GitLab approval flow not started: ${err.message}`);
      approveServer = null;
    }
  }

  // Initial auth check / self-heal
  let currentAuth = await authManager.ensureValidAuth();
  watcher.setSelfMri(currentAuth.userMri);
  authManager.startProactiveRefresh(config.teams.token_refresh_interval_minutes);

  // Historical scan
  try {
    await watcher.watchHistory();
  } catch (err) {
    log(`Initial history scan failed: ${err.message}`);
  }

  // Start polling GitLab
  // Who the bot's GitLab accounts are, so MR cards can show who an approval was made for.
  watcher.refreshBotNames().catch(() => {});
  watcher.startPolling();

  // Startup announcement (self-chat only)
  watcher.sendStartupAnnouncement().catch((err) => {
    log(`Startup announcement failed: ${err.message}`);
  });

  trouter = new TrouterClient({
    verbose: VERBOSE,
    all: ALL,
    getAuth: () => authManager.getCachedAuth() ?? currentAuth,
    registrationIntervalMs: config.teams.registration_interval_minutes * 60 * 1000,
    maxSessionMs: config.teams.max_session_minutes * 60 * 1000,
    onEvent: (event) => {
      if (JSON_MODE) {
        console.log(JSON.stringify(event));
      } else {
        console.log(formatHuman(event, currentAuth.userMri));
      }
      watcher.handleIncomingEvent(event);
    },
  });

  // Start systemd watchdog
  systemd.start(() => {
    const h = health.getHealth();
    return {
      ok: h.status !== 'unhealthy',
      status:
        h.status === 'healthy'
          ? `Connected 🟢 (token: ${h.teams.minutes_remaining}m)`
          : `Degraded (${h.errors.join(', ')})`,
    };
  });

  // Fallback for pushes that Teams silently stops delivering: poll the watched
  // conversations; a message found there but never pushed forces a reconnect.
  watcher.startHistoryPoll(config.teams.history_poll_interval_seconds * 1000, {
    onMissedPush: (count) => {
      if (trouter?.isConnected()) trouter.reconnect(`history poll found ${count} message(s) that were never pushed`);
    },
  });

  // Main reconnect loop
  let connectCount = 0;
  while (!stopping) {
    try {
      currentAuth = await authManager.ensureValidAuth();
      watcher.setSelfMri(currentAuth.userMri);
      systemd.ready('Connecting to Trouter...');
      if (connectCount++ > 0) {
        // Catch messages sent while the previous session was down.
        watcher.pollHistory({ reason: 'reconnect' }).catch((err) => log(`Catch-up history scan failed: ${err.message}`));
      }
      await trouter.connect(currentAuth);
    } catch (err) {
      log(`Connection error: ${err.message}`);
      // If error might be auth-related, force browser-daemon reauth on next round
      if (err.message.includes('401') || err.message.includes('Unauthorized') || err.message.includes('auth')) {
        try {
          currentAuth = await authManager.ensureValidAuth({ forceDaemon: true });
        } catch (e) {
          log(`Failed to re-authenticate: ${e.message}`);
        }
      }
    }

    if (!stopping) {
      const waitSec = config.teams.reconnect_interval_seconds || 5;
      log(`Reconnecting in ${waitSec} seconds...`);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
    }
  }
}

main().catch((err) => {
  log.error('Fatal error in teams-live:', err);
  process.exit(1);
});

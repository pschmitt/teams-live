#!/usr/bin/env node
import { loadConfig } from './config.mjs';
import { AuthManager } from './auth.mjs';
import { GitLabClient } from './gitlab.mjs';
import { JiraClient } from './jira.mjs';
import { ConfluenceClient } from './confluence.mjs';
import { OpsGenieClient } from './opsgenie.mjs';
import { HRWorksClient } from './hrworks.mjs';
import { ScreenshotClient } from './screenshot.mjs';
import { TrouterClient } from './trouter.mjs';
import { MergeRequestWatcher } from './watcher.mjs';
import { SystemdWatchdog } from './systemd.mjs';
import { HealthMonitor } from './health.mjs';
import { getMessageAuthStatus } from 'msteams-mcp/dist/auth/token-extractor.js';

const log = (...args) => console.error(new Date().toISOString(), '[main]', ...args);

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
    if (trouter) trouter.close();
    process.exit(0);
  };

  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));

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
  console.error('Fatal error in teams-live:', err);
  process.exit(1);
});

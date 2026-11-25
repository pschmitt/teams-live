import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { normalizeTvConfig } from './tv.mjs';
import { createLogger } from './logger.mjs';

const log = createLogger('config');

/**
 * Where a rotated fallback token waits until it replaces the override file. A
 * rotation revokes the old token, so the new one must reach the disk before
 * anything else can fail; startup picks it up from here.
 */
export const fallbackTokenPendingPath = (overridePath) => `${overridePath}.pending`;

/** Writes `token` to `target` via a synced temporary file and an atomic rename (mode 0600). */
function writeTokenFile(target, token) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, token, 'utf8');
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(temporary); } catch { /* no temporary file */ }
    throw error;
  }
  fs.closeSync(fd);
  fs.renameSync(temporary, target);
}

/**
 * Saves a rotated fallback token in two steps: first as the pending file (the
 * durable copy), then over the override file. If the first step throws, nothing
 * was saved. If only the second throws, the error carries `pendingPath`: the
 * token is safe there and the next start loads it.
 */
export function persistFallbackToken(overridePath, token) {
  const pending = fallbackTokenPendingPath(overridePath);
  writeTokenFile(pending, token);
  try {
    fs.renameSync(pending, overridePath);
  } catch (error) {
    error.pendingPath = pending;
    throw error;
  }
}

/** Overwrites `target` in place (it may be a mount or symlink that a rename must not replace), synced. */
function writeTokenFileInPlace(target, token) {
  const fd = fs.openSync(target, 'w', 0o600);
  try {
    fs.writeFileSync(fd, token, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Saves a rotated GitLab token (the old one is already revoked). The token first
 * goes to `pendingPath`, the durable copy. It then replaces the first of `targets`
 * (`{ path, inPlace }`, tried in order) that accepts it: `inPlace` overwrites the
 * file, otherwise the pending file is renamed onto it. Returns the target that
 * got the token. If the pending file cannot be written the error is plain and
 * nothing was saved; if only the targets failed the error carries `pendingPath`:
 * the token is safe there and the next start loads it.
 */
export function persistGitLabToken(token, { pendingPath, targets }) {
  writeTokenFile(pendingPath, token);
  const failures = [];
  for (const { path: target, inPlace = false } of targets) {
    try {
      if (inPlace) {
        writeTokenFileInPlace(target, token);
        try { fs.unlinkSync(pendingPath); } catch { /* it only repeats the saved token */ }
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.renameSync(pendingPath, target);
      }
      return target;
    } catch (error) {
      failures.push(`${target}: ${error.code || error.message}`);
    }
  }
  const error = new Error(`could not write ${failures.join('; ') || 'any target'}`);
  error.pendingPath = pendingPath;
  throw error;
}

/**
 * Returns the token of a rotation that only reached `<target>.pending` (newer than
 * `target`), or '' when there is none or it is unreadable. The file is moved onto
 * `target`; if that fails the token is still returned and the file stays.
 */
export function recoverPendingToken(target) {
  const pending = fallbackTokenPendingPath(target);
  if (!fs.existsSync(pending)) return '';
  let token = '';
  try {
    token = fs.readFileSync(pending, 'utf8').trim();
  } catch (e) {
    log.warn(`Could not read pending GitLab token ${pending}: ${e.message}`);
  }
  if (!token) return '';
  try {
    fs.renameSync(pending, target);
  } catch (e) {
    log.warn(`Using pending GitLab token ${pending}; could not move it to ${target}: ${e.message}`);
  }
  return token;
}

function stripYamlComments(text) {
  return text
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('#');
      if (idx === -1) return line;
      const quoteCount = (line.slice(0, idx).match(/["']/g) || []).length;
      return quoteCount % 2 === 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
}

/**
 * Profile pictures on cards (see avatars.mjs): `fallback_sources` is the ordered
 * list of services asked when Teams has no picture (default Jira, then
 * Confluence; an empty list turns the fallbacks off), `overrides` maps the full
 * display name of an account that exists in no directory (a bot) to a small
 * PNG or JPEG file.
 */
export function normalizeAvatarsConfig(raw) {
  const getString = (val) => (typeof val === 'string' ? val : '');
  const known = ['jira', 'confluence'];
  const sources = Array.isArray(raw?.fallback_sources)
    ? raw.fallback_sources.map((s) => String(s).trim().toLowerCase()).filter((s) => known.includes(s))
    : known;
  const overrides = Array.isArray(raw?.overrides)
    ? raw.overrides
        .map((o) => ({ name: getString(o?.name).trim(), file: getString(o?.file).trim() }))
        .filter((o) => o.name && o.file)
    : [];
  return { fallback_sources: [...new Set(sources)], overrides };
}

export function parseConfigFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch (err) {
    try {
      const stripped = stripYamlComments(raw);
      return JSON.parse(stripped);
    } catch {
      throw new Error(`Failed to parse config file ${filePath} as JSON/YAML: ${err.message}`);
    }
  }
}

const isSecretRef = (val) =>
  val !== null &&
  typeof val === 'object' &&
  !Array.isArray(val) &&
  Object.keys(val).length === 1 &&
  typeof val._secret === 'string';

// Replace every `{ "_secret": "/path" }` in the config with the trimmed contents
// of that file, so a config file can live in the Nix store without secrets.
export function resolveSecrets(val, where = 'config') {
  if (isSecretRef(val)) {
    try {
      return fs.readFileSync(val._secret, 'utf8').trim();
    } catch (err) {
      throw new Error(`Could not read secret for ${where} from ${val._secret}: ${err.message}`);
    }
  }
  if (Array.isArray(val)) return val.map((v, i) => resolveSecrets(v, `${where}[${i}]`));
  if (val !== null && typeof val === 'object') {
    return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, resolveSecrets(v, `${where}.${k}`)]));
  }
  return val;
}

export function loadConfig(configPath) {
  let fileConfig = {};
  if (configPath) {
    fileConfig = parseConfigFile(configPath);
  } else if (process.env.TEAMS_LIVE_CONFIG) {
    fileConfig = parseConfigFile(process.env.TEAMS_LIVE_CONFIG);
  }
  fileConfig = resolveSecrets(fileConfig);

  const getString = (val) => (typeof val === 'string' ? val : '');
  const getNullableString = (val) => (typeof val === 'string' ? val : null);

  const browserDaemon = {
    url: getString(fileConfig.browser_daemon?.url) || process.env.TEAMS_MCP_BROWSER_DAEMON_URL || '',
    profile: getString(fileConfig.browser_daemon?.profile) || process.env.TEAMS_MCP_BROWSER_DAEMON_PROFILE || 'work',
    node_group: getString(fileConfig.browser_daemon?.node_group) || process.env.TEAMS_MCP_BROWSER_DAEMON_NODE_GROUP || '',
    secret_file: getNullableString(fileConfig.browser_daemon?.secret_file) || process.env.BROWSER_DAEMON_SECRET_FILE || null,
  };

  let browserDaemonSecret = null;
  if (browserDaemon.secret_file && fs.existsSync(browserDaemon.secret_file)) {
    try {
      browserDaemonSecret = fs.readFileSync(browserDaemon.secret_file, 'utf8').trim();
    } catch (e) {
      log.warn(`Could not read browser-daemon secret file ${browserDaemon.secret_file}: ${e.message}`);
    }
  }

  const rawNotify = fileConfig.gitlab?.notify ?? {};
  const notifyCi = typeof rawNotify.ci === 'object' ? rawNotify.ci : {};

  const notify = {
    ci: {
      enable:
        notifyCi.enable ??
        (typeof rawNotify.ci === 'boolean' ? rawNotify.ci : (fileConfig.gitlab?.notify_ci ?? true)),
      on_failure: notifyCi.on_failure ?? fileConfig.gitlab?.notify_ci_on_failure ?? true,
      on_success: notifyCi.on_success ?? fileConfig.gitlab?.notify_ci_on_success ?? true,
    },
    rebase: rawNotify.rebase ?? fileConfig.gitlab?.notify_rebase ?? true,
    approval_lost: rawNotify.approval_lost ?? fileConfig.gitlab?.notify_approval_lost ?? false,
    merged: rawNotify.merged ?? fileConfig.gitlab?.notify_merged ?? true,
    closed: rawNotify.closed ?? fileConfig.gitlab?.notify_closed ?? true,
  };

  const gitlab = {
    host: (getString(fileConfig.gitlab?.host) || process.env.GITLAB_HOST || 'git.wiit.one')
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, ''),
    group: (getString(fileConfig.gitlab?.group) || process.env.GITLAB_GROUP || '').trim(),
    token_file: getNullableString(fileConfig.gitlab?.token_file) || process.env.GITLAB_TOKEN_FILE || null,
    token: null,
    poll_interval_seconds: Number(fileConfig.gitlab?.poll_interval_seconds ?? process.env.TEAMS_GITLAB_INTERVAL ?? 60),
    history_limit: Number(fileConfig.gitlab?.history_limit ?? process.env.TEAMS_GITLAB_HISTORY ?? 50),
    notify,
    notify_ci: notify.ci.enable,
    notify_ci_on_failure: notify.ci.on_failure,
    notify_ci_on_success: notify.ci.on_success,
    notify_approval_lost: notify.approval_lost,
    notify_rebase: notify.rebase,
    notify_merged: notify.merged,
    notify_closed: notify.closed,
    max_watch_duration_seconds: Number(
      fileConfig.gitlab?.max_watch_duration_seconds ?? process.env.TEAMS_MAX_WATCH_DURATION ?? 7200
    ),
    history_max_age_minutes: Number(
      fileConfig.gitlab?.history_max_age_minutes ?? process.env.TEAMS_GITLAB_HISTORY_MAX_AGE_MINUTES ?? 10
    ),
  };

  // Preview of the lines a GitLab blob link with a line anchor points at.
  const rawCodePreview = fileConfig.gitlab?.code_preview ?? {};
  const codePreviewEnv = process.env.TEAMS_GITLAB_CODE_PREVIEW;
  const codePreviewMaxLines = Math.floor(
    Number(rawCodePreview.max_lines ?? process.env.TEAMS_GITLAB_CODE_PREVIEW_MAX_LINES ?? 30)
  );
  gitlab.code_preview = {
    enable: Boolean(
      rawCodePreview.enable ?? (codePreviewEnv ? codePreviewEnv === 'true' || codePreviewEnv === '1' : true)
    ),
    max_lines: Number.isFinite(codePreviewMaxLines) && codePreviewMaxLines > 0 ? codePreviewMaxLines : 30,
    // gitlab.group scopes MR monitoring; links to other projects on the host are
    // previewed too (with the token's permissions) unless this is switched on.
    // Only the authenticated user's own messages trigger a preview, so other chat
    // participants cannot make the token read repository files into the chat.
    allow_other_senders: Boolean(
      rawCodePreview.allow_other_senders ??
        (process.env.TEAMS_GITLAB_CODE_PREVIEW_ALLOW_OTHER_SENDERS
          ? ['true', '1'].includes(process.env.TEAMS_GITLAB_CODE_PREVIEW_ALLOW_OTHER_SENDERS)
          : false)
    ),
    restrict_to_group: Boolean(
      rawCodePreview.restrict_to_group ??
        (process.env.TEAMS_GITLAB_CODE_PREVIEW_RESTRICT_TO_GROUP
          ? ['true', '1'].includes(process.env.TEAMS_GITLAB_CODE_PREVIEW_RESTRICT_TO_GROUP)
          : false)
    ),
  };

  const rawWebhook = fileConfig.gitlab?.webhook ?? {};
  const webhook = {
    enable: Boolean(
      rawWebhook.enable ??
        (process.env.TEAMS_GITLAB_WEBHOOK_ENABLE
          ? process.env.TEAMS_GITLAB_WEBHOOK_ENABLE === 'true' || process.env.TEAMS_GITLAB_WEBHOOK_ENABLE === '1'
          : false)
    ),
    port: Number(rawWebhook.port ?? process.env.TEAMS_GITLAB_WEBHOOK_PORT ?? 3000),
    host: getString(rawWebhook.host) || process.env.TEAMS_GITLAB_WEBHOOK_HOST || '0.0.0.0',
    path: getString(rawWebhook.path) || process.env.TEAMS_GITLAB_WEBHOOK_PATH || '/webhook/gitlab',
    url: (getString(rawWebhook.url) || process.env.TEAMS_GITLAB_WEBHOOK_URL || '').trim(),
    secret_file: getNullableString(rawWebhook.secret_file) || process.env.TEAMS_GITLAB_WEBHOOK_SECRET_FILE || null,
    secret: null,
    auto_setup: Boolean(
      rawWebhook.auto_setup ??
        (process.env.TEAMS_GITLAB_WEBHOOK_AUTO_SETUP !== undefined
          ? process.env.TEAMS_GITLAB_WEBHOOK_AUTO_SETUP === 'true' || process.env.TEAMS_GITLAB_WEBHOOK_AUTO_SETUP === '1'
          : true)
    ),
    // Hooks created by hand that this service may take over: [{id, url}].
    adopt_hooks: (Array.isArray(rawWebhook.adopt_hooks) ? rawWebhook.adopt_hooks : [])
      .map((h) => ({ id: Number(h?.id), url: getString(h?.url).trim() }))
      .filter((h) => Number.isInteger(h.id) && h.id > 0 && h.url),
    // Keep accepting the shared secret next to the per-hook tokens.
    accept_shared_secret: Boolean(
      rawWebhook.accept_shared_secret ??
        (process.env.TEAMS_GITLAB_WEBHOOK_ACCEPT_SHARED_SECRET === 'true' ||
          process.env.TEAMS_GITLAB_WEBHOOK_ACCEPT_SHARED_SECRET === '1')
    ),
  };

  if (webhook.secret_file && fs.existsSync(webhook.secret_file)) {
    try {
      webhook.secret = fs.readFileSync(webhook.secret_file, 'utf8').trim();
    } catch (e) {
      log.warn(`Could not read GitLab webhook secret file ${webhook.secret_file}: ${e.message}`);
    }
  } else if (process.env.TEAMS_GITLAB_WEBHOOK_SECRET) {
    webhook.secret = process.env.TEAMS_GITLAB_WEBHOOK_SECRET.trim();
  } else if (typeof rawWebhook.secret === 'string' && rawWebhook.secret) {
    webhook.secret = rawWebhook.secret.trim();
  }

  gitlab.webhook = webhook;

  const rawApprove = fileConfig.gitlab?.approve ?? {};
  const envBool = (value) => (value === undefined ? undefined : value === 'true' || value === '1');
  const approve = {
    enable: Boolean(rawApprove.enable ?? envBool(process.env.TEAMS_GITLAB_APPROVE_ENABLE) ?? false),
    host: getString(rawApprove.host) || process.env.TEAMS_GITLAB_APPROVE_HOST || '127.0.0.1',
    port: Number(rawApprove.port ?? process.env.TEAMS_GITLAB_APPROVE_PORT ?? 3006),
    // The Merge button is a separate opt-in on top of `enable` (default off). Strict on purpose: only
    // the JSON boolean `true` (or the env value "true"/"1") turns it on, so "false", 0 or "no" never do.
    merge_enabled: rawApprove.merge_enabled === undefined
      ? envBool(process.env.TEAMS_GITLAB_APPROVE_MERGE_ENABLED) === true
      : rawApprove.merge_enabled === true,
    // The Rebase button is on with the flow; only an explicit false (or env "false"/"0") turns it off.
    rebase_enabled: rawApprove.rebase_enabled === undefined ? envBool(process.env.TEAMS_GITLAB_APPROVE_REBASE_ENABLED) !== false : rawApprove.rebase_enabled !== false,
    base_url: (getString(rawApprove.base_url) || process.env.TEAMS_GITLAB_APPROVE_BASE_URL || '').trim(),
    // Lifetime of a link in seconds (default 24 h); the server bounds it to 60 s .. 7 d.
    link_ttl_seconds: Number(rawApprove.link_ttl_seconds ?? process.env.TEAMS_GITLAB_APPROVE_LINK_TTL_SECONDS ?? 86400),
    // Optional MaxMind DB file (e.g. DB-IP City Lite): the comment an Approve-button approval leaves on the
    // merge request then says where the approving address is. Read locally; no address is sent anywhere.
    geoip_database: (getString(rawApprove.geoip_database) || process.env.TEAMS_GITLAB_APPROVE_GEOIP_DATABASE || '').trim(),
    // Optional "Sign in with GitLab" before a confirmation: an OAuth application (api scope) on the GitLab
    // host. `client_secret` comes from a `{ _secret: path }` reference. `allowed_users` (usernames) is optional.
    oauth: {
      auto_setup: rawApprove.oauth?.auto_setup === true,
      state_file: (getString(rawApprove.oauth?.state_file) || '').trim(),
      client_id: (getString(rawApprove.oauth?.client_id) || process.env.TEAMS_GITLAB_APPROVE_OAUTH_CLIENT_ID || '').trim(),
      client_secret: (getString(rawApprove.oauth?.client_secret) || process.env.TEAMS_GITLAB_APPROVE_OAUTH_CLIENT_SECRET || '').trim(),
      allowed_users: Array.isArray(rawApprove.oauth?.allowed_users) ? rawApprove.oauth.allowed_users.map(String) : [],
    },
    // The signed-in dashboard (`<base_url>/dashboard`): needs `oauth` and `gitlab.group`; members of the group (and
    // of `oauth.allowed_users` when set) see the group's merge requests, the sprint, alerts and meetings. Off by default.
    dashboard: {
      enable: (rawApprove.dashboard?.enable ?? envBool(process.env.TEAMS_GITLAB_APPROVE_DASHBOARD_ENABLE)) === true,
      // Its own path on the base_url host (e.g. "/dashboard"); empty: `<base_url>/dashboard`. The proxy must forward it.
      path: (getString(rawApprove.dashboard?.path) || process.env.TEAMS_GITLAB_APPROVE_DASHBOARD_PATH || '').trim(),
      time_zone: (getString(rawApprove.dashboard?.time_zone) || process.env.TEAMS_GITLAB_APPROVE_DASHBOARD_TIME_ZONE || 'Europe/Berlin').trim(),
    },
  };
  for (const removed of ['owner_users', 'owner_users_file', 'user_header', 'proxy_secret', 'proxy_secret_file', 'proxy_secret_header']) {
    if (rawApprove[removed] !== undefined) {
      log.warn(`gitlab.approve.${removed} is no longer used (approval links are capability links) and is ignored.`);
    }
  }
  gitlab.approve = approve;
  // Who may approve with a 👍 reaction on a merge request message: `anyone` (the default: whoever reacts, except the
  // author of the merge request) or `self` (only the account teams-live runs as, and configured admins).
  gitlab.reaction_approvers = fileConfig.gitlab?.reaction_approvers === 'self' ? 'self' : 'anyone';
  // Explicit Teams MRI to credential-index bindings. Never infer a credential from a display name.
  gitlab.user_token_mappings = Array.isArray(fileConfig.gitlab?.user_token_mappings)
    ? fileConfig.gitlab.user_token_mappings.filter((m) => typeof m?.teams_mri === 'string' && typeof m?.gitlab_username === 'string' && Number.isInteger(m.token_index) && m.token_index > 0)
    : [];

  const stateDir = process.env.XDG_STATE_HOME || path.join(process.cwd(), 'state');
  const homeDir = process.env.HOME;
  const overridePaths = [];
  if (homeDir && homeDir !== '/' && homeDir !== '/root') {
    overridePaths.push(path.join(homeDir, 'overrides', 'gitlab-token'));
    overridePaths.push(path.join(homeDir, 'gitlab-token'));
  }
  overridePaths.push(path.join(stateDir, 'overrides', 'gitlab-token'));
  overridePaths.push(path.join(stateDir, 'gitlab-token'));
  let overrideToken = null;
  let overrideTokenPath = null;
  // A pending file is a rotation that did not reach its override file: it is the newest token.
  for (const p of overridePaths) {
    const recovered = recoverPendingToken(p);
    if (recovered) {
      overrideToken = recovered;
      overrideTokenPath = p;
      break;
    }
  }
  for (const p of overrideToken ? [] : overridePaths) {
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf8').trim();
        if (content) {
          overrideToken = content;
          overrideTokenPath = p;
          break;
        }
      } catch (e) {
        log.warn(`Could not read GitLab token override file ${p}: ${e.message}`);
      }
    }
  }

  gitlab.state_dir = stateDir;
  if (overrideToken) {
    gitlab.token = overrideToken;
    gitlab.override_token_path = overrideTokenPath;
    gitlab.is_token_override = true;
  } else {
    gitlab.is_token_override = false;
    gitlab.override_token_path = null;
    if (gitlab.token_file && fs.existsSync(gitlab.token_file)) {
      try {
        gitlab.token = fs.readFileSync(gitlab.token_file, 'utf8').trim();
      } catch (e) {
        log.warn(`Could not read GitLab token file ${gitlab.token_file}: ${e.message}`);
      }
    } else if (process.env.GITLAB_TOKEN) {
      gitlab.token = process.env.GITLAB_TOKEN.trim();
    } else if (typeof fileConfig.gitlab?.token === 'string' && fileConfig.gitlab.token) {
      gitlab.token = fileConfig.gitlab.token.trim();
    }
  }

  gitlab.fallback_tokens = [];
  gitlab.fallback_token_sources = [];
  const tokenOverrideBase = (homeDir && homeDir !== '/' && homeDir !== '/root' ? homeDir : null) || stateDir;
  for (const file of Array.isArray(fileConfig.gitlab?.fallback_token_files) ? fileConfig.gitlab.fallback_token_files : []) {
    if (typeof file !== 'string' || !file) continue;
    const key = createHash('sha256').update(file).digest('hex');
    const override = path.join(tokenOverrideBase, 'overrides', `gitlab-token-${key}`);
    try {
      // A pending file is a rotation that did not reach the override: it is newer than both.
      const recovered = recoverPendingToken(override);
      const token = recovered || fs.readFileSync(fs.existsSync(override) ? override : file, 'utf8').trim();
      if (token && token !== gitlab.token && !gitlab.fallback_tokens.includes(token)) {
        gitlab.fallback_tokens.push(token);
        gitlab.fallback_token_sources.push({ file, override });
      }
    } catch (e) {
      log.warn(`Could not read GitLab fallback token file ${file}: ${e.message}`);
    }
  }

  const jira = {
    url: (getString(fileConfig.jira?.url) || process.env.JIRA_URL || '').replace(/\/+$/, ''),
    token_file: getNullableString(fileConfig.jira?.token_file) || process.env.JIRA_TOKEN_FILE || null,
    token: null,
    board_id: (getString(fileConfig.jira?.board_id) || process.env.JIRA_BOARD_ID || '').trim(),
  };

  if (jira.token_file && fs.existsSync(jira.token_file)) {
    try {
      jira.token = fs.readFileSync(jira.token_file, 'utf8').trim();
    } catch (e) {
      log.warn(`Could not read Jira token file ${jira.token_file}: ${e.message}`);
    }
  } else if (process.env.JIRA_TOKEN) {
    jira.token = process.env.JIRA_TOKEN.trim();
  }

  const confluence = {
    url: (getString(fileConfig.confluence?.url) || process.env.CONFLUENCE_URL || 'https://wiki.wiit.one').replace(/\/+$/, ''),
    token_file: getNullableString(fileConfig.confluence?.token_file) || process.env.CONFLUENCE_TOKEN_FILE || null,
    token: null,
  };

  if (confluence.token_file && fs.existsSync(confluence.token_file)) {
    try {
      confluence.token = fs.readFileSync(confluence.token_file, 'utf8').trim();
    } catch (e) {
      log.warn(`Could not read Confluence token file ${confluence.token_file}: ${e.message}`);
    }
  } else if (process.env.CONFLUENCE_TOKEN) {
    confluence.token = process.env.CONFLUENCE_TOKEN.trim();
  }

  const teams = {
    reconnect_interval_seconds: Number(fileConfig.teams?.reconnect_interval_seconds ?? 5),
    token_refresh_interval_minutes: Number(fileConfig.teams?.token_refresh_interval_minutes ?? 60),
    registration_interval_minutes: Number(fileConfig.teams?.registration_interval_minutes ?? 15),
    max_session_minutes: Number(fileConfig.teams?.max_session_minutes ?? 60),
    history_poll_interval_seconds: Number(fileConfig.teams?.history_poll_interval_seconds ?? 120),
    credentials_file: getNullableString(fileConfig.teams?.credentials_file) || process.env.TEAMS_CREDENTIALS_FILE || null,
    troll_user: (getString(fileConfig.teams?.troll_user) || process.env.TEAMS_TROLL_USER || '').trim(),
    edit_own_url_messages: Boolean(fileConfig.teams?.edit_own_url_messages ?? false),
    // Opt-in: send GitLab/Jira/OpsGenie/Confluence updates as Adaptive Cards
    rich_messages: fileConfig.teams?.rich_messages === true,
    // The compact merge request card (two columns, short labels, one-line approval); on unless set to false.
    compact_cards: fileConfig.teams?.compact_cards !== false,
    // Dampening of connector expired/restored alerts; see src/service-alerts.mjs
    service_alerts: fileConfig.teams?.service_alerts && typeof fileConfig.teams.service_alerts === 'object'
      ? fileConfig.teams.service_alerts
      : {},
    admin_ids: Array.isArray(fileConfig.teams?.admin_ids)
      ? fileConfig.teams.admin_ids.map(String)
      : [],
  };

  const opsgenie = {
    on_call_key: getString(fileConfig.opsgenie?.on_call_key) || process.env.OPSGENIE_ON_CALL_KEY || '',
    support_key: getString(fileConfig.opsgenie?.support_key) || process.env.OPSGENIE_SUPPORT_KEY || '',
    edge_key: getString(fileConfig.opsgenie?.edge_key) || process.env.OPSGENIE_EDGE_KEY || '',
    on_call_schedule_id:
      getString(fileConfig.opsgenie?.on_call_schedule_id) ||
      process.env.OPSGENIE_ON_CALL_SCHEDULE_ID ||
      '8aa71a67-9ddd-4571-af97-06d1ddb3c7cb',
    support_schedule_id:
      getString(fileConfig.opsgenie?.support_schedule_id) ||
      process.env.OPSGENIE_SUPPORT_SCHEDULE_ID ||
      '5a044893-0255-4246-8606-8e76949a861d',
    base_url: (getString(fileConfig.opsgenie?.base_url) || process.env.OPSGENIE_BASE_URL || 'https://api.eu.opsgenie.com/v2').replace(/\/+$/, ''),
    web_base_url: (getString(fileConfig.opsgenie?.web_base_url) || process.env.OPSGENIE_WEB_BASE_URL || 'https://germanedgecloudgmbh.app.opsgenie.com').replace(/\/+$/, ''),
  };

  const homeAssistant = {
    url: (getString(fileConfig.home_assistant?.url) || process.env.HASS_URL || 'https://ha.brkn.lol').replace(/\/+$/, ''),
    token_file: getNullableString(fileConfig.home_assistant?.token_file) || process.env.HASS_TOKEN_FILE || null,
    token: null,
    hrworks_batch_size: Number(fileConfig.home_assistant?.hrworks_batch_size ?? 4),
  };

  if (homeAssistant.token_file && fs.existsSync(homeAssistant.token_file)) {
    try {
      homeAssistant.token = fs.readFileSync(homeAssistant.token_file, 'utf8').trim();
    } catch (e) {
      log.warn(`Could not read Home Assistant token file ${homeAssistant.token_file}: ${e.message}`);
    }
  } else if (process.env.HASS_TOKEN) {
    homeAssistant.token = process.env.HASS_TOKEN.trim();
  }

  let conversations = fileConfig.conversations;
  if (!conversations || !Array.isArray(conversations) || conversations.length === 0) {
    conversations = [
      {
        id: '48:notes',
        name: 'Notes (Self)',
        gitlab: true,
      },
    ];
  }

  return {
    browser_daemon: {
      ...browserDaemon,
      cluster_secret: browserDaemonSecret,
    },
    gitlab,
    jira,
    confluence,
    opsgenie,
    home_assistant: homeAssistant,
    // Only an explicitly configured Home Assistant URL is a base for the TV webhooks, never the built-in default.
    tv: normalizeTvConfig(fileConfig.tv, {
      baseUrl: getString(fileConfig.home_assistant?.url) || process.env.HASS_URL || '',
      token: getString(fileConfig.home_assistant?.url) || process.env.HASS_URL ? homeAssistant.token || '' : '',
    }),
    avatars: normalizeAvatarsConfig(fileConfig.avatars),
    teams,
    conversations,
  };
}

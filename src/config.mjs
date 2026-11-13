import fs from 'node:fs';

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
    secret_file: getNullableString(fileConfig.browser_daemon?.secret_file) || process.env.BROWSER_DAEMON_SECRET_FILE || null,
  };

  let browserDaemonSecret = null;
  if (browserDaemon.secret_file && fs.existsSync(browserDaemon.secret_file)) {
    try {
      browserDaemonSecret = fs.readFileSync(browserDaemon.secret_file, 'utf8').trim();
    } catch (e) {
      console.warn(`Could not read browser-daemon secret file ${browserDaemon.secret_file}: ${e.message}`);
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
  };

  if (webhook.secret_file && fs.existsSync(webhook.secret_file)) {
    try {
      webhook.secret = fs.readFileSync(webhook.secret_file, 'utf8').trim();
    } catch (e) {
      console.warn(`Could not read GitLab webhook secret file ${webhook.secret_file}: ${e.message}`);
    }
  } else if (process.env.TEAMS_GITLAB_WEBHOOK_SECRET) {
    webhook.secret = process.env.TEAMS_GITLAB_WEBHOOK_SECRET.trim();
  } else if (typeof rawWebhook.secret === 'string' && rawWebhook.secret) {
    webhook.secret = rawWebhook.secret.trim();
  }

  gitlab.webhook = webhook;

  if (gitlab.token_file && fs.existsSync(gitlab.token_file)) {
    try {
      gitlab.token = fs.readFileSync(gitlab.token_file, 'utf8').trim();
    } catch (e) {
      console.warn(`Could not read GitLab token file ${gitlab.token_file}: ${e.message}`);
    }
  } else if (process.env.GITLAB_TOKEN) {
    gitlab.token = process.env.GITLAB_TOKEN.trim();
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
      console.warn(`Could not read Jira token file ${jira.token_file}: ${e.message}`);
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
      console.warn(`Could not read Confluence token file ${confluence.token_file}: ${e.message}`);
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
      console.warn(`Could not read Home Assistant token file ${homeAssistant.token_file}: ${e.message}`);
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
    teams,
    conversations,
  };
}

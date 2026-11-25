import fs from 'node:fs';
import {
  extractMessageAuth,
  getMessageAuthStatus,
  getUserProfile,
  getUserDisplayName,
} from 'msteams-mcp/dist/auth/token-extractor.js';
import { refreshTokensViaHttp } from 'msteams-mcp/dist/auth/token-refresh-http.js';
import { signInViaBrowserDaemon } from 'msteams-mcp/dist/auth/token-refresh.js';
import { readSessionState, writeSessionState } from 'msteams-mcp/dist/auth/session-store.js';
import { acquireFromBrowserDaemon, trackBrowserAuth } from './browser-auth.mjs';
import { createLogger } from './logger.mjs';

export { getUserProfile, getUserDisplayName };

const log = createLogger('auth');

// Expiry (ms since epoch) of the Skype token in a session state, or null.
export function sessionTokenExpiry(state) {
  const token = state?.cookies?.find((c) => c.domain?.includes('teams.microsoft.com') && c.name === 'skypetoken_asm')?.value;
  if (typeof token !== 'string') return null;
  try {
    const exp = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'))?.exp;
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export class AuthManager {
  constructor(config) {
    this.config = config;
    this.credentialsFile = config.teams?.credentials_file || null;
    this.credentialsLoaded = false;
    this.refreshTimer = null;
    this.stopped = false;

    if (config.browser_daemon?.url) {
      process.env.TEAMS_MCP_BROWSER_DAEMON_URL = config.browser_daemon.url;
    }
    if (config.browser_daemon?.profile) {
      process.env.TEAMS_MCP_BROWSER_DAEMON_PROFILE = config.browser_daemon.profile;
    }
    if (config.browser_daemon?.node_group) {
      process.env.TEAMS_MCP_BROWSER_DAEMON_NODE_GROUP = config.browser_daemon.node_group;
    }
    if (config.browser_daemon?.secret_file) {
      process.env.BROWSER_DAEMON_SECRET_FILE = config.browser_daemon.secret_file;
    }
  }

  // Latest tokens from the session store, without triggering a refresh.
  getCachedAuth() {
    try {
      return extractMessageAuth() ?? null;
    } catch {
      return null;
    }
  }

  getStatus() {
    return getMessageAuthStatus();
  }

  getUserProfile() {
    try {
      return getUserProfile();
    } catch {
      return null;
    }
  }

  getUserDisplayName() {
    try {
      return getUserDisplayName();
    } catch {
      return null;
    }
  }

  loadCredentialsFile({ force = false } = {}) {
    if (!this.credentialsFile || !fs.existsSync(this.credentialsFile)) {
      return null;
    }
    try {
      const stat = fs.statSync(this.credentialsFile);
      if (!force && this.credentialsLoaded && this.lastLoadedCredentialsMtime && stat.mtimeMs <= this.lastLoadedCredentialsMtime) {
        log.debug(`Credentials file ${this.credentialsFile} unmodified on disk, preserving active session`);
        return null;
      }
      this.lastLoadedCredentialsMtime = stat.mtimeMs;
      const raw = fs.readFileSync(this.credentialsFile, 'utf8').trim();
      if (!raw) return null;
      const data = JSON.parse(raw);

      // If full session state (cookies and origins from msteams-mcp session-state)
      if (data.cookies && data.origins) {
        log.debug(`Loaded full session state from ${this.credentialsFile}`);
        // Ensure DISCOVER-REGION-GTM exists in localStorage so msteams-mcp calendar-api can extract region
        const origin = data.origins.find((o) => o.origin?.includes('teams.'));
        if (origin && !origin.localStorage?.some((item) => item.name?.includes('DISCOVER-REGION-GTM'))) {
          origin.localStorage = origin.localStorage || [];
          origin.localStorage.push({
            name: 'DISCOVER-REGION-GTM',
            value: JSON.stringify({
              item: {
                middleTier: 'https://teams.microsoft.com/api/mt/emea',
                chatServiceAfd: 'https://teams.microsoft.com/api/chatsvc/emea',
                chatSvcAggAfd: 'https://teams.microsoft.com/api/csa/emea',
              },
            }),
          });
        }
        // The session store is refreshed in place and survives restarts; the
        // credentials file is only a seed. Never replace a store whose tokens
        // are as new as (or newer than) the file's, or every start would throw
        // away the refreshed session and sign in again.
        const fileExpiry = sessionTokenExpiry(data);
        const storeExpiry = sessionTokenExpiry(readSessionState());
        if (storeExpiry && (!fileExpiry || storeExpiry >= fileExpiry)) {
          log(`Keeping cached Teams session (token valid until ${new Date(storeExpiry).toISOString()}); credentials file is not newer`);
          return extractMessageAuth();
        }
        writeSessionState(data);
        return extractMessageAuth(data);
      }

      // If flat credentials format
      if (data.skypeToken && data.authToken) {
        log(`Loaded token credentials from ${this.credentialsFile}`);
        return {
          skypeToken: data.skypeToken,
          authToken: data.authToken,
          userMri: data.userMri || null,
        };
      }
    } catch (err) {
      log(`Error reading credentials file ${this.credentialsFile}: ${err.message}`);
    }
    return null;
  }

  async ensureValidAuth({ forceDaemon = false } = {}) {
    if (this.stopped) throw new DOMException('Authentication stopped', 'AbortError');
    // 1. Initial seed from credentials file if session not yet loaded
    let fileAuth = null;
    if (!this.credentialsLoaded) {
      fileAuth = this.loadCredentialsFile();
      this.credentialsLoaded = true;
    }

    const status = getMessageAuthStatus();
    log.debug(`Current messaging auth status: hasToken=${status.hasToken}, minutesRemaining=${status.minutesRemaining ?? 'unknown'}`);

    if (!forceDaemon && status.hasToken && (status.minutesRemaining ?? 0) > 15) {
      const auth = extractMessageAuth();
      if (auth) return auth;
      if (fileAuth) return fileAuth;
    }

    // 2. Try HTTP refresh (uses the refresh token stored in session state)
    if (!forceDaemon) {
      log('Attempting HTTP token refresh...');
      try {
        const httpResult = await refreshTokensViaHttp();
        if (httpResult.ok) {
          const auth = extractMessageAuth();
          if (auth) {
            log('HTTP token refresh succeeded');
            return auth;
          }
        } else {
          log(`HTTP token refresh failed: ${httpResult.error?.message || 'unknown error'}`);
          // If refresh failed and we hadn't re-seeded recently, re-read credentials file once
          if (!fileAuth && this.credentialsFile) {
            log('Re-reading credentials file in case secret was updated...');
            this.loadCredentialsFile();
          }
        }
      } catch (err) {
        log(`HTTP token refresh threw: ${err.message}`);
      }
    }

    // 3. Fallback to browser-daemon only if explicitly configured
    if (this.config.browser_daemon?.url) {
      if (this.stopped) throw new DOMException('Authentication stopped', 'AbortError');
      log(`Attempting sign-in via browser-daemon profile "${this.config.browser_daemon.profile}"...`);
      try {
        const directAuth = await acquireFromBrowserDaemon(this.config.browser_daemon);
        if (directAuth) {
          log('Sign-in via direct browser-daemon succeeded');
          return directAuth;
        }
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        log(`Direct browser-daemon sign-in threw: ${err.message}`);
      }

      try {
        if (this.stopped) throw new DOMException('Authentication stopped', 'AbortError');
        const daemonResult = await trackBrowserAuth(signInViaBrowserDaemon());
        if (daemonResult.ok) {
          const auth = extractMessageAuth();
          if (auth) {
            log('Sign-in via browser-daemon succeeded');
            return auth;
          }
        } else {
          log(`Browser-daemon sign-in returned error: ${daemonResult.error?.message || 'unknown error'}`);
        }
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        log(`Browser-daemon sign-in threw: ${err.message}`);
      }
    }

    // 4. Return fileAuth if present
    if (fileAuth) {
      return fileAuth;
    }

    // 5. Final attempt from cached state
    const fallbackAuth = extractMessageAuth();
    if (fallbackAuth) {
      log.warn('Using cached session state despite warnings');
      return fallbackAuth;
    }

    throw new Error('No valid Teams session credentials found and automatic refresh failed.');
  }

  startProactiveRefresh(intervalMinutes = 5) {
    if (this.refreshTimer) clearInterval(this.refreshTimer);

    this.refreshTimer = setInterval(async () => {
      try {
        const status = getMessageAuthStatus();
        if (!status.hasToken || (status.minutesRemaining ?? 0) < 60) {
          log(`Proactive token refresh triggered (hasToken=${status.hasToken}, minutesRemaining=${status.minutesRemaining ?? 0})`);
          await this.ensureValidAuth();
        }
      } catch (err) {
        log(`Proactive token refresh failed: ${err.message}`);
      }
    }, intervalMinutes * 60 * 1000);

    if (this.refreshTimer.unref) this.refreshTimer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}

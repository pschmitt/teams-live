import fs from 'node:fs';
import path from 'node:path';

const log = (...args) => console.error(new Date().toISOString(), '[health]', ...args);

export class HealthMonitor {
  constructor({ stateDir, gitlab, jira, opsgenie, authManager, getTrouter }) {
    this.stateDir = stateDir || process.env.XDG_STATE_HOME || '/var/lib/teams-live/state';
    this.healthPath = path.join(this.stateDir, 'health.json');
    this.gitlab = gitlab;
    this.jira = jira;
    this.opsgenie = opsgenie;
    this.authManager = authManager;
    this.getTrouter = getTrouter;
    this.serviceStatus = {
      gitlab: { status: gitlab?.token ? 'ok' : 'unconfigured', error: null, last_check: null },
      jira: { status: jira?.isConfigured() ? 'ok' : 'unconfigured', error: null, last_check: null },
      opsgenie: { status: opsgenie?.isConfigured() ? 'ok' : 'unconfigured', error: null, last_check: null },
    };
    this.timer = null;
  }

  setServiceStatus(service, ok, error = null) {
    const key = String(service || '').toLowerCase();
    if (!this.serviceStatus[key]) return;
    this.serviceStatus[key] = {
      status: ok ? 'ok' : (error?.includes('401') || error?.includes('403') || error?.includes('auth') ? 'auth_expired' : 'error'),
      error: ok ? null : (error ? String(error) : null),
      last_check: new Date().toISOString(),
    };
    this.writeHealth();
  }

  getHealth() {
    const trouter = this.getTrouter?.();
    const trouterConnected = Boolean(trouter && trouter.isConnected());
    const authStatus = this.authManager ? this.authManager.getStatus() : { hasToken: false, minutesRemaining: 0 };

    let overallStatus = 'healthy';
    const errors = [];

    if (!authStatus.hasToken) {
      overallStatus = 'unhealthy';
      errors.push('Teams authentication missing or expired');
    } else if (!trouterConnected) {
      overallStatus = 'unhealthy';
      errors.push('Trouter websocket disconnected');
    }

    for (const [srv, s] of Object.entries(this.serviceStatus)) {
      if (s.status === 'auth_expired') {
        if (overallStatus === 'healthy') overallStatus = 'degraded';
        errors.push(`${srv}: authentication expired (${s.error || '401/403'})`);
      } else if (s.status === 'error') {
        if (overallStatus === 'healthy') overallStatus = 'degraded';
        errors.push(`${srv}: ${s.error}`);
      }
    }

    return {
      status: overallStatus,
      updated_at: new Date().toISOString(),
      timestamp: Date.now(),
      uptime_seconds: Math.floor(process.uptime()),
      teams: {
        connected: trouterConnected,
        trouter: trouterConnected ? 'connected' : 'disconnected',
        has_token: Boolean(authStatus.hasToken),
        minutes_remaining: authStatus.minutesRemaining ?? 0,
      },
      services: this.serviceStatus,
      errors,
    };
  }

  writeHealth() {
    try {
      if (!fs.existsSync(this.stateDir)) {
        fs.mkdirSync(this.stateDir, { recursive: true });
      }
      const data = this.getHealth();
      const tmpPath = `${this.healthPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
      fs.renameSync(tmpPath, this.healthPath);
    } catch (err) {
      log(`Failed to write health.json: ${err.message}`);
    }
  }

  start(intervalMs = 15_000) {
    this.writeHealth();
    this.timer = setInterval(() => this.writeHealth(), intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Final update on shutdown if needed
    try {
      this.writeHealth();
    } catch {}
  }
}

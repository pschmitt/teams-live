import { execFile } from 'node:child_process';

const log = (...args) => console.error(new Date().toISOString(), '[systemd]', ...args);

export class SystemdWatchdog {
  constructor() {
    this.enabled = !!process.env.NOTIFY_SOCKET;
    this.interval = null;
    this.watchdogUsec = process.env.WATCHDOG_USEC ? parseInt(process.env.WATCHDOG_USEC, 10) : 0;
  }

  notify(args) {
    if (!this.enabled) return;
    execFile('systemd-notify', args, (err) => {
      if (err) {
        log(`Failed to notify systemd: ${err.message}`);
      }
    });
  }

  ready(statusText) {
    const args = ['--ready'];
    if (statusText) args.push(`--status=${statusText}`);
    this.notify(args);
  }

  status(statusText) {
    this.notify([`--status=${statusText}`]);
  }

  watchdog(statusText) {
    const args = ['WATCHDOG=1'];
    if (statusText) args.push(`--status=${statusText}`);
    this.notify(args);
  }

  start(checkHealth, intervalMs) {
    if (!this.enabled) return;

    const interval = intervalMs || (this.watchdogUsec ? Math.floor(this.watchdogUsec / 2000) : 15_000);
    log(`Starting systemd watchdog pinger (interval: ${Math.round(interval / 1000)}s)...`);

    this.interval = setInterval(async () => {
      try {
        const result = await checkHealth();
        if (result?.ok) {
          this.watchdog(result.status);
        } else {
          const reason = result?.status || 'Unknown failure';
          log(`Watchdog check not satisfied (${reason}); skipping WATCHDOG=1 ping`);
          this.status(`Degraded: ${reason}`);
        }
      } catch (err) {
        log(`Watchdog check error: ${err.message}; skipping WATCHDOG=1 ping`);
      }
    }, interval);

    if (this.interval.unref) this.interval.unref();
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

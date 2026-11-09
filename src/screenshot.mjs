import fs from 'node:fs';

const log = (...args) => console.error(new Date().toISOString(), '[screenshot]', ...args);

export class ScreenshotClient {
  constructor(config = {}) {
    this.url = (config.url || '').replace(/\/+$/, '');
    this.profile = config.profile || 'work';
    this.clusterSecret = config.cluster_secret || null;
    this.secretFile = config.secret_file || null;
  }

  isConfigured() {
    return Boolean(this.url && this.getSecret());
  }

  getSecret() {
    if (this.clusterSecret) return this.clusterSecret;
    if (this.secretFile && fs.existsSync(this.secretFile)) {
      try {
        this.clusterSecret = fs.readFileSync(this.secretFile, 'utf8').trim();
        return this.clusterSecret;
      } catch (err) {
        console.warn(`Could not read browser-daemon secret file ${this.secretFile}: ${err.message}`);
      }
    }
    return null;
  }

  async checkConnection({ timeoutMs = 5000 } = {}) {
    if (!this.url) {
      return { ok: false, status: 'unconfigured', error: 'No browser-daemon URL configured' };
    }
    const secret = this.getSecret();
    if (!secret) {
      return { ok: false, status: 'unconfigured', error: 'No browser-daemon cluster secret' };
    }

    const endpoint = `${this.url}/api/mesh/overview`;
    try {
      const resp = await fetch(endpoint, {
        headers: {
          'X-Browser-Cluster-Secret': secret,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (resp.status === 401 || resp.status === 403) {
        return { ok: false, status: 'auth_expired', error: `browser-daemon HTTP ${resp.status}: Unauthorized` };
      }
      if (!resp.ok) {
        return { ok: false, status: 'error', error: `browser-daemon HTTP ${resp.status}` };
      }

      return { ok: true, status: 'ok', error: null };
    } catch (err) {
      return { ok: false, status: 'error', error: err.message };
    }
  }

  async capture(targetUrl, { width = 480, height = 200, quality = 55, timeoutMs = 15000 } = {}) {
    if (!this.isConfigured()) {
      return null;
    }
    const secret = this.getSecret();
    const endpoint = `${this.url}/api/run`;

    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'X-Browser-Cluster-Secret': secret,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: targetUrl,
          profile: this.profile,
          timeout_ms: timeoutMs,
          script: `async ({ page }) => {
            await page.setViewportSize({ width: ${width}, height: ${height} });
            try {
              await page.waitForLoadState('load', { timeout: 8000 });
            } catch {}
            await new Promise(r => setTimeout(r, 1200));
            const buf = await page.screenshot({ type: 'jpeg', quality: ${quality} });
            return buf.toString('base64');
          }`,
        }),
        signal: AbortSignal.timeout(timeoutMs + 5000),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        log(`browser-daemon run HTTP ${resp.status} for ${targetUrl}: ${text.slice(0, 150)}`);
        return null;
      }

      const data = await resp.json();
      if (!data.ok || !data.result) {
        log(`Run failed for ${targetUrl}: ${data.error || 'no image data'}`);
        return null;
      }

      if (typeof data.result === 'object' && data.result.b64) {
        return data.result.b64;
      }
      return data.result;
    } catch (err) {
      log(`Error capturing screenshot for ${targetUrl}: ${err.message}`);
      return null;
    }
  }
}

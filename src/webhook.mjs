import http from 'node:http';
import crypto from 'node:crypto';

const log = (...args) => console.error(new Date().toISOString(), '[webhook]', ...args);

export class GitLabWebhookServer {
  constructor({
    port = 3000,
    host = '0.0.0.0',
    path = '/webhook/gitlab',
    secret = null,
    onEvent = null,
  } = {}) {
    this.port = Number(port) || 3000;
    this.host = host || '0.0.0.0';
    this.path = path.startsWith('/') ? path : `/${path}`;
    this.secret = secret ? String(secret).trim() : null;
    this.onEvent = onEvent;
    this.server = null;
    this.listening = false;
  }

  verifyToken(reqToken) {
    if (!this.secret) return true;
    if (!reqToken) return false;
    try {
      const a = Buffer.from(this.secret);
      const b = Buffer.from(String(reqToken).trim());
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  async start() {
    if (this.server) return;

    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      srv.once('error', (err) => {
        log(`Server error: ${err.message}`);
        this.server = null;
        this.listening = false;
        reject(err);
      });

      srv.listen(this.port, this.host, () => {
        this.server = srv;
        this.listening = true;
        log(`GitLab webhook server listening on http://${this.host}:${this.port}${this.path}`);
        resolve();
      });
    });
  }

  async handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // Health check endpoint
    if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === `${this.path}/healthz`)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (url.pathname !== this.path) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const gitlabToken = req.headers['x-gitlab-token'];
    if (this.secret && !this.verifyToken(gitlabToken)) {
      log('Rejected webhook request: invalid X-Gitlab-Token');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: invalid secret token' }));
      return;
    }

    const eventType = req.headers['x-gitlab-event'] || 'Unknown Hook';

    let body = '';
    let bodySize = 0;
    const MAX_SIZE = 2 * 1024 * 1024; // 2MB limit

    req.on('data', (chunk) => {
      bodySize += chunk.length;
      if (bodySize > MAX_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));

      try {
        this.onEvent?.(eventType, payload);
      } catch (err) {
        log(`Error dispatching webhook event: ${err.message}`);
      }
    });
  }

  async stop() {
    if (!this.server) return;
    return new Promise((resolve) => {
      log('Stopping GitLab webhook server...');
      this.server.close(() => {
        this.server = null;
        this.listening = false;
        resolve();
      });
    });
  }
}

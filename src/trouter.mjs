import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const TROUTER = 'https://go.trouter.teams.microsoft.com';
const REGISTRAR = 'https://teams.microsoft.com/registrar/prod/V2/registrations';
const CLIENT_VERSION = '49/25113001312';
const TC = JSON.stringify({ cv: '2024.23.01.2', ua: 'TeamsCDL', hr: '', v: CLIENT_VERSION });
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0 Teams/24165.1410.2974.6689/49';
// Match the 1h TTL used by the Teams web client so we never outlive interactive
// browser bindings in Registrar's eviction order.
const REGISTRATION_TTL = 3600;
// Teams may drop a registration long before its TTL while the socket stays up,
// so renew well before that. A fresh session also picks up refreshed tokens.
const DEFAULT_REGISTRATION_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_SESSION_MS = 60 * 60 * 1000;
const PING_INTERVAL_MS = 30_000;
// Pings are acknowledged, so a socket without any inbound frame for this long is dead.
const DEFAULT_LIVENESS_TIMEOUT_MS = 100_000;
const MESSAGE_KINDS = new Set(['NewMessage', 'MessageUpdate']);
const isContentType = (t) => t === 'Text' || t?.startsWith('RichText');

const log = (...args) => console.error(new Date().toISOString(), '[trouter]', ...args);

function deterministicUuid(seed) {
  const bytes = Buffer.from(createHash('sha256').update(seed).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function connectQuery(info, epid) {
  const params = new URLSearchParams({ v: 'v4', ...info.connectparams, tc: TC, con_num: `${Date.now()}_1`, epid });
  if (info.ccid) params.set('ccid', info.ccid);
  params.set('auth', 'true');
  params.set('timeout', '40');
  return params.toString();
}

async function register(auth, registrationId, appId, templateKey, path) {
  if (!auth) throw new Error(`no auth for ${appId} registration`);
  const res = await fetch(REGISTRAR, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Skypetoken': auth.skypeToken,
      Authorization: `Bearer ${auth.authToken}`,
    },
    body: JSON.stringify({
      clientDescription: {
        appId,
        aesKey: '',
        languageId: 'en-US',
        platform: 'linux',
        templateKey,
        platformUIVersion: CLIENT_VERSION,
      },
      registrationId,
      nodeId: '',
      transports: { TROUTER: [{ context: '', path, ttl: REGISTRATION_TTL }] },
    }),
  });
  log(`registrar ${appId}: HTTP ${res.status}`);
  if (!res.ok) throw new Error(`registrar ${appId}: HTTP ${res.status}`);
}

function decodeBody(request) {
  let body = request.body ?? '';
  if (request.headers?.['X-Microsoft-Skype-Content-Encoding'] === 'gzip') {
    body = gunzipSync(Buffer.from(body, 'base64')).toString('utf8');
  }
  if (!body) return null;
  let obj = JSON.parse(body);
  if (obj.cp) obj = JSON.parse(gunzipSync(Buffer.from(obj.cp, 'base64')).toString('utf8'));
  else if (obj.gp) obj = JSON.parse(Buffer.from(obj.gp, 'base64').toString('utf8'));
  return obj;
}

function stripHtml(html) {
  return String(html ?? '')
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
    .replace(/<div[^>]*itemtype="http:\/\/schema\.skype\.com\/Reply"[\s\S]*?<\/div>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function extractLinks(html) {
  if (!html) return [];
  const withoutQuotes = String(html)
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
    .replace(/<div[^>]*itemtype="http:\/\/schema\.skype\.com\/Reply"[\s\S]*?<\/div>/gi, '');
  return [...withoutQuotes.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
}

function toEvent(url, body, { verbose = false, all = false } = {}) {
  const service = url.split('/').pop();
  if (service === 'messaging' && body?.type === 'EventMessage') {
    const r = body.resource ?? {};
    if (!all && !(MESSAGE_KINDS.has(body.resourceType) && isContentType(r.messagetype))) return null;

    let convId = r.conversationLink?.split('/conversations/').pop() ?? r.to;
    if (convId) {
      try {
        convId = decodeURIComponent(convId);
      } catch {}
    }

    return {
      kind: body.resourceType,
      time: r.composetime ?? r.originalarrivaltime ?? body.time,
      conversationId: convId,
      threadTopic: r.threadtopic,
      from: r.imdisplayname,
      fromMri: r.from?.split('/contacts/').pop(),
      messageType: r.messagetype,
      messageId: r.id,
      clientMessageId: r.clientmessageid,
      content: isContentType(r.messagetype) ? stripHtml(r.content) : undefined,
      rawHtml: isContentType(r.messagetype) ? r.content : undefined,
      links: isContentType(r.messagetype) ? extractLinks(r.content) : undefined,
      raw: verbose ? body : undefined,
    };
  }
  return all ? { kind: service, raw: verbose ? body : undefined } : null;
}

export class TrouterClient {
  constructor({
    onEvent,
    getAuth = null,
    verbose = false,
    all = false,
    registrationIntervalMs = DEFAULT_REGISTRATION_INTERVAL_MS,
    maxSessionMs = DEFAULT_MAX_SESSION_MS,
    livenessTimeoutMs = DEFAULT_LIVENESS_TIMEOUT_MS,
  } = {}) {
    this.onEvent = onEvent;
    this.getAuth = getAuth;
    this.verbose = verbose;
    this.all = all;
    this.registrationIntervalMs = registrationIntervalMs;
    this.maxSessionMs = maxSessionMs;
    this.livenessTimeoutMs = livenessTimeoutMs;
    this.ws = null;
    this.pingTimer = null;
    this.registrationTimer = null;
    this.livenessTimer = null;
    this.connected = false;
    this.connectedAt = null;
    this.lastFrameAt = null;
    this.lastEventAt = null;
    this.lastRegistrationAt = null;
  }

  isConnected() {
    return this.connected && this.ws !== null && this.ws.readyState === 1;
  }

  getStats() {
    const iso = (t) => (t ? new Date(t).toISOString() : null);
    return {
      connected_at: iso(this.connectedAt),
      last_frame_at: iso(this.lastFrameAt),
      last_event_at: iso(this.lastEventAt),
      last_registration_at: iso(this.lastRegistrationAt),
    };
  }

  clearTimers() {
    clearInterval(this.pingTimer);
    clearInterval(this.registrationTimer);
    clearInterval(this.livenessTimer);
    this.pingTimer = null;
    this.registrationTimer = null;
    this.livenessTimer = null;
  }

  // Drop the current session; connect() resolves and the caller reconnects.
  reconnect(reason) {
    log(`forcing reconnect: ${reason}`);
    this.connected = false;
    this.clearTimers();
    const ws = this.ws;
    if (!ws) return;
    try {
      ws.close();
    } catch {}
    // A half-dead socket may never complete the close handshake.
    setTimeout(() => {
      if (this.ws === ws) ws.dispatchEvent?.(new Event('close'));
    }, 5_000).unref?.();
  }

  endpointId(auth) {
    const seed = auth?.userMri || auth?.userEmail;
    if (seed) return deterministicUuid(`teams-live:${seed}:TeamsCDLWebWorker`);
    this.fallbackEpid ??= randomUUID();
    return this.fallbackEpid;
  }

  async connect(auth) {
    const epid = this.endpointId(auth);

    const infoRes = await fetch(`${TROUTER}/v4/a?epid=${epid}`, {
      method: 'POST',
      headers: { 'X-Skypetoken': auth.skypeToken, 'Content-Length': '0' },
    });
    if (!infoRes.ok) throw new Error(`trouter info: HTTP ${infoRes.status} ${await infoRes.text()}`);
    const info = await infoRes.json();
    const socketio = info.socketio ?? `${TROUTER}/`;
    const query = connectQuery(info, epid);

    const sidRes = await fetch(`${socketio}socket.io/1/?${query}`, { headers: { 'X-Skypetoken': auth.skypeToken } });
    if (!sidRes.ok) throw new Error(`trouter session: HTTP ${sidRes.status} ${await sidRes.text()}`);
    const sessionId = (await sidRes.text()).split(':')[0];

    const wsUrl = `${socketio.replace(/^http/, 'ws')}socket.io/1/websocket/${sessionId}?${query}`;
    const ws = new WebSocket(wsUrl, { headers: { 'X-Skypetoken': auth.skypeToken, 'User-Agent': USER_AGENT } });
    this.ws = ws;
    this.lastFrameAt = Date.now();
    const latestAuth = () => this.getAuth?.() ?? auth;

    let seq = 1;
    const send = (frame) => ws.send(frame);
    const sendCommand = (obj) => send(`5:${seq++}+::${JSON.stringify(obj)}`);
    let lastLossRegistration = 0;

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        this.connected = false;
        this.clearTimers();
        if (this.ws === ws) this.ws = null;
        if (err) reject(err);
        else resolve();
      };
      ws.addEventListener('open', () => log('websocket open'));
      ws.addEventListener('error', (e) => {
        finish(new Error(`websocket error: ${e.message ?? e.type}`));
      });
      ws.addEventListener('close', (e) => {
        log(`websocket closed (${e.code ?? 'forced'})`);
        finish();
      });

      ws.addEventListener('message', async ({ data }) => {
        const frame = String(data);
        const type = frame[0];
        this.lastFrameAt = Date.now();

        if (type === '2') {
          // socket.io heartbeat
          send('2::');
          return;
        }

        if (type === '1') {
          log('connected, authenticating');
          send(
            `5:::${JSON.stringify({
              name: 'user.authenticate',
              args: [
                {
                  headers: {
                    'X-Ms-Test-User': 'False',
                    Authorization: `Bearer ${auth.authToken}`,
                    'X-MS-Migration': 'True',
                  },
                  connectparams: info.connectparams,
                },
              ],
            })}`
          );
          const registerAll = async () => {
            const a = latestAuth();
            try {
              await register(a, epid, 'TeamsCDLWebWorker', 'TeamsCDLWebWorker_2.1', info.surl);
              this.lastRegistrationAt = Date.now();
              return true;
            } catch (err) {
              log(`registration failed: ${err.message}`);
              return false;
            }
          };

          const registered = await registerAll();
          if (ws.readyState !== 1) return;
          if (!registered) {
            this.reconnect('initial registration failed');
            return;
          }
          this.connected = true;
          this.connectedAt = Date.now();
          this.pingTimer = setInterval(() => {
            try {
              sendCommand({ name: 'ping' });
            } catch (err) {
              log(`ping failed: ${err.message}`);
            }
          }, PING_INTERVAL_MS);
          this.registrationTimer = setInterval(async () => {
            if (!(await registerAll())) this.reconnect('re-registration failed');
          }, this.registrationIntervalMs);
          this.livenessTimer = setInterval(() => {
            const now = Date.now();
            const silentMs = now - (this.lastFrameAt ?? now);
            if (silentMs > this.livenessTimeoutMs) {
              this.reconnect(`no frame from trouter for ${Math.round(silentMs / 1000)}s`);
            } else if (this.maxSessionMs > 0 && now - this.connectedAt > this.maxSessionMs) {
              this.reconnect(`session older than ${Math.round(this.maxSessionMs / 60000)}m, recycling`);
            }
          }, 15_000);
          return;
        }

        if (type === '3') {
          const payload = frame.split(':').slice(3).join(':');
          const request = JSON.parse(payload);
          if (request.status !== undefined) return;
          send(`3:::${JSON.stringify({ id: request.id, status: 200, body: '' })}`);
          try {
            const event = toEvent(request.url ?? '', decodeBody(request), {
              verbose: this.verbose,
              all: this.all,
            });
            if (event) this.lastEventAt = Date.now();
            if (event && this.onEvent) {
              this.onEvent(event);
            }
          } catch (err) {
            log(`could not decode event for ${request.url}: ${err.message}`);
          }
          return;
        }

        if (type === '5') {
          const obj = JSON.parse(frame.split(':').slice(3).join(':') || '{}');
          if (obj.name === 'trouter.message_loss') {
            const droppedIndicators = obj.args?.[0]?.droppedIndicators;
            if (Array.isArray(droppedIndicators) && droppedIndicators.length > 0) {
              try {
                sendCommand({ name: 'trouter.processed_message_loss', args: [{ droppedIndicators }] });
              } catch {}
            }
            const now = Date.now();
            if (now - (this.lastRegistrationAt ?? 0) < 30_000 || now - lastLossRegistration < 30_000) return;
            lastLossRegistration = now;
            log('server reported message loss, re-registering');
            try {
              await register(latestAuth(), epid, 'TeamsCDLWebWorker', 'TeamsCDLWebWorker_2.1', info.surl);
              this.lastRegistrationAt = Date.now();
            } catch (err) {
              log(`re-registration after message loss failed: ${err.message}`);
            }
          } else if (this.verbose) {
            log(`control: ${frame}`);
          }
        }
      });
    });
  }

  close() {
    this.connected = false;
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }
}

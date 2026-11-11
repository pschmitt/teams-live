import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { TrouterClient } from '../src/trouter.mjs';

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
});

class FakeWebSocket extends EventTarget {
  static last = null;
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    FakeWebSocket.last = this;
  }
  send(frame) {
    this.sent.push(frame);
  }
  receive(frame) {
    const ev = new Event('message');
    ev.data = frame;
    this.dispatchEvent(ev);
  }
  close() {
    this.readyState = 3;
    // A half-dead socket never answers the close handshake.
  }
}

function setup({ registrarStatus = 202 } = {}) {
  const registrations = [];
  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/v4/a')) {
      return new Response(JSON.stringify({ socketio: 'https://trouter.example/', surl: 'https://s/', connectparams: {} }));
    }
    if (u.includes('socket.io/1/?')) return new Response('sid:60:60:websocket');
    if (u.includes('registrar')) {
      const payload = JSON.parse(opts.body);
      registrations.push({
        appId: payload.clientDescription.appId,
        registrationId: payload.registrationId,
        ttl: payload.transports.TROUTER[0].ttl,
      });
      return new Response('', { status: registrarStatus });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return registrations;
}

const auth = { skypeToken: 's', authToken: 'a', userMri: '8:orgid:me' };
const tick = () => new Promise((r) => setTimeout(r, 20));

test('registers, reports connected and delivers events', async () => {
  const registrations = setup();
  const events = [];
  const client = new TrouterClient({ onEvent: (e) => events.push(e) });
  const done = client.connect(auth);
  await tick();
  FakeWebSocket.last.receive('1::');
  await tick();
  assert.equal(client.isConnected(), true);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].appId, 'TeamsCDLWebWorker');
  assert.equal(registrations[0].ttl, 3600);
  assert.ok(client.getStats().last_registration_at);

  // Immediate message_loss after connect is acknowledged without re-registering.
  FakeWebSocket.last.receive(
    `5:::${JSON.stringify({
      name: 'trouter.message_loss',
      args: [{ droppedIndicators: [{ tag: 'TeamsCDLWebWorker', etag: '1' }] }],
    })}`
  );
  await tick();
  assert.equal(registrations.length, 1);
  assert.ok(FakeWebSocket.last.sent.some((f) => f.includes('trouter.processed_message_loss')));

  const body = JSON.stringify({
    type: 'EventMessage',
    resourceType: 'NewMessage',
    resource: { messagetype: 'Text', content: '/status', id: '1', to: '48:notes' },
  });
  FakeWebSocket.last.receive(`3:::${JSON.stringify({ id: 7, url: 'https://x/messaging', body })}`);
  assert.equal(events.length, 1);
  assert.equal(events[0].content, '/status');
  assert.ok(client.getStats().last_event_at);

  client.reconnect('test');
  await done;
  assert.equal(client.isConnected(), false);

  // Reconnecting reuses the same deterministic registrationId rather than leaking a new binding.
  const done2 = client.connect(auth);
  await tick();
  FakeWebSocket.last.receive('1::');
  await tick();
  assert.equal(registrations.length, 2);
  assert.equal(registrations[1].registrationId, registrations[0].registrationId);
  client.reconnect('test');
  await done2;
});

test('reconnect() resolves connect() even when the socket never closes', async () => {
  setup();
  const client = new TrouterClient({});
  const done = client.connect(auth);
  await tick();
  FakeWebSocket.last.receive('1::');
  await tick();
  const started = Date.now();
  client.reconnect('dead socket');
  await done;
  assert.ok(Date.now() - started < 6_000);
});

test('failed initial registration drops the session', async () => {
  setup({ registrarStatus: 401 });
  const client = new TrouterClient({});
  const done = client.connect(auth);
  await tick();
  FakeWebSocket.last.receive('1::');
  await done;
  assert.equal(client.isConnected(), false);
});

test('liveness timeout forces a reconnect', async () => {
  setup();
  const client = new TrouterClient({ livenessTimeoutMs: 1 });
  const done = client.connect(auth);
  await tick();
  FakeWebSocket.last.receive('1::');
  await tick();
  assert.equal(client.isConnected(), true);
  await done; // liveness timer (15s) fires and closes the session
  assert.equal(client.isConnected(), false);
});

test('answers socket.io heartbeats', async () => {
  setup();
  const client = new TrouterClient({});
  const done = client.connect(auth);
  await tick();
  FakeWebSocket.last.receive('2::');
  assert.ok(FakeWebSocket.last.sent.includes('2::'));
  client.reconnect('test');
  await done;
});

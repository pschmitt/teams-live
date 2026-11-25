import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { encryptPayload, generateVapidKeys, parseSubscription, sendPush, validVapidKeys, vapidAuthorization } from '../src/webpush.mjs';

// Web Push without a library: the message encryption must match RFC 8291 bit for bit, the VAPID token must verify
// with the public key, and only real push services are accepted as endpoints.

test('encryption reproduces the example of RFC 8291 (Section 5, Appendix A)', () => {
  const body = encryptPayload(
    'When I grow up, I want to be a watermelon',
    { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
    { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), senderPrivateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw' },
  );
  assert.equal(
    body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  );
});

test('the VAPID token is an ES256 JWT for the push service origin, verifiable with the public key', () => {
  const keys = generateVapidKeys();
  assert.ok(validVapidKeys(keys));
  assert.ok(!validVapidKeys({ ...keys, publicKey: generateVapidKeys().publicKey }), 'a public key of another pair is refused');
  const now = Date.parse('2026-01-05T09:00:00Z');
  const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'https://dash.example.com', now);
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.equal(k, keys.publicKey);
  const [h, c, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url')), { aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'https://dash.example.com' });
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

test('only push services of the common browsers are accepted as endpoints, with well-formed keys', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/abc', 'https://wns2-par02p.notify.windows.com/w/?token=abc']) {
    assert.equal(parseSubscription(JSON.stringify({ endpoint, keys }))?.endpoint, endpoint);
  }
  for (const endpoint of ['http://fcm.googleapis.com/fcm/send/abc', 'https://127.0.0.1/x', 'https://localhost/x', 'https://evil.example.com/x', 'https://fcm.googleapis.com.evil.example.com/x', 'https://fcm.googleapis.com:8443/x', 'https://user@fcm.googleapis.com/x']) {
    assert.equal(parseSubscription({ endpoint, keys }), null, endpoint);
  }
  assert.equal(parseSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { ...keys, auth: 'AAAA' } }), null);
  assert.equal(parseSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { ...keys, p256dh: 'AAAA' } }), null);
  assert.equal(parseSubscription('not json'), null);
});

test('a push is one POST with the encrypted body; 404/410 mark the subscription as gone', async () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
  const original = globalThis.fetch;
  const seen = [];
  let status = 201;
  globalThis.fetch = async (url, options) => {
    seen.push({ url, options });
    return new Response('', { status });
  };
  try {
    const r = await sendPush(sub, { t: 'Hello' }, { keys: generateVapidKeys(), subject: 'https://dash.example.com', ttl: 60, urgency: 'high', topic: 'abc' });
    assert.deepEqual(r, { ok: true, gone: false, status: 201 });
    assert.equal(seen[0].url, sub.endpoint);
    assert.equal(seen[0].options.headers['Content-Encoding'], 'aes128gcm');
    assert.equal(seen[0].options.headers.TTL, '60');
    assert.equal(seen[0].options.headers.Urgency, 'high');
    assert.equal(seen[0].options.headers.Topic, 'abc');
    assert.match(seen[0].options.headers.Authorization, /^vapid t=/);
    status = 410;
    assert.equal((await sendPush(sub, 'x', { keys: generateVapidKeys(), subject: 'mailto:a@example.com' })).gone, true);
  } finally {
    globalThis.fetch = original;
  }
});

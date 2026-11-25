// Web Push (RFC 8030) with message encryption (RFC 8291, aes128gcm) and VAPID (RFC 8292), on node:crypto only.
//
// The dashboard keeps one VAPID key pair; a browser subscribes with its public key and hands over an endpoint at
// its push service plus its own keys (p256dh, auth). A message is encrypted for that browser alone and POSTed to
// the endpoint, signed with a short-lived ES256 token so the push service knows which server sends it.

import crypto from 'node:crypto';

const RECORD_SIZE = 4096;
const VAPID_TTL_S = 12 * 60 * 60;
const PUSH_TIMEOUT_MS = 10_000;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** A new VAPID key pair: the public key as the uncompressed point (65 bytes), the private scalar (32 bytes), base64url. */
export function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

/** A well-formed key pair (as stored), or false. */
export function validVapidKeys(keys) {
  try {
    const pub = unb64u(keys?.publicKey);
    const priv = unb64u(keys?.privateKey);
    if (pub.length !== 65 || pub[0] !== 4 || priv.length !== 32) return false;
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(priv);
    return ecdh.getPublicKey().equals(pub);
  } catch {
    return false;
  }
}

function privateKeyObject({ publicKey, privateKey }) {
  const pub = unb64u(publicKey);
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: privateKey }, format: 'jwk' });
}

/** The Authorization header for one push service (RFC 8292): `vapid t=<ES256 JWT>, k=<public key>`. */
export function vapidAuthorization(endpoint, keys, subject, now = Date.now()) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + VAPID_TTL_S, sub: subject }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

/**
 * The body of one push message (RFC 8291 with the aes128gcm content coding of RFC 8188): one record, no padding.
 * `salt` and `senderPrivateKey` are for the RFC's test vector only; normally both are fresh for every message.
 */
export function encryptPayload(plaintext, { p256dh, auth }, { salt = crypto.randomBytes(16), senderPrivateKey = null } = {}) {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const sender = crypto.createECDH('prime256v1');
  if (senderPrivateKey) sender.setPrivateKey(unb64u(senderPrivateKey));
  else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const ecdhSecret = sender.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // The last (and only) record ends with the delimiter 0x02.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

// The push services of the browsers people use. The server POSTs to the endpoint a browser hands over, so only
// these hosts are accepted: the endpoint must not make the server call anything else.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /^[a-z0-9-]+(\.[a-z0-9-]+)*\.notify\.windows\.com$/];

/** A browser's subscription (`PushSubscription.toJSON()`) as `{endpoint, keys: {p256dh, auth}}`, or null when unusable. */
export function parseSubscription(value, { extraHosts = [] } = {}) {
  try {
    const sub = typeof value === 'string' ? JSON.parse(value) : value;
    const url = new URL(sub?.endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (sub.endpoint.length > 1024) return null;
    if (!PUSH_HOSTS.some((re) => re.test(url.hostname)) && !extraHosts.includes(url.hostname)) return null;
    const p256dh = unb64u(sub.keys?.p256dh);
    const auth = unb64u(sub.keys?.auth);
    if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) return null;
    return { endpoint: url.href, keys: { p256dh: b64u(p256dh), auth: b64u(auth) } };
  } catch {
    return null;
  }
}

/**
 * Sends one message. Answers `{ok, gone, status}`: `gone` when the push service says the subscription no longer
 * exists (404, 410) or does not belong to this key (403), so it should be forgotten.
 */
export async function sendPush(sub, payload, { keys, subject, ttl = 3600, urgency = 'normal', topic = '', now = Date.now() } = {}) {
  const body = encryptPayload(typeof payload === 'string' ? payload : JSON.stringify(payload), sub.keys);
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: vapidAuthorization(sub.endpoint, keys, subject, now),
  };
  // A topic replaces a message of the same topic still waiting at the push service (max 32 base64url characters).
  if (topic) headers.Topic = topic;
  const res = await fetch(sub.endpoint, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
  return { ok: res.ok, gone: res.status === 404 || res.status === 410 || res.status === 403, status: res.status };
}

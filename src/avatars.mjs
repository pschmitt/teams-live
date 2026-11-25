/**
 * Teams profile pictures for cards.
 *
 * The photo comes from the same first-party Teams API the rest of the bot
 * uses (`profilepicturev2`), with the bot's own runtime credentials. Nothing is
 * sent to a third party, and no URL, token or photo is ever logged.
 *
 * Identity matching is strict. A person only gets a picture when they map to
 * exactly one known Azure AD identity (`8:orgid:<uuid>`): by that MRI, by an
 * exact e-mail address, or by a unique exact full display name in the user
 * directory. Fuzzy and partial matches, guessed usernames and several people
 * with the same name all end in "no picture" (name only), never in somebody
 * else's face.
 *
 * Cards carry the picture as a small `data:` URI. The server resizes (the
 * `size` parameter), the result is validated (magic bytes, pixel size, byte
 * cap) and rejected rather than embedded when it does not fit. Results are
 * cached (positive and negative, bounded, with a TTL), concurrent lookups of
 * one identity share a request, the number of parallel requests is capped and
 * a failing endpoint trips a circuit breaker. Rendering a card never waits
 * longer than `deadlineMs` for a picture.
 *
 * Where Teams has no picture, the same strict identity rules apply to ordered
 * fallback sources (`fallbacks`: Jira, Confluence; see avatar-sources.mjs) and
 * finally to configured per-name `overrides` (for accounts that exist in no
 * directory, such as a bot). The order is Teams, the sources in order, the
 * override, the placeholder.
 */

import fs from 'node:fs';
import { requireSkypeSpacesAuthWithConfig } from 'msteams-mcp/dist/utils/auth-guards.js';
import { getSkypeAuthHeaders } from 'msteams-mcp/dist/utils/api-config.js';
import { refuseLiveReadInTests } from './test-guard.mjs';
import { PLACEHOLDER_AVATAR } from './placeholder-avatar.mjs';
import { createLogger } from './logger.mjs';

const log = createLogger('avatars');

const ORGID_MRI = /^8:orgid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIZE_PARAM = /^HR(24|32|48|64|96)x\1$/;

const DEFAULTS = {
  ttlMs: 6 * 60 * 60 * 1000, // a found picture
  negativeTtlMs: 60 * 60 * 1000, // known to have no picture
  errorTtlMs: 2 * 60 * 1000, // transient failure or denied: retry soon, not per render
  maxEntries: 256,
  concurrency: 3,
  deadlineMs: 1500, // never hold a card back longer than this
  requestTimeoutMs: 5000,
  maxBytes: 12 * 1024, // per image
  // Fallback and configured pictures are held to a stricter cap. A card shares one picture budget
  // (card-user-row.mjs), so these must stay small enough to sit beside other photos.
  fallbackMaxBytes: 2400,
  maxDimension: 128, // px, either side
  breakerThreshold: 5, // consecutive failures
  breakerMs: 5 * 60 * 1000,
  size: 'HR32x32', // server-side resize, an 18px badge stays sharp
  searchLimit: 10, // directory hits asked for; a full page cannot prove a name is unique
};

export const FALLBACK_MAX_BYTES = DEFAULTS.fallbackMaxBytes;

const norm = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** True for a real Azure AD MRI. Synthetic `user:<name>` MRIs never qualify. */
export function isOrgIdMri(mri) {
  return typeof mri === 'string' && ORGID_MRI.test(mri);
}

function u16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

/**
 * Validates a downloaded picture. Returns `{ mime, width, height }` for a JPEG
 * or PNG within the limits, otherwise null. Only the headers are parsed.
 */
export function inspectImage(bytes, { maxBytes = DEFAULTS.maxBytes, maxDimension = DEFAULTS.maxDimension } = {}) {
  if (!bytes || bytes.length < 24 || bytes.length > maxBytes) return null;
  let image = null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const isPng = [0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[4 + i] === b);
    if (isPng && String.fromCharCode(...bytes.subarray(12, 16)) === 'IHDR') {
      image = {
        mime: 'image/png',
        width: (u16(bytes, 16) << 16) | u16(bytes, 18),
        height: (u16(bytes, 20) << 16) | u16(bytes, 22),
      };
    }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let i = 2;
    while (i + 4 < bytes.length) {
      if (bytes[i] !== 0xff) break;
      const marker = bytes[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof) {
        image = { mime: 'image/jpeg', height: u16(bytes, i + 5), width: u16(bytes, i + 7) };
        break;
      }
      if (marker === 0xda) break; // start of scan before any frame header
      i += 2 + u16(bytes, i + 2);
    }
  }
  if (!image) return null;
  const { width, height } = image;
  if (!(width > 0 && height > 0 && width <= maxDimension && height <= maxDimension)) return null;
  return image;
}

function toDataUri(bytes, mime) {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

/**
 * Default photo fetcher using the bot's Teams credentials. Resolves to
 * `{ kind: 'photo', bytes }`, `{ kind: 'none' }` (no picture set, or unknown
 * user) or throws an Error whose message carries no URL and no token
 * (`status 401`, `status 503`, `network`).
 *
 * A user without a picture gets a generic placeholder with a 200. Real photos
 * carry `etag` and `x-profile-picture-user-hashed-id`, placeholders do not;
 * a response without them is "no picture".
 */
export function createTeamsPhotoFetcher({
  size = DEFAULTS.size,
  timeoutMs = DEFAULTS.requestTimeoutMs,
  maxBytes = DEFAULTS.maxBytes,
  fetchFn = (...args) => globalThis.fetch(...args),
  // Never loads a real session in a test run (a test that exercises the fetcher passes its own).
  loadAuth = () => refuseLiveReadInTests('profile picture') || requireSkypeSpacesAuthWithConfig(),
} = {}) {
  if (!SIZE_PARAM.test(size)) throw new Error(`Unsupported avatar size: ${size}`);
  return async function fetchPhoto(mri, sizeOverride = size) {
    if (!SIZE_PARAM.test(sizeOverride)) throw new Error(`Unsupported avatar size: ${sizeOverride}`);
    if (!isOrgIdMri(mri)) return { kind: 'none' };
    const auth = loadAuth();
    if (!auth?.ok) throw new Error('status 401');
    const { skypeToken, spacesToken, regionConfig } = auth.value;
    const base = regionConfig.teamsBaseUrl;
    const mt = regionConfig.hasPartition
      ? `${base}/api/mt/part/${regionConfig.regionPartition}`
      : `${base}/api/mt/${regionConfig.regionPartition}`;
    const url = `${mt}/beta/users/${encodeURIComponent(mri)}/profilepicturev2?size=${sizeOverride}`;
    let res;
    try {
      res = await fetchFn(url, {
        headers: { ...getSkypeAuthHeaders(skypeToken, spacesToken, base), Accept: 'image/*' },
        // The Authentication header must not follow a redirect to another host.
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error('network');
    }
    if (res.status === 404) return { kind: 'none' };
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return { kind: 'none' };
    if (!res.headers.get('etag') || !res.headers.get('x-profile-picture-user-hashed-id')) {
      return { kind: 'none' };
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return { kind: 'none' };
    let bytes;
    try {
      bytes = await readCapped(res, maxBytes);
    } catch {
      throw new Error('network');
    }
    // More than the cap (no usable Content-Length): not a profile picture we embed.
    return bytes ? { kind: 'photo', bytes } : { kind: 'none' };
  };
}

/** Reads the body but never more than `maxBytes`; null when it is larger. */
export async function readCapped(res, maxBytes) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const all = new Uint8Array(await res.arrayBuffer());
    return all.length > maxBytes ? null : all;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export class AvatarService {
  /**
   * @param {object} opts
   * @param {object} opts.directory  UserDirectory (only `users` is read)
   * @param {Function} [opts.fetchPhoto]  async (mri) => {kind:'photo',bytes}|{kind:'none'}; throws on failure
   * @param {Function} [opts.searchFn]  optional async (name, limit) => people[]; used only when the
   *   directory has no match, and only an exact single hit with an orgid MRI counts
   * @param {Function} [opts.getSelfProfile]  authenticated Teams profile, which directory search may omit
   * @param {Function} [opts.now]
   */
  constructor({ directory, fetchPhoto, searchFn = null, getSelfProfile = null, fallbacks = [], overrides = [], now = Date.now, ...options } = {}) {
    this.directory = directory;
    // async (person, size) => {kind:'photo',bytes}|{kind:'none'}; throws on failure. Tried in order.
    this.fallbacks = (fallbacks || []).filter((f) => typeof f === 'function');
    // normalized full name -> data URI of a configured picture (already validated)
    this.overrides = new Map(
      (overrides || [])
        .filter((o) => o && norm(o.name) && typeof o.dataUri === 'string' && o.dataUri.startsWith('data:image/'))
        .map((o) => [norm(o.name), o.dataUri])
    );
    this.fetchPhoto = fetchPhoto || createTeamsPhotoFetcher({ size: options.size, maxBytes: options.maxBytes });
    this.searchFn = searchFn;
    this.getSelfProfile = getSelfProfile;
    this.now = now;
    this.opts = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) };
    this.cache = new Map(); // `${mri}|${size}` -> { value: dataUri|null, expires }
    this.identities = new Map(); // normalized name -> { mri|null, expires } (search-resolved only)
    this.inflight = new Map(); // `${mri}|${size}` -> Promise<dataUri|null>
    this.searches = new Map(); // name -> Promise<results>
    this.queue = [];
    this.active = 0;
    this.failures = 0;
    this.breakerUntil = 0;
    this.stats = { fetches: 0, hits: 0, misses: 0, errors: 0 };
  }

  /** Strictly resolves a person to one orgid MRI from known data, or null. Synchronous. */
  resolveKnown(person) {
    const p = typeof person === 'string' ? (person.includes('@') ? { email: person } : { name: person }) : person || {};
    if (isOrgIdMri(p.mri)) return p.mri;
    const users = [...(this.directory?.users?.values?.() ?? [])].filter((u) => isOrgIdMri(u.mri));
    const email = norm(p.email);
    if (email.includes('@')) {
      const hits = new Set(users.filter((u) => norm(u.email) === email).map((u) => u.mri));
      return hits.size === 1 ? [...hits][0] : null;
    }
    const name = norm(p.name);
    // A single word can be a first name or a username: never enough to pick a face.
    if (name.split(' ').length < 2) return null;
    const hits = new Set(users.filter((u) => norm(u.displayName) === name).map((u) => u.mri));
    return hits.size === 1 ? [...hits][0] : null;
  }

  async #resolve(person) {
    const known = this.resolveKnown(person);
    if (known || !this.searchFn) return known;
    const name = norm(typeof person === 'string' ? person : person?.name);
    if (name.split(' ').length < 2) return null;
    const cached = this.identities.get(name);
    if (cached && cached.expires > this.now()) return cached.mri;
    // Searches share the request budget and the circuit breaker with the photo requests.
    if (this.breakerOpen) return null;
    let mri = null;
    let ttl = this.opts.negativeTtlMs;
    try {
      const results = (await this.#search(name)) || [];
      // A full page of hits may hide more people with this name.
      if (results.length < this.opts.searchLimit) {
        const exact = new Set(results.filter((r) => norm(r.displayName ?? r.name) === name).map((r) => r.mri));
        const self = this.getSelfProfile?.();
        if (norm(self?.displayName) === name && isOrgIdMri(self.mri)) exact.add(self.mri);
        const [match] = exact;
        if (exact.size === 1 && isOrgIdMri(match)) mri = match;
      }
    } catch (err) {
      ttl = this.opts.errorTtlMs;
      this.#recordFailure(err);
    }
    this.#remember(this.identities, name, { mri, expires: this.now() + ttl });
    return mri;
  }

  #search(name) {
    const existing = this.searches.get(name);
    if (existing) return existing;
    const promise = this.#schedule(async () => this.searchFn(name, this.opts.searchLimit)).finally(() =>
      this.searches.delete(name)
    );
    this.searches.set(name, promise);
    return promise;
  }

  #recordFailure(err) {
    this.failures += 1;
    if (this.failures >= this.opts.breakerThreshold) {
      this.breakerUntil = this.now() + this.opts.breakerMs;
      this.failures = 0;
      log(`Photo lookups paused for ${Math.round(this.opts.breakerMs / 1000)}s after repeated failures (${err.message})`);
    }
  }

  #remember(map, key, entry) {
    map.delete(key);
    map.set(key, entry);
    while (map.size > this.opts.maxEntries) map.delete(map.keys().next().value);
  }

  // Pictures are cached per requested size: a smaller list variant must never
  // be served for (or poison) the card variant, and the other way round.
  #key(mri, size) {
    return `${mri}|${size}`;
  }

  #cached(mri, size) {
    const key = this.#key(mri, size);
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** The normalized name a fallback source or an override is looked up by ('' when there is none). */
  #fallbackName(person) {
    if (typeof person === 'string') return person.includes('@') ? '' : norm(person);
    return norm(person?.name);
  }

  #fallbackKey(name, size) {
    return this.#key(`fallback:${name}`, size);
  }

  /** Cached picture (data URI) of the given size or null; never starts a request. */
  peek(person, { size = this.opts.size } = {}) {
    let mri = this.resolveKnown(person);
    if (!mri) {
      // A name an earlier lookup resolved through the directory search.
      const name = norm(typeof person === 'string' ? person : person?.name);
      const found = this.identities.get(name);
      if (found && found.expires > this.now()) mri = found.mri;
    }
    const teams = mri ? this.#cached(mri, size) : null;
    if (teams) return teams;
    const name = this.#fallbackName(person);
    if (!name) return null;
    const entry = this.cache.get(this.#fallbackKey(name, size));
    if (entry && entry.expires > this.now() && entry.value) return entry.value;
    return this.overrides.get(name) || null;
  }

  /**
   * The cached picture of a person, or the neutral placeholder silhouette when
   * there is none (no match, ambiguous, no photo, denied, slow, failing): a
   * person the card shows always gets an image, and nobody is ever shown with
   * somebody else's. Never starts a request.
   */
  peekOrPlaceholder(person, opts) {
    return this.peek(person, opts) || PLACEHOLDER_AVATAR;
  }

  get breakerOpen() {
    return this.now() < this.breakerUntil;
  }

  #schedule(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.#pump();
    });
  }

  #pump() {
    while (this.active < this.opts.concurrency && this.queue.length > 0) {
      const { task, resolve, reject } = this.queue.shift();
      this.active += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          this.active -= 1;
          this.#pump();
        });
    }
  }

  async #load(mri, size) {
    const cached = this.#cached(mri, size);
    if (cached !== undefined) return cached;
    if (this.breakerOpen) return null;
    const key = this.#key(mri, size);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = this.#schedule(async () => {
      this.stats.fetches += 1;
      let value = null;
      let ttl = this.opts.negativeTtlMs;
      try {
        const result = await this.fetchPhoto(mri, size);
        const image = result?.kind === 'photo' ? inspectImage(result.bytes, this.opts) : null;
        if (image) {
          value = toDataUri(result.bytes, image.mime);
          ttl = this.opts.ttlMs;
          this.stats.hits += 1;
        } else {
          this.stats.misses += 1;
        }
        this.failures = 0;
      } catch (err) {
        ttl = this.opts.errorTtlMs;
        this.stats.errors += 1;
        this.#recordFailure(err);
      }
      this.#remember(this.cache, key, { value, expires: this.now() + ttl });
      return value;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  /**
   * The picture from the first fallback source that has one for this person,
   * as a data URI, or null. Positive and negative results are cached like
   * Teams photos; a source that fails is skipped and the failure is cached only
   * briefly. Only the sources run here: configured overrides are read by `peek`.
   */
  async #loadFallback(person, size) {
    const name = this.#fallbackName(person);
    if (!name || this.fallbacks.length === 0) return null;
    const key = this.#fallbackKey(name, size);
    const entry = this.cache.get(key);
    if (entry && entry.expires > this.now()) return entry.value;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = this.#schedule(async () => {
      let value = null;
      let failed = false;
      for (const source of this.fallbacks) {
        try {
          const result = await source(typeof person === 'string' ? { name: person } : person, size);
          const image =
            result?.kind === 'photo'
              ? inspectImage(result.bytes, { ...this.opts, maxBytes: this.opts.fallbackMaxBytes })
              : null;
          if (image) {
            value = toDataUri(result.bytes, image.mime);
            break;
          }
        } catch {
          failed = true;
        }
      }
      const ttl = value ? this.opts.ttlMs : failed ? this.opts.errorTtlMs : this.opts.negativeTtlMs;
      this.#remember(this.cache, key, { value, expires: this.now() + ttl });
      return value;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  /**
   * Returns `{ [name]: dataUri }` for the people that have a usable picture.
   * People without one (no match, ambiguous, no photo, denied, slow, failing)
   * are simply absent. Slow requests keep running and fill the cache for the
   * next card. Never throws.
   *
   * `size` is the server-side resize (e.g. `HR24x24` for dense lists); it is
   * part of the cache key and the default is the service's own size.
   */
  async avatarsFor(people, { deadlineMs = this.opts.deadlineMs, size = this.opts.size } = {}) {
    const result = {};
    const seen = new Set();
    const jobs = [];
    for (const person of people || []) {
      const name = typeof person === 'string' ? person : person?.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      // Directory search often omits the signed-in user. Start their photo request
      // alongside the search, but do not use it until the search confirms that
      // the full name is unambiguous.
      const self = this.getSelfProfile?.();
      if (norm(name).split(' ').length >= 2 && norm(self?.displayName) === norm(name) && isOrgIdMri(self?.mri)) {
        this.#load(self.mri, size).catch(() => {});
      }
      jobs.push(
        this.#resolve(person)
          .then((mri) => (mri ? this.#load(mri, size) : null))
          // No Teams picture (no identity, no photo, failing): the fallback sources.
          .then((uri) => uri || this.#loadFallback(person, size))
          .then((uri) => {
            if (uri) result[name] = uri;
          })
          .catch(() => {})
      );
    }
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(resolve, deadlineMs);
      timer.unref?.();
    });
    await Promise.race([Promise.all(jobs), deadline]);
    clearTimeout(timer);
    // Copy: lookups that missed the deadline must not change what the caller holds.
    return { ...result };
  }
}

/**
 * Reads the configured per-name pictures: `[{ name, file }]` to
 * `[{ name, dataUri }]`. A file that is missing, over the fallback byte cap
 * (2400) or not a PNG or JPEG within the pixel limit is skipped with a warning (no path, no name logged),
 * so one bad entry never keeps the daemon from starting.
 */
export function loadAvatarOverrides(entries, { readFile = fs.readFileSync, ...limits } = {}) {
  const maxBytes = limits.maxBytes ?? DEFAULTS.fallbackMaxBytes;
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = String(entry?.name ?? '').trim();
    const file = String(entry?.file ?? '').trim();
    if (!name || !file) continue;
    try {
      const bytes = new Uint8Array(readFile(file));
      const image = inspectImage(bytes, { ...limits, maxBytes });
      if (!image) throw new Error(`not a PNG or JPEG of at most ${maxBytes} bytes and ${DEFAULTS.maxDimension} px`);
      out.push({ name, dataUri: toDataUri(bytes, image.mime) });
    } catch (err) {
      log.warn(`Ignoring a configured profile picture: ${err.message}`);
    }
  }
  return out;
}

// Capability-link web confirmation flow for approving a GitLab merge request
// from a rich card.
//
// The card carries an "👍 Approve" button (Action.OpenUrl) whose URL holds a
// random 256-bit capability token in the FRAGMENT (`https://host/approve/#<token>`).
// The visitor signs in to GitLab and approves as their own account.
//
// - Fragments are never sent to a server, so the token is not in the request
//   URL, the proxy access log or a Referer. A static page (no token needed to
//   render it) reads it with a small script, clears it from the address bar
//   and exchanges it with a same-origin POST for a short-lived HttpOnly,
//   SameSite=Strict session cookie. That bootstrap changes nothing in GitLab
//   and consumes nothing, so a link scanner that only fetches or even runs the
//   page cannot burn the link.
// - Approving needs an explicit confirmation POST from the page served to that
//   session: session cookie, CSRF token bound to the session and the link,
//   and an Origin that matches the configured base_url. The GitLab account and
//   credential the page showed are carried in the form and bound into the CSRF
//   token; the POST re-reads them and sends nothing when they differ, or when
//   the account cannot be told.
// - The server stores only the SHA-256 of the token with the project, merge
//   request, exact head commit, expiry (24 h by default, hard bounded) and
//   status. Approval links remain usable by other users until the head changes,
//   the merge request closes, or the link expires.
// - The listener binds to loopback only and sits behind the reverse proxy.
//
// A fourth action, "Rebase", is offered on OPEN merge requests that are behind their target branch (and have no
// conflicts). It asks GitLab to rebase the source branch (one PUT, never repeated) and reads the result back.
// Like Reopen it is not pinned to a head commit (a rebase changes it) and has its own records.
//
// Approval requires GitLab OAuth (authorization code, PKCE, api scope). The
// access token stays in the short-lived server-side session; the identity is
// bound into the CSRF token. Other actions still use the configured account.
//
// The same flow serves a second action, "Reopen", for CLOSED (never merged)
// merge requests: a "🔄 Reopen" button on the closed card opens a link of the
// kind `reopen`. It is separate from the approval links (its own records, never
// staled by approvals and vice versa), has no head commit to pin, and is used up
// by a confirmed reopen. Everything above (capability token, session, CSRF,
// Origin, lock) applies unchanged.
//
// A third action, "Merge", is offered on OPEN, non-draft merge requests: a
// "🔀 Merge" button opens a link of the kind `merge`. Like an approval it is
// pinned to the head commit it was minted for, and it has its own records (never
// staled by approvals or reopens and vice versa). The page re-reads the merge
// request and offers the button only while GitLab reports it mergeable at that
// head; the confirmed POST sends ONE merge request guarded by that head (`sha`)
// and nothing else: GitLab's own rules (approvals, pipeline, protected branch,
// conflicts, discussions) decide, they cannot be overridden from here, and
// auto-merge when the pipeline succeeds is never requested. The merge PUT is
// never resent. An answer that is not a plain "merged at the expected head" is
// read back, and the link is used up only when that read confirms it.

import { buildApprovalNote } from './approval-note.mjs';
import { userApprovalPreflight, userApprovalWrite } from './user-approval.mjs';
import { BATCH_APPROVAL_SCRIPT } from './batch-approval-page.mjs';
import { teamsMessageLink } from './message-links.mjs';
import { formatPlace } from './geoip.mjs';
import { GITHUB_MARK, MENU_ICONS, PAGE_CSS, TANUKI, escapeHtml, headerAccount, heroIcon, liveScript, liveSlots, liveState, renderSummary, safeLink } from './approve-page.mjs';
import http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isIP } from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.mjs';
import { FAVICON } from './favicon.mjs';

/** The page footer: just the project on GitHub. */
const FOOTER = `<footer class="foot"><a href="https://github.com/pschmitt/teams-live" target="_blank" rel="noopener noreferrer">${GITHUB_MARK}teams-live on GitHub</a></footer>`;
import { ICON_192, ICON_512 } from './pwa-icons.mjs';
import { CUSTOMIZE_BUTTON, DASHBOARD_CSS, alertDetail, serviceWorkerScript, webManifest, approveButton, fetchMrDetail, mrDetail, dashboardBody, issueDetail, dashboardScript, defaultFilter, fetchGroupMrs, isGroupMember, navCounts, normalizeNotifySettings, notifyEvents, renderSections, wantsEvent } from './dashboard.mjs';
import { generateVapidKeys, parseSubscription, sendPush, validVapidKeys } from './webpush.mjs';

const FULL_WARN_INTERVAL_MS = 10 * 60 * 1000;
const log = createLogger('approve');

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ID_PATTERN = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 4096;
const DEFAULT_LINK_TTL_S = 24 * 60 * 60;
const MIN_LINK_TTL_S = 60;
const MAX_LINK_TTL_S = 7 * 24 * 60 * 60;
const SESSION_TTL_MS = 15 * 60 * 1000;
const CSRF_TTL_MS = 10 * 60 * 1000;
const MAX_RECORDS = 500;
const MAX_SESSIONS = 2000;
const MAX_BOOTSTRAP_FAILURES_PER_MINUTE = 60;
const MAX_SESSIONS_PER_LINK = 3;
const MAX_BOOTSTRAPS_PER_LINK_PER_MINUTE = 10;
const READ_CACHE_MS = 5000;
const REVALIDATE_MS = 30_000;
const APPROVED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 15_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const COOKIE_NAME = 'tl_approve';
const WHO_COOKIE = 'tl_who';
const WHO_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ACTIONS = ['approve', 'reopen', 'merge', 'rebase'];
const REBASE_POLL_MS = 2000;
const REBASE_POLL_ATTEMPTS = 10;
// Links without a head commit to pin.
const UNPINNED = new Set(['reopen', 'rebase']);
const LIVE_CACHE_MS = 3000;
const MERGE_POLL_MS = 2000;
const MERGE_POLL_ATTEMPTS = 8;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_OAUTH_STATES = 500;
const OAUTH_TIMEOUT_MS = 10_000;
const DASH_COOKIE = 'tl_dash';
// A dashboard session outlives the GitLab access token (about two hours): the token is renewed with GitLab's
// refresh token, and the group membership is checked again each time.
const DASH_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DASH_TOKEN_MARGIN_MS = 2 * 60 * 1000;
const MAX_DASH_SESSIONS = 200;
const DASH_DATA_CACHE_MS = 20_000;
const DASH_SOURCE_CACHE_MS = 60_000;
const DASH_SOURCES = { sprint: 'Jira', alerts: 'OpsGenie', meetings: 'the calendar' };
// Push notifications: how often the server looks for new events of the subscribed browsers, how many browsers
// one person and everyone together may subscribe, how long a seen event is remembered after it disappeared.
const PUSH_POLL_MS = 60_000;
const MAX_PUSH_SUBS_PER_USER = 10;
const MAX_PUSH_SUBS = 500;
const PUSH_SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PUSH_BURST = 4;

// Page copy per kind of link. `generic` is the entry page, which does not know
// the action yet (the token that says so is still in the fragment).
const COPY = {
  approve: {
    title: 'Approve merge request',
    blocked: 'Cannot approve',
    kicker: 'GitLab approval',
    question: 'Approve this merge request with your GitLab account?',
    button: 'Approve merge request',
    busy: 'Approving…',
  },
  reopen: {
    title: 'Reopen merge request',
    blocked: 'Cannot reopen',
    kicker: 'GitLab merge request',
    question: 'Reopen this merge request?',
    button: 'Reopen merge request',
    busy: 'Reopening…',
  },
  merge: {
    title: 'Merge merge request',
    blocked: 'Cannot merge',
    kicker: 'GitLab merge',
    question: 'Merge this merge request?',
    button: 'Merge merge request',
    busy: 'Merging…',
  },
  rebase: {
    title: 'Rebase merge request',
    blocked: 'Cannot rebase',
    kicker: 'GitLab rebase',
    question: 'Rebase this merge request onto its target branch?',
    button: 'Rebase merge request',
    busy: 'Rebasing…',
  },
  generic: { kicker: 'GitLab' },
  dashboard: { kicker: 'Dashboard' },
};

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest();
const sha256Hex = (value) => sha256(value).toString('hex');

/** Constant-time string comparison (digests, so the length does not leak). */
function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

const toneForCode = (code) => (code >= 500 ? 'error' : code >= 400 ? 'warn' : 'ok');

const keyOf = (project, iid) => `${String(project).toLowerCase()}!${iid}`;

/**
 * Server-side link records, kept in a small bounded state file. A record binds
 * the SHA-256 of a capability token to one project, merge request and head
 * commit. The token itself is never stored.
 */
export class ApprovalStore {
  constructor({ file = null, ttlMs = DEFAULT_LINK_TTL_S * 1000, max = MAX_RECORDS, now = Date.now, logger = log } = {}) {
    this.file = file;
    this.logger = logger;
    this.fullWarnedAt = -Infinity;
    this.refusedMints = 0;
    this.ttlMs = ttlMs;
    this.max = max;
    this.now = now;
    this.records = new Map();
    // Raw tokens of links minted by this process, so a card refresh shows the
    // same link again. Memory only; a restart simply mints a new link.
    this.minted = new Map();
    // `<mr>@<sha>` -> time: the configured account approved this head commit.
    // No new link is minted for it, however long the merge request waits for
    // other approvers.
    this.approvedHeads = new Map();
  }

  /** Validates one persisted record and keeps it; `action` forces the kind (the key it was stored under). */
  adopt(r, action) {
    if (
      typeof r?.id === 'string' &&
      ID_PATTERN.test(r.id) &&
      typeof r.project === 'string' &&
      r.iid !== undefined &&
      typeof r.sha === 'string' &&
      Number.isFinite(r.createdAt) &&
      Number.isFinite(r.expiresAt) &&
      ['open', 'approved', 'used', 'stale'].includes(r.status)
    ) {
      this.records.set(r.id, {
        id: r.id,
        project: r.project,
        iid: String(r.iid),
        sha: r.sha,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        status: r.status,
        action: action || (ACTIONS.includes(r.action) ? r.action : 'approve'),
      });
    }
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const r of Array.isArray(data?.records) ? data.records : []) this.adopt(r, null);
      // Merge links live under their own key: a build that predates the Merge
      // action does not read it, so a rollback cannot turn one into an approval.
      for (const r of Array.isArray(data?.mergeRecords) ? data.mergeRecords : []) this.adopt(r, 'merge');
      for (const r of Array.isArray(data?.rebaseRecords) ? data.rebaseRecords : []) this.adopt(r, 'rebase');
      for (const r of Array.isArray(data?.batchRecords) ? data.batchRecords : []) {
        if (typeof r?.id === 'string' && ID_PATTERN.test(r.id) && ['batch-approve', 'batch-open'].includes(r.action) &&
            Array.isArray(r.items) && r.items.length > 0 && r.items.length <= 20 &&
            r.items.every((item) => typeof item.project === 'string' && typeof item.iid === 'string' && typeof item.sha === 'string') &&
            Number.isFinite(r.createdAt) && Number.isFinite(r.expiresAt) && r.status === 'open') this.records.set(r.id, r);
      }
      for (const a of Array.isArray(data?.approvedHeads) ? data.approvedHeads : []) {
        if (typeof a?.key === 'string' && Number.isFinite(a.at)) this.approvedHeads.set(a.key, a.at);
      }
    } catch (err) {
      log(`Could not read ${this.file}: ${err.message}`);
    }
    this.prune();
  }

  /**
   * Drops expired records, then (only when over the cap) used-up and superseded
   * ones, oldest first (`room` slots are kept free). A still-valid open link is never evicted: a full store
   * refuses to mint instead. Returns whether anything changed.
   */
  prune(room = 0) {
    const now = this.now();
    let changed = false;
    for (const [id, r] of this.records) {
      if (r.expiresAt <= now) {
        this.records.delete(id);
        changed = true;
      }
    }
    if (this.records.size + room > this.max) {
      const spent = [...this.records.values()].filter((r) => r.status !== 'open').sort((a, b) => a.createdAt - b.createdAt);
      for (const r of spent.slice(0, this.records.size + room - this.max)) {
        this.records.delete(r.id);
        changed = true;
      }
    }
    for (const [k, at] of this.approvedHeads) {
      if (now - at > APPROVED_KEEP_MS) {
        this.approvedHeads.delete(k);
        changed = true;
      }
    }
    if (this.approvedHeads.size > this.max) {
      const oldest = [...this.approvedHeads.entries()].sort((a, b) => a[1] - b[1]);
      for (const [k] of oldest.slice(0, this.approvedHeads.size - this.max)) this.approvedHeads.delete(k);
      changed = true;
    }
    for (const [k, m] of this.minted) {
      if (!this.records.has(m.id)) this.minted.delete(k);
    }
    return changed;
  }

  persist() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      const all = [...this.records.values()];
      // Merge records are kept apart from `records`: older builds read only that
      // key and would otherwise load a merge link as an approval link.
      const state = {
        version: 5,
        records: all.filter((r) => !['merge', 'rebase', 'batch-approve', 'batch-open'].includes(r.action)),
        mergeRecords: all.filter((r) => r.action === 'merge'),
        rebaseRecords: all.filter((r) => r.action === 'rebase'),
        batchRecords: all.filter((r) => r.action === 'batch-approve' || r.action === 'batch-open'),
        approvedHeads: [...this.approvedHeads].map(([key, at]) => ({ key, at })),
      };
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log(`Could not write ${this.file}: ${err.message}`);
    }
  }

  /**
   * A link for a merge request head commit: `{token, record}`. A still-open
   * link minted by this process is reused; otherwise a new random token is
   * issued. Open links of other head commits of the merge request become stale.
   */
  linkFor({ project, iid, sha, action = 'approve' }) {
    const unpinned = UNPINNED.has(action);
    if (!ACTIONS.includes(action)) return null;
    // An approval and a merge are pinned to a head commit; a reopen or rebase link has none to pin.
    if (!project || iid === undefined || iid === null || (!sha && !unpinned)) return null;
    let changed = this.prune();
    const key = keyOf(project, iid);
    const cacheKey = unpinned ? `${key}#${action}` : action === 'merge' ? `${key}#merge@${sha}` : `${key}@${sha}`;
    if (action === 'approve' && this.approvedHeads.has(cacheKey)) {
      if (changed) this.persist();
      return null;
    }
    for (const r of this.records.values()) {
      if (!unpinned && r.action === action && keyOf(r.project, r.iid) === key && r.sha !== sha && r.status === 'open') {
        r.status = 'stale';
        changed = true;
      }
    }
    const cached = this.minted.get(cacheKey);
    const live = cached ? this.records.get(cached.id) : null;
    if (cached && live && live.status === 'open' && live.expiresAt > this.now()) {
      if (changed) this.persist();
      return { token: cached.token, record: live };
    }
    if (this.prune(1)) changed = true;
    if (this.records.size >= this.max) {
      // Never revoke a link that is still advertised on a card.
      // Every card render would repeat this, so it is logged once per interval.
      this.refusedMints++;
      const t = this.now();
      if (t - this.fullWarnedAt >= FULL_WARN_INTERVAL_MS) {
        this.logger(`Approval link store is full (${this.max} open links); no new links are created (${this.refusedMints} refused so far)`);
        this.fullWarnedAt = t;
      }
      if (changed) this.persist();
      return null;
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const now = this.now();
    const record = {
      id: sha256Hex(token),
      project: String(project),
      iid: String(iid),
      sha: sha ? String(sha) : '-',
      createdAt: now,
      expiresAt: now + this.ttlMs,
      status: 'open',
      action,
    };
    this.records.set(record.id, record);
    this.minted.set(cacheKey, { token, id: record.id });
    this.persist();
    return { token, record };
  }

  /** A bounded capability for a fixed list. Tokens remain in memory, hashes are persisted. */
  batchLinkFor(items, action) {
    if (!['batch-approve', 'batch-open'].includes(action) || !Array.isArray(items) || !items.length || items.length > 20) return null;
    const clean = items.map(({ project, iid, sha }) => ({ project: String(project || ''), iid: String(iid || ''), sha: String(sha || '') }));
    if (clean.some((item) => !item.project || !item.iid || (action === 'batch-approve' && !item.sha))) return null;
    const key = `${action}:${JSON.stringify(clean)}`;
    this.prune();
    const cached = this.minted.get(key);
    const old = cached && this.byId(cached.id);
    if (old?.status === 'open') return cached.token;
    this.prune(1);
    if (this.records.size >= this.max) return null;
    const token = crypto.randomBytes(32).toString('base64url');
    const now = this.now();
    const record = { id: sha256Hex(token), action, items: clean, status: 'open', createdAt: now, expiresAt: now + this.ttlMs };
    this.records.set(record.id, record);
    this.minted.set(key, { id: record.id, token });
    this.persist();
    return token;
  }

  /** The record for a token, or null when it is unknown or expired. */
  byToken(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    return this.byId(sha256Hex(token));
  }

  byId(id) {
    const r = typeof id === 'string' ? this.records.get(id) : null;
    if (!r || r.expiresAt <= this.now()) return null;
    return r;
  }

  setStatus(id, status) {
    const r = this.records.get(id);
    if (!r) return;
    r.status = status;
    this.persist();
  }

  hasApprovedHead(project, iid, sha) {
    return this.approvedHeads.has(`${keyOf(project, iid)}@${sha}`);
  }

  /** The account's approval of this head is gone (revoked): links may be minted again. */
  forgetApproved(project, iid, sha) {
    if (!this.approvedHeads.delete(`${keyOf(project, iid)}@${sha}`)) return false;
    this.persist();
    return true;
  }

  /** A confirmed approval uses up every link of the merge request. */
  markApproved(project, iid, sha) {
    const key = keyOf(project, iid);
    this.approvedHeads.set(`${key}@${sha}`, this.now());
    for (const r of this.records.values()) {
      if (r.action !== 'approve' || keyOf(r.project, r.iid) !== key || r.status === 'stale') continue;
      r.status = r.sha === sha ? 'approved' : 'stale';
    }
    this.persist();
  }

  /** A confirmed reopen uses up every reopen link of the merge request. */
  markReopened(project, iid) {
    const key = keyOf(project, iid);
    for (const r of this.records.values()) {
      if (r.action === 'reopen' && keyOf(r.project, r.iid) === key && r.status === 'open') r.status = 'used';
    }
    this.persist();
  }

  /** A rebase GitLab accepted uses up every rebase link of the merge request. */
  markRebased(project, iid) {
    const key = keyOf(project, iid);
    for (const r of this.records.values()) {
      if (r.action === 'rebase' && keyOf(r.project, r.iid) === key && r.status === 'open') r.status = 'used';
    }
    this.persist();
  }

  /** A confirmed merge uses up every merge link of the merge request. */
  markMerged(project, iid) {
    const key = keyOf(project, iid);
    for (const r of this.records.values()) {
      if (r.action === 'merge' && keyOf(r.project, r.iid) === key && r.status === 'open') r.status = 'used';
    }
    this.persist();
  }

  /**
   * Closed, merged or changed merge request: no approval link of it works any
   * more (`action` 'reopen': the reopen links, for a merge request that is merged
   * or open again; 'merge': the merge links, for one that changed or is gone).
   */
  invalidate(project, iid, action = 'approve') {
    const key = keyOf(project, iid);
    for (const r of this.records.values()) {
      if (r.action === action && keyOf(r.project, r.iid) === key && r.status === 'open') r.status = 'stale';
    }
    this.persist();
  }
}

/**
 * CSRF tokens: HMAC over the session, the link record, an optional `bind`
 * string (the acting identity the page showed) and an expiry with a random
 * per-process key. A restart invalidates open pages (reload the page).
 */
export class CsrfTokens {
  constructor({ key = crypto.randomBytes(32), ttlMs = CSRF_TTL_MS, now = Date.now } = {}) {
    this.key = key;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  mac(session, id, exp, bind = '') {
    // The bind string goes last and is length-prefixed, so it cannot be shifted into another field.
    return crypto.createHmac('sha256', this.key).update(`csrf\n${session}\n${id}\n${exp}\n${String(bind).length}:${bind}`).digest('base64url');
  }

  issue(session, id, bind = '') {
    const exp = this.now() + this.ttlMs;
    return `${exp}.${this.mac(session, id, exp, bind)}`;
  }

  verify(token, session, id, bind = '') {
    if (typeof token !== 'string') return false;
    const [expRaw, mac, ...rest] = token.split('.');
    if (rest.length > 0 || !/^\d{1,16}$/.test(expRaw || '') || !mac) return false;
    const exp = Number(expRaw);
    if (exp <= this.now()) return false;
    return safeEqual(mac, this.mac(session, id, exp, bind));
  }
}

/**
 * The acting identity a confirmation page shows: the GitLab account id and the
 * credential index behind it. Null when the account cannot be told, in which
 * case nothing may be offered or sent.
 */
function actorOf(result) {
  const id = result?.user?.id;
  if (id === undefined || id === null || id === '') return null;
  const cred = result.tokenIndex === undefined || result.tokenIndex === null ? '' : String(result.tokenIndex);
  return { user: String(id), cred };
}

const actorBind = (actor) => `user=${actor.user};cred=${actor.cred}`;

const UNVERIFIED_ACCOUNT = 'The GitLab account that would act could not be verified. Nothing was sent. Reload the page to try again.';

const kindOf = (record) => (ACTIONS.includes(record?.action) ? record.action : 'approve');

// GitLab's `detailed_merge_status` values that say "not mergeable right now".
const MERGE_BLOCKS = {
  not_approved: 'The merge request still needs approvals.',
  ci_must_pass: 'The pipeline has to pass before this can be merged.',
  ci_still_running: 'The pipeline is still running.',
  discussions_not_resolved: 'Discussions are not resolved yet.',
  need_rebase: 'The source branch needs a rebase first.',
  conflict: 'The merge request has merge conflicts.',
  requested_changes: 'Changes were requested on this merge request.',
  blocked_status: 'Another merge request blocks this one.',
  merge_request_blocked: 'Another merge request blocks this one.',
  external_status_checks: 'External status checks have not passed.',
  jira_association_missing: 'The merge request needs an associated Jira issue.',
  locked_paths: 'Locked paths prevent the merge.',
  locked_lfs_files: 'Locked LFS files prevent the merge.',
  security_policy_violations: 'A security policy blocks the merge.',
  title_regex: 'The title does not match the required pattern.',
  checking: 'GitLab is still checking whether this can be merged. Reload the page in a moment.',
  unchecked: 'GitLab has not checked yet whether this can be merged. Reload the page in a moment.',
  preparing: 'GitLab is still preparing the merge request. Reload the page in a moment.',
  approvals_syncing: 'GitLab is still syncing the approvals. Reload the page in a moment.',
  draft_status: 'This merge request is a draft and cannot be merged.',
  not_open: 'This merge request is not open.',
};

/**
 * Why GitLab says this merge request cannot be merged right now, or null when it
 * is mergeable or GitLab does not say (older versions: the PUT then decides).
 */
export function mergeBlockReason(mr) {
  const status = typeof mr?.detailed_merge_status === 'string' ? mr.detailed_merge_status : '';
  if (status) {
    if (status === 'mergeable') return null;
    return MERGE_BLOCKS[status] || `GitLab reports this merge request as not mergeable (status: ${status}).`;
  }
  if (mr?.has_conflicts === true) return MERGE_BLOCKS.conflict;
  if (mr?.merge_status === 'cannot_be_merged') return 'GitLab reports this merge request as not mergeable.';
  return null;
}

/** HTTP status of a GitLabClient error message, or null for network failures. */
function gitlabStatus(err) {
  const m = /GitLab error \((\d{3})\)/.exec(err?.message || '');
  return m ? Number(m[1]) : null;
}

function originOf(value) {
  try {
    const u = new URL(value);
    return u.origin === 'null' ? null : u.origin;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name && !(name in out)) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

/** Link lifetime in seconds: the default for anything invalid, else clamped. */
export function normalizeLinkTtlSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LINK_TTL_S;
  return Math.min(MAX_LINK_TTL_S, Math.max(MIN_LINK_TTL_S, Math.floor(n)));
}

export class ApproveServer {
  /**
   * @param {object} opts
   * @param {object} opts.gitlab GitLabClient (getMr, approveMr, getUserApprovalState)
   * @param {string} opts.baseUrl public URL of the flow, e.g. https://host/approve
   * @param {(project, iid) => Promise<{matched:number,failed:number}>} [opts.refreshCards]
   * @param {(project, iid) => ({conversationId: string, messageId: string}|null)} [opts.locateCard] the Teams card with the button, for the approval comment
   * @param {string} [opts.stateFile] persisted link records (token hashes only)
   */
  constructor({
    gitlab,
    baseUrl,
    host = '127.0.0.1',
    port = 3006,
    linkTtlSeconds = DEFAULT_LINK_TTL_S,
    stateFile = null,
    refreshCards = null,
    locateCard = null,
    geoip = null,
    oauth = null,
    now = Date.now,
    mergeEnabled = false,
    rebaseEnabled = true,
    avatarOf = null,
    avatarWarm = null,
    avatarPeek = null,
    recordApprover = null,
    mergePollMs = MERGE_POLL_MS,
    mergePollAttempts = MERGE_POLL_ATTEMPTS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    dashboard = null,
    dashSessionFile = null,
    pushFile = null,
  } = {}) {
    if (!gitlab) throw new Error('approve: a GitLab client is required');
    let base;
    try {
      base = new URL(baseUrl);
    } catch {
      throw new Error('approve: base_url is missing or not a valid URL');
    }
    const localBase = LOOPBACK_HOSTS.has(base.hostname.replace(/^\[|\]$/g, ''));
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && localBase)) {
      throw new Error('approve: base_url must be an https URL (the link is a bearer credential)');
    }
    if (base.hash || base.search) throw new Error('approve: base_url must not contain a query or fragment');
    if (!LOOPBACK_HOSTS.has(host)) throw new Error(`approve: host must be a loopback address, got ${host}`);

    this.gitlab = gitlab;
    this.host = host;
    this.port = Number(port);
    this.origin = base.origin;
    this.secure = base.protocol === 'https:';
    this.basePath = base.pathname.replace(/\/+$/, '');
    this.refreshCards = refreshCards;
    // (project, iid) => {conversationId, messageId} | null: the Teams card that carries the button.
    this.locateCard = locateCard;
    // {lookup(ip)} from geoip.mjs, or null: where an approving address is, for the comment on the MR.
    this.geoip = geoip;
    // {clientId, clientSecret, allowedUsers?} or null: who confirms is learned by "Sign in with GitLab".
    this.oauth = oauth?.clientId && oauth?.clientSecret
      ? { clientId: String(oauth.clientId), clientSecret: String(oauth.clientSecret), allowedUsers: new Set((oauth.allowedUsers || []).map((u) => String(u).toLowerCase())) }
      : null;
    this.oauthStates = new Map();
    this.now = now;
    // Off unless asked for: merging from a card is a deliberate, separate opt-in.
    this.mergeEnabled = mergeEnabled === true;
    // On unless switched off: a rebase rewrites no history the author did not already own, so it needs no opt-in.
    this.rebaseEnabled = rebaseEnabled !== false;
    // (name) => picture data URI for a person, and (names) => Promise that loads their photos: from the watcher.
    this.avatarOf = typeof avatarOf === 'function' ? avatarOf : null;
    this.avatarWarm = typeof avatarWarm === 'function' ? avatarWarm : null;
    // (person) => cached photo or null: for people known by email (the on-duty responders from OpsGenie).
    this.avatarPeek = typeof avatarPeek === 'function' ? avatarPeek : null;
    // (project, iid, {username, name}) => void: who really approved, so the card can show them instead of the bot.
    this.recordApprover = typeof recordApprover === 'function' ? recordApprover : null;
    this.mergePollMs = mergePollMs;
    this.mergePollAttempts = Math.max(1, Number(mergePollAttempts) || 1);
    this.rebasePollMs = mergePollMs === MERGE_POLL_MS ? REBASE_POLL_MS : mergePollMs;
    this.rebasePollAttempts = mergePollAttempts === MERGE_POLL_ATTEMPTS ? REBASE_POLL_ATTEMPTS : Math.max(1, Number(mergePollAttempts) || 1);
    this.sleep = sleep;
    this.store = new ApprovalStore({ file: stateFile, ttlMs: normalizeLinkTtlSeconds(linkTtlSeconds) * 1000, now });
    this.store.load();
    this.csrf = new CsrfTokens({ now });
    this.sessions = new Map();
    this.requestContext = new AsyncLocalStorage();
    this.failures = { windowStart: 0, count: 0 };
    this.locks = new Map();
    this.bootstraps = new Map();
    this.readCache = new Map();
    this.revalidations = new Map();
    this.server = null;
    this.script = this.bootstrapScript();
    this.scriptHash = `sha256-${crypto.createHash('sha256').update(this.script).digest('base64')}`;
    this.openBootstrapScript = this.bootstrapScript('/open/view');
    this.openBootstrapHash = `sha256-${crypto.createHash('sha256').update(this.openBootstrapScript).digest('base64')}`;
    // The script that keeps an open page current (the state endpoint is `<base>/state`).
    this.liveScript = liveScript(`${this.basePath}/state`);
    this.liveHash = `sha256-${crypto.createHash('sha256').update(this.liveScript).digest('base64')}`;
    this.openAllScript = `(function(){var button=document.getElementById('open-all'),note=document.getElementById('open-note');function openPending(){var pending=document.querySelectorAll('[data-mr-link]:not([data-opened])');pending.forEach(function(a){var w=window.open('','_blank');if(!w)return;try{w.opener=null;w.location.replace(a.href);a.setAttribute('data-opened','true')}catch(e){try{w.close()}catch(ignore){}}});if(document.querySelectorAll('[data-mr-link]:not([data-opened])').length){note.textContent='Some tabs could not be opened. Allow pop-ups and retry, or open the remaining links below.'}else{note.textContent='All tabs opened.';button.hidden=true}}button.addEventListener('click',openPending);openPending()})();`;
    this.openAllHash = `sha256-${crypto.createHash('sha256').update(this.openAllScript).digest('base64')}`;
    this.batchApprovalHash = `sha256-${crypto.createHash('sha256').update(BATCH_APPROVAL_SCRIPT).digest('base64')}`;
    // Links on the pages point at the GitLab host only.
    this.gitlabHost = typeof gitlab.host === 'string' ? gitlab.host : '';
    this.lastApprovals = new Map();
    this.liveCache = new Map();
    // The dashboard: on only with GitLab sign-in and a group whose members may see it.
    // `sources` are the bot's own readers: {sprint, alerts, meetings}, each () => Promise.
    this.dashboard = dashboard?.enable && dashboard.group && this.oauth
      ? { group: String(dashboard.group), sources: dashboard.sources || {}, timeZone: dashboard.timeZone || 'Europe/Berlin', push: dashboard.push !== false }
      : null;
    // Where the dashboard is served: its own public path on the same host (e.g. `/dashboard`) or below the base path.
    const ownPath = typeof dashboard?.path === 'string' ? dashboard.path.trim().replace(/\/+$/, '') : '';
    if (ownPath && !/^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(ownPath)) throw new Error('approve: dashboard.path must be an absolute path like /dashboard');
    this.dashPath = ownPath || `${this.basePath}/dashboard`;
    this.dashSessions = new Map();
    // Dashboard sessions survive a restart: kept in this file, encrypted with a key derived from the OAuth secret.
    this.dashSessionFile = this.dashboard && dashSessionFile ? String(dashSessionFile) : null;
    this.loadDashSessions();
    // Push notifications (Web Push): the VAPID key pair and the browsers' subscriptions, kept in this file,
    // encrypted like the sessions. Each subscription belongs to the dashboard session that made it.
    this.pushFile = this.dashboard?.push && pushFile ? String(pushFile) : null;
    this.vapid = null;
    this.pushSubs = new Map();
    this.loadPush();
    this.dashData = new Map();
    this.dashSourceCache = new Map();
    this.dashboardScript = dashboardScript(this.dashPath);
    this.dashboardWorker = serviceWorkerScript(this.dashPath);
    this.dashboardHash = `sha256-${crypto.createHash('sha256').update(this.dashboardScript).digest('base64')}`;
  }

  /**
   * URL of the confirmation entry page, or null: for an approval of a merge
   * request head commit, (`action: 'merge'`) for merging it, or
   * (`action: 'reopen'`) for reopening a closed one.
   */
  linkFor({ project, iid, sha, action = 'approve' }) {
    // No merge link is minted (so no button is shown) while merging is switched off.
    if (action === 'merge' && !this.mergeEnabled) return null;
    if (action === 'rebase' && !this.rebaseEnabled) return null;
    try {
      // A previous bot approval must not suppress another person's approval.
      if (action === 'approve' && this.oauth) this.store.forgetApproved(project, iid, sha);
      else if (action === 'approve' && this.store.hasApprovedHead(project, iid, sha)) this.revalidateApproved(project, iid, sha);
      const link = this.store.linkFor({ project, iid, sha, action });
      return link ? `${this.origin}${this.basePath}/#${link.token}` : null;
    } catch (err) {
      log(`Could not create an approval link: ${err.message}`);
      return null;
    }
  }

  batchLinkFor(items, action) {
    const token = this.store.batchLinkFor(items, action === 'open' ? 'batch-open' : 'batch-approve');
    return token ? `${this.origin}${this.basePath}${action === 'open' ? '/open' : '/'}#${token}` : null;
  }

  /**
   * The remembered "the account approved this head" is only a hint: the approval
   * can be revoked in GitLab. Re-check it (at most once per interval and head);
   * when it is gone, forget the hint and refresh the cards so the button returns.
   * An unknown answer keeps the hint.
   */
  revalidateApproved(project, iid, sha) {
    const key = `${project}!${iid}@${sha}`;
    const now = this.now();
    const last = this.revalidations.get(key);
    if (last !== undefined && now - last < REVALIDATE_MS) return;
    for (const [k, at] of this.revalidations) {
      if (now - at >= REVALIDATE_MS) this.revalidations.delete(k);
    }
    this.revalidations.set(key, now);
    Promise.resolve()
      .then(() => this.gitlab.getUserApprovalState(project, iid))
      .then(async (state) => {
        if (!state?.known || state.hasApproved) return;
        if (!this.store.forgetApproved(project, iid, sha)) return;
        this.revalidations.delete(key);
        log(`Approval of ${project}!${iid} was revoked; links are offered again`);
        if (this.refreshCards) await this.refreshCards(project, iid);
      })
      .catch((err) => log(`Approval re-check failed for ${project}!${iid}: ${err.message}`));
  }

  start() {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        const theme = parseCookies(req.headers.cookie).tl_theme;
        this.requestContext.run({ user: this.rememberedUser(req), theme: theme === 'dark' || theme === 'light' ? theme : '' }, () => {
          this.handle(req, res).catch((err) => {
            log(`Unhandled error: ${err.message}`);
            if (!res.headersSent) this.send(res, 500, this.page('Error', '<p>Something went wrong. Nothing was approved.</p>', { tone: 'error' }));
            else res.end();
          });
        });
      });
      srv.once('error', reject);
      srv.listen(this.port, this.host, () => {
        this.server = srv;
        if (this.vapid && !this.pushTimer) {
          this.pushTimer = setInterval(() => this.pushTick().catch((err) => log(`Push round failed: ${err.message}`)), PUSH_POLL_MS);
          this.pushTimer.unref?.();
        }
        this.port = srv.address().port;
        log(`Approval flow listening on http://${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    if (this.pushTimer) clearInterval(this.pushTimer);
    this.pushTimer = null;
    if (!this.server) return Promise.resolve();
    return new Promise((resolve) => {
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  // --- HTTP helpers ---

  headers(extra = {}, { script = false } = {}) {
    // Referrer-Policy same-origin (not no-referrer): with no-referrer browsers
    // send `Origin: null` on the confirmation form, which the Origin check must
    // reject. Nothing secret is in any URL the page is served from.
    return {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      // img-src data: only: the pictures are embedded (card icons, profile pictures), never fetched. The dashboard
      // also loads its own app icon (home screen, desktop notifications).
      'Content-Security-Policy': `default-src 'none'; img-src data:${script === 'dashboard' ? " 'self'" : ''}; style-src 'unsafe-inline'; ${script === 'dashboard' ? "manifest-src 'self'; worker-src 'self'; " : ''}${script ? `script-src '${script === 'live' ? this.liveHash : script === 'batch' ? this.batchApprovalHash : script === 'open-all' ? this.openAllHash : script === 'open-bootstrap' ? this.openBootstrapHash : script === 'dashboard' ? this.dashboardHash : this.scriptHash}'; connect-src 'self'; ` : ''}form-action ${this.origin}; frame-ancestors 'none'; base-uri 'none'`,
      ...extra,
    };
  }

  send(res, status, html, { head = false, extra = {}, script = false } = {}) {
    // A page with a merge request on it carries the live script (see page()).
    if (!script && html.includes('data-live-root')) script = 'live';
    const body = head ? '' : html;
    res.writeHead(status, this.headers({ 'Content-Length': Buffer.byteLength(html), ...extra }, { script }));
    res.end(body);
  }

  /**
   * One HTML shell for every page. Self-contained on purpose: inline CSS and an
   * inline SVG only (the CSP allows nothing else), no external fonts or images.
   * `tone` colors the panel edge: neutral, ok, warn or error.
   */
  page(title, body, { script = '', tone = 'neutral', kind = 'approve', wide = false } = {}) {
    const safeTone = ['neutral', 'ok', 'warn', 'error'].includes(tone) ? tone : 'neutral';
    const copy = COPY[kind] || COPY.approve;
    const live = body.includes('data-live-root');
    const tail = script || (live ? `<script>${this.liveScript}</script>` : '');
    const main = `<main class="panel tone-${safeTone}"><div class="page-head">${heroIcon(safeTone)}<h1>${escapeHtml(title)}</h1></div>${body}${tail}</main>`;
    return this.documentHtml({ title, kicker: copy.kicker, live, shell: wide ? 'shell wide' : 'shell', main });
  }

  /** The HTML document every page shares: head, top bar with the signed-in account, the shell and the footer. */
  documentHtml({ title, kicker, live = false, shell = 'shell', main, css = '', dashLink = true, menu = '', actions = '', footer = true, head = '' }) {
    const user = this.requestContext.getStore()?.user;
    // The visitor's theme choice (tl_theme cookie, set by the dashboard's account menu): auto, light or dark.
    const theme = this.requestContext.getStore()?.theme || '';
    let avatar = '';
    try { if (user) avatar = this.avatarOf?.(user.name || user.username) || ''; } catch { /* Fall back to initials. */ }
    const items = `${this.dashboard && dashLink ? `<a class="menu-item" href="${escapeHtml(this.dashPath)}">${MENU_ICONS.dashboard}Dashboard</a>` : ''}${this.dashboard ? `<a class="menu-item" href="${escapeHtml(`${this.dashPath}#settings`)}" data-view-to="settings">${MENU_ICONS.settings}Settings</a>` : ''}${menu}`;
    const account = user ? headerAccount(user, this.gitlabHost, avatar, items) : '';
    return `<!doctype html><html lang="en"${theme ? ` data-theme="${theme}"` : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="${theme || 'light dark'}"><meta name="robots" content="noindex"><meta name="referrer" content="same-origin"><link rel="icon" type="image/png" href="${FAVICON}">${head}<title>${escapeHtml(title)} · teams-live</title><style>${PAGE_CSS}${css}</style></head><body><header class="${shell.replace(/\bshell\b/, 'brand')}"><div class="in">${this.dashboard ? `<a class="home" href="${escapeHtml(`${this.dashPath}#overview`)}" data-home aria-label="teams-live dashboard">${TANUKI}<span class="word">teams-live</span></a>` : `${TANUKI}<span class="word">teams-live</span>`}<span class="sep" aria-hidden="true">/</span><span class="kicker">${kicker}</span>${live ? '<span class="live-dot" title="This page keeps itself up to date"><i></i>Live</span>' : ''}${actions}${account}</div></header><div class="${shell}">${main}${footer ? FOOTER : ''}</div></body></html>`;
  }

  /** The static script that exchanges the fragment token for a session. */
  bootstrapScript(destination = '/confirm') {
    const base = JSON.stringify(`${this.basePath}`);
    return `(function(){var B=${base},m=document.getElementById('msg');function say(t){m.textContent=t}var h=location.hash.replace(/^#/,'');try{history.replaceState(null,'',location.pathname+location.search)}catch(e){}if(!/^[A-Za-z0-9_-]{43}$/.test(h)){say('This link is incomplete. Use the button on the Teams card.');return}fetch(B+'/session',{method:'POST',credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'token='+h}).then(function(r){if(r.ok){location.replace(B+${JSON.stringify(destination)});return}if(r.status===410){say('This link was already used or the merge request changed. Use the button on the current Teams card.')}else if(r.status===429){say('Too many attempts. Try again in a minute.')}else if(r.status===404){say('This link is unknown or has expired. Use the button on the current Teams card.')}else{say('The link could not be opened. Nothing was changed.')}}).catch(function(){say('The link could not be opened. Nothing was changed.')})})();`;
  }

  /** Route below the base path ("/", "/session", "/confirm") or null. */
  route(req) {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return null;
    }
    // The dashboard on its own path; its old address below the base path leads there.
    const legacy = `${this.basePath}/dashboard`;
    if (this.dashboard && this.dashPath !== legacy && (pathname === legacy || pathname.startsWith(`${legacy}/`))) return '/dashboard-moved';
    if (this.dashboard && (pathname === this.dashPath || pathname.startsWith(`${this.dashPath}/`))) {
      const sub = pathname.slice(this.dashPath.length);
      return ['', '/data', '/approve', '/signin', '/signout', '/issue', '/alert', '/mr', '/move', '/push', '/sw.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'].includes(sub) ? `/dashboard${sub}` : null;
    }
    if (this.basePath && (pathname === this.basePath || pathname.startsWith(`${this.basePath}/`))) {
      pathname = pathname.slice(this.basePath.length) || '/';
    }
    return ['/', '/open', '/open/view', '/session', '/confirm', '/state', '/oauth/start', '/oauth/callback', '/dashboard', '/dashboard/data', '/dashboard/issue', '/dashboard/alert', '/dashboard/mr', '/dashboard/move', '/dashboard/push', '/dashboard/sw.js', '/dashboard/manifest.webmanifest', '/dashboard/icon-192.png', '/dashboard/icon-512.png', '/dashboard/approve', '/dashboard/signin', '/dashboard/signout'].includes(pathname) ? pathname : null;
  }

  readForm(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(Object.assign(new Error('too large'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
      req.on('error', reject);
    });
  }

  /** The configured origin must match the request's Origin (or Referer). Fails closed. */
  originAllowed(req) {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin) return origin === this.origin;
    const referer = req.headers.referer;
    if (typeof referer === 'string' && referer) return originOf(referer) === this.origin;
    return false;
  }

  /** Checks POST content type and reads the urlencoded form. Returns `{form}` or `{status}`. */
  async postForm(req) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/x-www-form-urlencoded') return { status: 415 };
    try {
      return { form: await this.readForm(req) };
    } catch (err) {
      return { status: err.status || 400 };
    }
  }

  // --- sessions ---

  openSession(record) {
    const now = this.now();
    for (const [h, s] of this.sessions) {
      if (s.expiresAt <= now) this.sessions.delete(h);
    }
    // A link holds only a few sessions at a time: opening more replaces its own
    // oldest ones, so one holder cannot push out the sessions of other links.
    const own = [...this.sessions.entries()].filter(([, s]) => s.recordId === record.id);
    for (const [h] of own.slice(0, Math.max(0, own.length - (MAX_SESSIONS_PER_LINK - 1)))) this.sessions.delete(h);
    while (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value);
    const sid = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Math.min(now + SESSION_TTL_MS, record.expiresAt);
    const key = sha256Hex(sid);
    const session = { recordId: record.id, expiresAt, user: null };
    this.sessions.set(key, session);
    // Discard any OAuth token even when no further requests arrive.
    const timer = setTimeout(() => {
      if (this.sessions.get(key) === session) this.sessions.delete(key);
    }, Math.max(1, expiresAt - now));
    timer.unref?.();
    return { sid, maxAge: Math.max(1, Math.floor((expiresAt - now) / 1000)) };
  }

  /** At most a handful of successful bootstraps per link and minute. */
  allowBootstrap(record) {
    const now = this.now();
    for (const [id, w] of this.bootstraps) {
      if (now - w.start > 60_000 || !this.store.records.has(id)) this.bootstraps.delete(id);
    }
    const w = this.bootstraps.get(record.id) || { start: now, count: 0 };
    w.count++;
    this.bootstraps.set(record.id, w);
    return w.count <= MAX_BOOTSTRAPS_PER_LINK_PER_MINUTE;
  }

  /** The session of a request: `{sid, record}` or null. The record may be used up. */
  sessionOf(req) {
    const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (typeof sid !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sid)) return null;
    const s = this.sessions.get(sha256Hex(sid));
    if (!s || s.expiresAt <= this.now()) return null;
    const record = this.store.byId(s.recordId);
    return record ? { sid, record, user: s.user || null, accessToken: s.accessToken || null } : null;
  }

  cookie(value, maxAge) {
    return `${COOKIE_NAME}=${value}; Path=${this.basePath || '/'}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${this.secure ? '; Secure' : ''}`;
  }

  noteFailure() {
    const now = this.now();
    if (now - this.failures.windowStart > 60_000) this.failures = { windowStart: now, count: 0 };
    this.failures.count++;
  }

  throttled() {
    const now = this.now();
    return now - this.failures.windowStart <= 60_000 && this.failures.count >= MAX_BOOTSTRAP_FAILURES_PER_MINUTE;
  }

  // --- request handling ---

  async handle(req, res) {
    const method = req.method;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      this.send(res, 405, this.page('Not allowed', '<p>Method not allowed.</p>', { tone: 'warn' }), { extra: { Allow: 'GET, HEAD, POST' } });
      return;
    }
    const route = this.route(req);
    if (!route) {
      this.send(res, 404, this.page('Not found', '<p>Nothing here.</p>', { tone: 'warn' }), { head: method === 'HEAD' });
      return;
    }
    const head = method === 'HEAD';
    if (route === '/' || route === '/open') {
      if (method === 'POST') return this.send(res, 405, this.page('Not allowed', '<p>Method not allowed.</p>', { tone: 'warn' }), { extra: { Allow: 'GET, HEAD' } });
      const body = this.page(
        'Opening link',
        '<p id="msg">Opening the link…</p><noscript><p>JavaScript is required to open this link.</p></noscript>',
        { script: `<script>${route === '/open' ? this.openBootstrapScript : this.script}</script>`, kind: 'generic' },
      );
      return this.send(res, 200, body, { head, script: route === '/open' ? 'open-bootstrap' : true });
    }
    if (route === '/session') {
      if (method !== 'POST') return this.send(res, 405, this.page('Not allowed', '<p>Method not allowed.</p>', { tone: 'warn' }), { extra: { Allow: 'POST' } });
      return this.bootstrap(req, res);
    }
    if (route === '/state') {
      if (method !== 'GET') return this.send(res, 405, this.page('Not allowed', '<p>Method not allowed.</p>', { tone: 'warn' }), { extra: { Allow: 'GET' } });
      return this.state(req, res);
    }
    if (route === '/oauth/start' || route === '/oauth/callback') {
      if (!this.oauth) return this.send(res, 404, this.page('Not found', '<p>Nothing here.</p>', { tone: 'warn' }));
      if (method === 'POST') return this.send(res, 405, this.page('Not allowed', '<p>Method not allowed.</p>', { tone: 'warn' }), { extra: { Allow: 'GET, HEAD' } });
      if (method === 'HEAD') return this.send(res, 200, '', { head: true });
      return route === '/oauth/start' ? this.oauthStart(req, res) : this.oauthCallback(req, res);
    }
    if (route === '/dashboard-moved') {
      res.writeHead(308, this.headers({ Location: this.dashPath }));
      return res.end();
    }
    if (route.startsWith('/dashboard')) return this.handleDashboard(route, req, res);
    // /open/view and /confirm require a session created from the capability.
    if (method === 'HEAD') return this.send(res, 200, '', { head: true });
    const session = this.sessionOf(req);
    if (!session) {
      return this.send(res, 401, this.page('Link not opened', '<p>Open the link from the Teams card again. Nothing was changed.</p>', { tone: 'warn' }));
    }
    if (session.user) this.requestContext.getStore().user = session.user;
    if (route === '/open/view') {
      if (method !== 'GET') return this.send(res, 405, this.page('Not allowed', '<p>Method not allowed.</p>', { tone: 'warn' }), { extra: { Allow: 'GET, HEAD' } });
      if (session.record.action !== 'batch-open') return this.send(res, 404, this.page('Not found', '<p>Nothing here.</p>', { tone: 'warn' }));
      return this.showBatchOpen(res, session.record);
    }
    // Old open-all links still lead here after bootstrap.
    if (session.record.action === 'batch-open') return this.showBatchOpen(res, session.record);
    if (session.record.action === 'batch-approve') return method === 'GET' ? this.showBatchApproval(res, session) : this.approveBatch(req, res, session);
    if (method === 'GET') return this.showConfirmation(res, session);
    return this.approve(req, res, session);
  }

  /** Exchanges the fragment token for a session cookie. Never approves or consumes anything. */
  async bootstrap(req, res) {
    const reply = (status, text, extra = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
      res.end(text);
    };
    if (!this.originAllowed(req)) return reply(403, 'forbidden');
    const parsed = await this.postForm(req);
    if (!parsed.form) return reply(parsed.status, 'rejected');
    // Look the token up first: the counter of unknown tokens only slows down
    // guessing and must never lock out a valid link.
    const record = this.store.byToken(parsed.form.get('token'));
    if (!record) {
      if (this.throttled()) return reply(429, 'too many attempts', { 'Retry-After': '60' });
      this.noteFailure();
      return reply(404, 'unknown or expired');
    }
    if (record.status !== 'open') return reply(410, 'used or superseded');
    if (!this.allowBootstrap(record)) return reply(429, 'too many attempts', { 'Retry-After': '60' });
    const { sid, maxAge } = this.openSession(record);
    // A signed-in visitor stays signed in for the next links: the signed cookie of an earlier sign-in.
    const remembered = this.rememberedUser(req);
    if (remembered) this.sessions.get(sha256Hex(sid)).user = remembered;
    return reply(200, 'ok', { 'Set-Cookie': this.cookie(sid, maxAge) });
  }

  /**
   * Reads the live merge request and decides what the page may offer:
   * `ready`, `already` (the configured account approved) or `blocked`.
   */
  async evaluate(record) {
    if (record.action === 'reopen') return this.evaluateReopen(record);
    if (record.action === 'rebase') {
      // A link minted while rebasing was on stops working when it is switched off.
      if (!this.rebaseEnabled) return { status: 'blocked', reason: 'Rebasing from cards is turned off. Nothing was rebased.' };
      return this.evaluateRebase(record);
    }
    if (record.action === 'merge') {
      // A link minted while merging was on stops working when it is switched off.
      if (!this.mergeEnabled) return { status: 'blocked', reason: 'Merging from cards is turned off. Nothing was merged.' };
      return this.evaluateMerge(record);
    }
    if (record.status === 'approved') return { status: 'used' };
    if (record.status === 'stale') return { status: 'blocked', reason: 'This link was superseded because the merge request changed. Use the button on the current Teams card.' };
    let mr;
    let tokenIndex;
    try {
      ({ mr, tokenIndex } = await this.readMr(record));
    } catch {
      return { status: 'blocked', reason: 'GitLab could not be reached to read the merge request. Nothing was approved. Try again later.' };
    }
    if (mr?.state !== 'opened') {
      this.store.invalidate(record.project, record.iid);
      return { status: 'blocked', mr, tokenIndex, reason: `This merge request is ${mr?.state === 'merged' ? 'merged' : 'no longer open'}. Nothing to approve.` };
    }
    const draft = Boolean(mr.draft || mr.work_in_progress || mr.detailed_merge_status === 'draft_status');
    if (draft) return { status: 'blocked', mr, reason: 'This merge request is a draft and cannot be approved.' };
    const head = mr.sha || mr.diff_refs?.head_sha || null;
    if (!head) return { status: 'blocked', mr, reason: 'The head commit of the merge request is unknown. Nothing was approved.' };
    if (head !== record.sha) {
      this.store.invalidate(record.project, record.iid);
      return { status: 'blocked', mr, reason: 'The merge request changed after this card was posted (new commits). Review it again and use the button on the updated card.' };
    }
    // Identity and approvals come from the credential that can see the merge
    // request, and the approval is sent under that same one.
    const state = await this.gitlab.getUserApprovalState(record.project, record.iid, this.asToken(tokenIndex));
    if (tokenIndex !== undefined && state.tokenIndex !== undefined && state.tokenIndex !== tokenIndex) {
      return { status: 'blocked', mr, reason: 'The GitLab account could not be verified consistently. Nothing was approved. Try again later.' };
    }
    if (!state.known) {
      return { status: 'blocked', mr, reason: 'The configured GitLab account or the current approvals could not be verified. Nothing was approved. Try again later.' };
    }
    if (state.hasApproved) return { status: 'already', mr, user: state.user, tokenIndex };
    if (state.canApprove === false) {
      return { status: 'blocked', mr, user: state.user, tokenIndex, reason: 'GitLab does not allow the configured account to approve this merge request (for example as its author).' };
    }
    return { status: 'ready', mr, user: state.user, tokenIndex };
  }

  /**
   * Reads the merge request and, with the real client, WHO acts: the first
   * credential that can see it (`tokenIndex`). Stand-ins without `locateMr` read
   * it the plain way and leave the credential undecided.
   */
  async readMr(record) {
    if (typeof this.gitlab.locateMr === 'function') {
      const found = await this.gitlab.locateMr(record.project, record.iid);
      return { mr: found.mr, tokenIndex: found.tokenIndex, user: found.user };
    }
    return { mr: await this.gitlab.getMr(record.project, record.iid), tokenIndex: undefined, user: null };
  }

  /** Option object that pins a read to the credential chosen by the preflight (empty when none was). */
  asToken(tokenIndex) {
    return tokenIndex === undefined ? undefined : { tokenIndex };
  }

  /**
   * Options for a write: the credential the preflight chose, and the account
   * that was shown, which the client re-checks before it sends anything. Empty
   * when the flow runs on a stand-in client.
   */
  asActor(result) {
    if (result?.tokenIndex === undefined) return {};
    return { tokenIndex: result.tokenIndex, ...(result.user?.id ? { expectUserId: result.user.id } : {}) };
  }

  /**
   * Reopen: only a closed merge request that was not merged can be reopened.
   * `ready`, `already` (it is open again) or `blocked`. The head commit plays
   * no role; the account is not verified beforehand, GitLab decides on the PUT.
   */
  async evaluateReopen(record) {
    if (record.status === 'used') return { status: 'used' };
    if (record.status === 'stale') return { status: 'blocked', reason: 'This link is no longer valid because the merge request changed. Use the button on the current Teams card.' };
    let mr;
    let tokenIndex;
    let located = null;
    try {
      ({ mr, tokenIndex, user: located } = await this.readMr(record));
    } catch {
      return { status: 'blocked', reason: 'GitLab could not be reached to read the merge request. Nothing was reopened. Try again later.' };
    }
    if (mr?.state === 'opened') {
      this.store.invalidate(record.project, record.iid, 'reopen');
      return { status: 'already', mr, tokenIndex };
    }
    if (mr?.state === 'merged') {
      this.store.invalidate(record.project, record.iid, 'reopen');
      return { status: 'blocked', mr, reason: 'This merge request is merged and cannot be reopened.' };
    }
    if (mr?.state !== 'closed') {
      return { status: 'blocked', mr, reason: 'The state of the merge request is unknown. Nothing was reopened.' };
    }
    const user = await this.actingUser(tokenIndex, located);
    return { status: 'ready', mr, user, tokenIndex };
  }

  /**
   * Merge: only an open, non-draft merge request whose head commit is still the
   * one the link was made for, and that GitLab reports as mergeable. `ready`,
   * `already` (merged at that head) or `blocked`. GitLab decides again on the
   * PUT; this read only keeps the page from offering what cannot work. The
   * account is not verified beforehand either.
   */
  async evaluateMerge(record) {
    if (record.status === 'used') return { status: 'used' };
    if (record.status === 'stale') return { status: 'blocked', reason: 'This link was superseded because the merge request changed. Use the button on the current Teams card.' };
    let mr;
    let tokenIndex;
    let located = null;
    try {
      ({ mr, tokenIndex, user: located } = await this.readMr(record));
    } catch {
      return { status: 'blocked', reason: 'GitLab could not be reached to read the merge request. Nothing was merged. Try again later.' };
    }
    const head = mr?.sha || mr?.diff_refs?.head_sha || null;
    if (mr?.state === 'merged') {
      if (head && head === record.sha) return { status: 'already', mr };
      this.store.invalidate(record.project, record.iid, 'merge');
      return { status: 'blocked', mr, reason: 'This merge request is merged, but not at the head commit this link was made for. Nothing was merged by this link.' };
    }
    if (mr?.state === 'locked') {
      return { status: 'blocked', mr, reason: 'GitLab is merging this merge request right now. Reload the page in a moment.' };
    }
    if (mr?.state !== 'opened') {
      this.store.invalidate(record.project, record.iid, 'merge');
      return { status: 'blocked', mr, reason: `This merge request is ${mr?.state === 'closed' ? 'closed' : 'no longer open'}. Nothing to merge.` };
    }
    const draft = Boolean(mr.draft || mr.work_in_progress || mr.detailed_merge_status === 'draft_status');
    if (draft) return { status: 'blocked', mr, reason: 'This merge request is a draft and cannot be merged.' };
    if (!head) return { status: 'blocked', mr, reason: 'The head commit of the merge request is unknown. Nothing was merged.' };
    if (head !== record.sha) {
      this.store.invalidate(record.project, record.iid, 'merge');
      return { status: 'blocked', mr, reason: 'The merge request changed after this card was posted (new commits). Review it again and use the button on the updated card.' };
    }
    const reason = mergeBlockReason(mr);
    if (reason) return { status: 'blocked', mr, reason };
    const user = await this.actingUser(tokenIndex, located);
    return { status: 'ready', mr, user, tokenIndex };
  }

  /**
   * Rebase: only an open merge request that is behind its target branch and has no conflicts. `ready`,
   * `already` (it is up to date, or GitLab is rebasing it right now) or `blocked`. GitLab decides again on
   * the PUT; this read only keeps the page from offering what cannot work.
   */
  async evaluateRebase(record) {
    if (record.status === 'used') return { status: 'used' };
    if (record.status === 'stale') return { status: 'blocked', reason: 'This link is no longer valid because the merge request changed. Use the button on the current Teams card.' };
    let mr;
    let tokenIndex;
    let located = null;
    try {
      ({ mr, tokenIndex, user: located } = await this.readMr(record));
    } catch {
      return { status: 'blocked', reason: 'GitLab could not be reached to read the merge request. Nothing was rebased. Try again later.' };
    }
    if (mr?.state !== 'opened') {
      this.store.invalidate(record.project, record.iid, 'rebase');
      return { status: 'blocked', mr, reason: `This merge request is ${mr?.state === 'merged' ? 'merged' : 'no longer open'}. Nothing to rebase.` };
    }
    if (mr.rebase_in_progress === true) return { status: 'already', mr, rebasing: true };
    const status = mr.detailed_merge_status;
    if (mr.has_conflicts === true || status === 'conflict') {
      return { status: 'blocked', mr, reason: 'The merge request has merge conflicts. A rebase cannot fix them: resolve them in GitLab. Nothing was rebased.' };
    }
    const behind = status === 'need_rebase' || mr.should_be_rebased === true || (typeof mr.diverged_commits_count === 'number' && mr.diverged_commits_count > 0);
    if (!behind) {
      this.store.invalidate(record.project, record.iid, 'rebase');
      return { status: 'already', mr, tokenIndex };
    }
    const user = await this.actingUser(tokenIndex, located);
    return { status: 'ready', mr, user, tokenIndex };
  }

  /** The account behind the credential that will act, or null when it cannot be told (never another credential's). */
  async actingUser(tokenIndex, located) {
    if (located?.id) return located;
    if (typeof this.gitlab.getCurrentUser !== 'function') return null;
    const user = await this.gitlab.getCurrentUser(this.asToken(tokenIndex)).catch(() => null);
    return user?.id ? user : null;
  }

  summary(record, mr, user) {
    const kind = kindOf(record);
    const approvals = this.lastApprovals.get(record.id) ?? null;
    const lines = [renderSummary({ record, mr, approvals, host: this.gitlabHost, kind, avatars: this.avatarsFor(mr, approvals) })];
    if (user) {
      const who = escapeHtml(user.username || user.name || user.id);
      lines.push(
        record.action === 'reopen'
          ? `<p class="callout">The merge request is reopened with the configured GitLab account <code>${who}</code>, not as you personally.${this.anyone('reopen')}</p>`
          : record.action === 'rebase'
            ? `<p class="callout">The rebase is made with the configured GitLab account <code>${who}</code>, not as you personally.${this.anyone('rebase')}</p>`
          : record.action === 'merge'
            ? `<p class="callout">The merge is made with the configured GitLab account <code>${who}</code>, not as you personally.${this.anyone('merge')} GitLab's own rules (approvals, pipeline, protected branch) still apply and are not bypassed.</p>`
            : `<p class="callout">The approval is made as GitLab user <code>${who}</code>.</p>`,
      );
    }
    return lines.join('');
  }

  anyone(verb) {
    return this.oauth ? '' : ` Anyone with this link can ${verb}${verb === 'reopen' ? ' it' : ''}.`;
  }

  bindOf(actor, user) {
    return `${actorBind(actor)}${this.oauth ? `;who=${user?.username || ''}` : ''}`;
  }

  /** Why the signed-in user may not act on this merge request, or '' (also when sign-in is off). */
  signInDenied(user, mr, kind = 'approve') {
    if (!this.oauth) return '';
    if (!user) return 'Sign in with GitLab first.';
    const name = String(user.username).toLowerCase();
    if (this.oauth.allowedUsers.size > 0 && !this.oauth.allowedUsers.has(name)) return `The GitLab user ${user.username} is not allowed to use this page.`;
    // Only an approval is about a second pair of eyes: the author may rebase, merge or reopen their own merge request.
    if (kind === 'approve' && mr?.author?.username && String(mr.author.username).toLowerCase() === name) return 'You are the author of this merge request and cannot confirm it yourself.';
    return '';
  }

  /** No identity yet: straight on to GitLab (it skips its own prompts for a signed-in, authorized user). */
  signInPage(res) {
    res.writeHead(302, this.headers({ Location: `${this.origin}${this.basePath}/oauth/start` }));
    res.end();
  }

  whoKey() {
    return crypto.createHmac('sha256', 'teams-live approve identity').update(this.oauth.clientSecret).digest();
  }

  /** The signed 30-day cookie that remembers who signed in: `<payload>.<mac>`, payload base64url JSON. */
  whoCookie(user) {
    const payload = Buffer.from(JSON.stringify({ id: user.id, u: user.username, n: user.name, e: this.now() + WHO_TTL_MS })).toString('base64url');
    const mac = crypto.createHmac('sha256', this.whoKey()).update(payload).digest('base64url');
    return `${WHO_COOKIE}=${payload}.${mac}; Path=${this.basePath || '/'}; Max-Age=${Math.floor(WHO_TTL_MS / 1000)}; HttpOnly; SameSite=Strict${this.secure ? '; Secure' : ''}`;
  }

  /** The user of a valid remembered sign-in, or null. */
  rememberedUser(req) {
    if (!this.oauth) return null;
    const raw = parseCookies(req.headers.cookie)[WHO_COOKIE];
    const [payload, mac] = typeof raw === 'string' ? raw.split('.') : [];
    if (!payload || !mac) return null;
    const want = crypto.createHmac('sha256', this.whoKey()).update(payload).digest('base64url');
    if (!safeEqual(mac, want)) return null;
    try {
      const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!d?.id || typeof d.u !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(d.u) || !(d.e > this.now())) return null;
      return { id: d.id, username: d.u, name: typeof d.n === 'string' ? d.n : d.u };
    } catch {
      return null;
    }
  }

  oauthRedirectUri() {
    return `${this.origin}${this.basePath}/oauth/callback`;
  }

  /** GET <base>/oauth/start: sends the visitor to GitLab. State and PKCE verifier stay on the server. */
  oauthStart(req, res) {
    const session = this.sessionOf(req);
    if (!session) return this.send(res, 401, this.page('Link not opened', '<p>Open the link from the Teams card again. Nothing was changed.</p>', { tone: 'warn' }));
    const now = this.now();
    for (const [k, v] of this.oauthStates) if (v.exp <= now) this.oauthStates.delete(k);
    while (this.oauthStates.size >= MAX_OAUTH_STATES) this.oauthStates.delete(this.oauthStates.keys().next().value);
    const nonce = crypto.randomBytes(32).toString('base64url');
    const verifier = crypto.randomBytes(48).toString('base64url');
    this.oauthStates.set(nonce, { sid: sha256Hex(session.sid), verifier, exp: now + OAUTH_STATE_TTL_MS });
    const url = new URL(`https://${this.gitlabHost}/oauth/authorize`);
    url.search = new URLSearchParams({
      client_id: this.oauth.clientId,
      redirect_uri: this.oauthRedirectUri(),
      response_type: 'code',
      scope: 'api',
      state: nonce,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    res.writeHead(302, this.headers({ Location: url.href }));
    res.end();
  }

  /**
   * GET <base>/oauth/callback: GitLab sends the visitor back here, a cross-site navigation, so the
   * SameSite=Strict session cookie is NOT sent. The one-time `state` (server side) names the session instead.
   * The answer is a page that continues to /confirm by itself: that navigation starts on this origin, so
   * the cookie is sent again.
   */
  async oauthCallback(req, res) {
    const fail = (text) => this.send(res, 400, this.page('Sign-in failed', `<p>${escapeHtml(text)} Nothing was changed. Use the button on the Teams card to start again.</p>`, { tone: 'warn' }));
    const params = new URL(req.url, 'http://localhost').searchParams;
    const key = params.get('state') || '';
    const state = this.oauthStates.get(key);
    this.oauthStates.delete(key);
    if (!state || state.exp <= this.now()) return fail('The sign-in expired or was not started here.');
    if (state.dash) return this.dashboardCallback(res, params, state);
    const session = this.sessions.get(state.sid);
    const code = params.get('code');
    if (!session || session.expiresAt <= this.now() || !code) return fail(params.get('error') ? 'GitLab did not sign you in.' : 'The sign-in could not be completed.');
    let user, accessToken;
    try {
      ({ user, accessToken } = await this.oauthUser(code, state.verifier));
    } catch (err) {
      log(`GitLab sign-in failed: ${err.message}`);
      return fail('GitLab could not confirm who you are.');
    }
    session.user = user;
    session.accessToken = accessToken;
    this.requestContext.getStore().user = user;
    try { await this.avatarWarm?.([user.name || user.username]); } catch { /* Use initials when the photo is unavailable. */ }
    const next = `${this.basePath}/confirm`;
    return this.send(res, 200, this.page('Signed in', `<meta http-equiv="refresh" content="0;url=${escapeHtml(next)}"><p>Signed in as <code>${escapeHtml(user.username)}</code>.</p><p class="links"><a class="btn" href="${escapeHtml(next)}">Continue</a></p>`, { tone: 'ok' }), { extra: { 'Set-Cookie': this.whoCookie(user) } });
  }

  /** Trades the code for an API token and verifies its owner. The token stays in the server-side session. */
  async oauthUser(code, verifier) {
    const signal = () => AbortSignal.timeout(OAUTH_TIMEOUT_MS);
    const tokenRes = await fetch(`https://${this.gitlabHost}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: this.oauth.clientId, client_secret: this.oauth.clientSecret, code, grant_type: 'authorization_code', redirect_uri: this.oauthRedirectUri(), code_verifier: verifier }).toString(),
      signal: signal(),
    });
    if (!tokenRes.ok) throw new Error(`token endpoint answered HTTP ${tokenRes.status}`);
    const granted = await tokenRes.json();
    const accessToken = granted?.access_token;
    if (typeof accessToken !== 'string' || !accessToken) throw new Error('no access token');
    const expiresIn = Number(granted?.expires_in);
    const userRes = await fetch(`https://${this.gitlabHost}/api/v4/user`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }, signal: signal() });
    if (!userRes.ok) throw new Error(`user endpoint answered HTTP ${userRes.status}`);
    const u = await userRes.json();
    if (!u?.id || typeof u.username !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(u.username)) throw new Error('unusable user');
    return { user: { id: u.id, username: u.username, name: typeof u.name === 'string' ? u.name : u.username }, accessToken, refreshToken: typeof granted?.refresh_token === 'string' ? granted.refresh_token : null, expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null };
  }

  // --- dashboard ---

  dashCookie(value, maxAge) {
    return `${DASH_COOKIE}=${value}; Path=${this.dashPath}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${this.secure ? '; Secure' : ''}`;
  }

  /** The dashboard session of a request: `{sid, user, accessToken}` or null. */
  dashSessionOf(req) {
    const sid = parseCookies(req.headers.cookie)[DASH_COOKIE];
    if (typeof sid !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sid)) return null;
    const s = this.dashSessions.get(sha256Hex(sid));
    if (!s || s.expiresAt <= this.now()) return null;
    return { sid, user: s.user, accessToken: s.accessToken, stored: s };
  }

  /**
   * The session with a usable GitLab token, or null. A token about to expire (or refused by GitLab) is renewed
   * with the refresh token, once at a time per session, and the membership is checked again; when either fails
   * the session ends and the visitor signs in again.
   */
  async freshDashSession(session) {
    if (!session) return null;
    const s = session.stored;
    // Due: refused by GitLab (0) or close to its expiry. A token without a known expiry is used until refused.
    const due = s.tokenExpiresAt === 0 || (s.tokenExpiresAt != null && s.tokenExpiresAt - DASH_TOKEN_MARGIN_MS <= this.now());
    if (!due) return session;
    const key = session.key || sha256Hex(session.sid);
    if (!s.refreshing) {
      s.refreshing = this.renewDashToken(s)
        .catch((err) => {
          log(`Dashboard session of ${s.user.username} ended: ${err.message}`);
          this.dashSessions.delete(key);
          this.dashData.delete(key);
          this.dropPushSubs((sub) => sub.session === key);
          return false;
        })
        .finally(() => {
          s.refreshing = null;
          this.saveDashSessions();
        });
    }
    return (await s.refreshing) === false ? null : { ...session, accessToken: s.accessToken };
  }

  async renewDashToken(s) {
    if (!s.refreshToken) throw new Error('the GitLab token expired and there is no refresh token');
    const res = await fetch(`https://${this.gitlabHost}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: this.oauth.clientId, client_secret: this.oauth.clientSecret, grant_type: 'refresh_token', refresh_token: s.refreshToken, redirect_uri: this.oauthRedirectUri() }).toString(),
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`token refresh answered HTTP ${res.status}`);
    const granted = await res.json();
    if (typeof granted?.access_token !== 'string' || !granted.access_token) throw new Error('token refresh gave no access token');
    const denied = await this.dashboardDenied(s.user, granted.access_token);
    if (denied) throw new Error(denied);
    s.accessToken = granted.access_token;
    if (typeof granted.refresh_token === 'string' && granted.refresh_token) s.refreshToken = granted.refresh_token;
    const expiresIn = Number(granted.expires_in);
    s.tokenExpiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? this.now() + expiresIn * 1000 : null;
    return true;
  }

  dashSessionKey() {
    return crypto.createHmac('sha256', 'teams-live dashboard sessions').update(this.oauth.clientSecret).digest();
  }

  /** Reads the saved dashboard sessions; anything unreadable (another key, a damaged file) just starts empty. */
  loadDashSessions() {
    if (!this.dashSessionFile || !this.oauth) return;
    try {
      const box = JSON.parse(fs.readFileSync(this.dashSessionFile, 'utf8'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.dashSessionKey(), Buffer.from(box.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
      const entries = JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8'));
      const now = this.now();
      for (const [key, s] of entries) {
        if (typeof key === 'string' && /^[0-9a-f]{64}$/.test(key) && s?.user?.username && s.expiresAt > now) this.dashSessions.set(key, s);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') log(`Saved dashboard sessions not used: ${err.message}`);
    }
  }

  /** Writes the dashboard sessions (encrypted, mode 0600, replaced atomically). Best effort. */
  saveDashSessions() {
    if (!this.dashSessionFile || !this.oauth) return;
    try {
      const now = this.now();
      const entries = [...this.dashSessions].filter(([, s]) => s.expiresAt > now).map(([k, s]) => [k, { user: s.user, accessToken: s.accessToken, refreshToken: s.refreshToken || null, tokenExpiresAt: s.tokenExpiresAt ?? null, expiresAt: s.expiresAt }]);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', this.dashSessionKey(), iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(entries), 'utf8'), cipher.final()]);
      const tmp = `${this.dashSessionFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
      fs.renameSync(tmp, this.dashSessionFile);
    } catch (err) {
      log(`Could not save the dashboard sessions: ${err.message}`);
    }
  }

  // --- push notifications ---

  pushKey() {
    return crypto.createHmac('sha256', 'teams-live dashboard push').update(this.oauth.clientSecret).digest();
  }

  /** Reads the VAPID keys and subscriptions; without a readable file (first start, another key) new keys are made. */
  loadPush() {
    if (!this.pushFile) return;
    try {
      const box = JSON.parse(fs.readFileSync(this.pushFile, 'utf8'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.pushKey(), Buffer.from(box.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
      const state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8'));
      if (validVapidKeys(state.vapid)) this.vapid = { publicKey: state.vapid.publicKey, privateKey: state.vapid.privateKey };
      for (const sub of Array.isArray(state.subs) && this.vapid ? state.subs : []) {
        const parsed = parseSubscription(sub);
        if (parsed && typeof sub.session === 'string' && this.dashSessions.has(sub.session)) {
          this.pushSubs.set(parsed.endpoint, { ...parsed, session: sub.session, username: String(sub.username || ''), settings: normalizeNotifySettings(sub.settings), seen: sub.seen && typeof sub.seen === 'object' ? sub.seen : null, fired: sub.fired && typeof sub.fired === 'object' ? sub.fired : {} });
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') log(`Saved push subscriptions not used: ${err.message}`);
    }
    if (!this.vapid) {
      this.vapid = generateVapidKeys();
      this.pushSubs.clear();
      this.savePush();
    }
  }

  /** Writes the keys and subscriptions (encrypted, mode 0600, replaced atomically). Best effort. */
  savePush() {
    if (!this.pushFile || !this.vapid) return;
    try {
      const subs = [...this.pushSubs.values()].map((s) => ({ endpoint: s.endpoint, keys: s.keys, session: s.session, username: s.username, settings: s.settings, seen: s.seen, fired: s.fired }));
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', this.pushKey(), iv);
      const data = Buffer.concat([cipher.update(JSON.stringify({ vapid: this.vapid, subs }), 'utf8'), cipher.final()]);
      const tmp = `${this.pushFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
      fs.renameSync(tmp, this.pushFile);
    } catch (err) {
      log(`Could not save the push subscriptions: ${err.message}`);
    }
  }

  dropPushSubs(match) {
    let changed = false;
    for (const [endpoint, sub] of this.pushSubs) {
      if (match(sub)) {
        this.pushSubs.delete(endpoint);
        changed = true;
      }
    }
    if (changed) this.savePush();
  }

  /** Who signs the push messages: the dashboard's https origin, or a placeholder address on a plain-http test setup. */
  pushSubject() {
    return this.origin.startsWith('https:') ? this.origin : 'mailto:teams-live@localhost';
  }

  /**
   * POST <dash>/push: saves (action=save) or forgets (action=remove) this browser's push subscription with its
   * notification settings. Same checks as the other writes: Origin and CSRF. Answers `{status: ok|failed}`.
   */
  async dashboardPush(req, res, session) {
    const answer = (status, code = 200) => this.json(res, code, { status });
    if (!this.vapid) return answer('failed', 404);
    if (!this.originAllowed(req)) return answer('failed', 403);
    const parsed = await this.postForm(req);
    if (!parsed.form) return answer('failed', parsed.status);
    if (!this.csrf.verify(parsed.form.get('csrf'), session.sid, 'dashboard', `who=${session.user.username}`)) return answer('failed', 403);
    const sub = parseSubscription(parsed.form.get('sub'));
    if (!sub) return answer('failed', 400);
    const key = sha256Hex(session.sid);
    const known = this.pushSubs.get(sub.endpoint);
    if (parsed.form.get('action') === 'remove') {
      if (known && known.username === session.user.username) {
        this.pushSubs.delete(sub.endpoint);
        this.savePush();
      }
      return answer('ok');
    }
    if (!known) {
      const mine = [...this.pushSubs.values()].filter((s) => s.username === session.user.username);
      if (mine.length >= MAX_PUSH_SUBS_PER_USER) this.pushSubs.delete(mine[0].endpoint);
      if (this.pushSubs.size >= MAX_PUSH_SUBS) return answer('failed', 429);
    }
    let settings;
    try {
      settings = normalizeNotifySettings(JSON.parse(parsed.form.get('settings') || '{}'));
    } catch {
      return answer('failed', 400);
    }
    // The same browser under another session or person starts over: nothing it saw before counts.
    const same = known && known.session === key && known.username === session.user.username;
    this.pushSubs.set(sub.endpoint, { ...sub, session: key, username: session.user.username, settings, seen: same ? known.seen : null, fired: same ? known.fired : {} });
    this.savePush();
    return answer('ok');
  }

  /**
   * One push round: for each session with subscribed browsers, read what its dashboard would show, and send each
   * browser the events it has not seen and asked for. The first round of a new subscription only records what is
   * there. Events that disappear (a source failing for a while) are remembered for a week, so they do not return.
   */
  async pushTick() {
    if (!this.vapid || !this.pushSubs.size || this.pushBusy) return;
    this.pushBusy = true;
    try {
      const sessions = new Map();
      for (const sub of this.pushSubs.values()) sessions.set(sub.session, [...(sessions.get(sub.session) || []), sub]);
      for (const [key, subs] of sessions) {
        const stored = this.dashSessions.get(key);
        const session = stored && stored.expiresAt > this.now() ? await this.freshDashSession({ sid: null, key, user: stored.user, accessToken: stored.accessToken, stored }) : null;
        if (!session) {
          this.dropPushSubs((sub) => sub.session === key);
          continue;
        }
        const data = await this.dashboardData(session);
        const events = notifyEvents(data, { username: session.user.username, name: session.user.name, now: this.now(), timeZone: this.dashboard.timeZone });
        for (const sub of subs) await this.pushTo(sub, events);
      }
      this.savePush();
    } finally {
      this.pushBusy = false;
    }
  }

  async pushTo(sub, events) {
    const now = this.now();
    const first = sub.seen === null;
    const seen = sub.seen || {};
    const out = [];
    for (const ev of events) {
      if (ev.k === 'meeting') {
        if (sub.fired[ev.id] || now < ev.at - sub.settings.lead * 60_000 || now >= ev.at) continue;
        sub.fired[ev.id] = ev.at;
        if (!first && wantsEvent(ev, sub.settings)) out.push({ ...ev, b: `In ${Math.max(1, Math.round((ev.at - now) / 60_000))} min · ${ev.b}` });
        continue;
      }
      if (!seen[ev.id] && !first && wantsEvent(ev, sub.settings)) out.push(ev);
      seen[ev.id] = now;
    }
    for (const id of Object.keys(seen)) if (now - seen[id] > PUSH_SEEN_TTL_MS) delete seen[id];
    for (const id of Object.keys(sub.fired)) if (sub.fired[id] < now - 86_400_000) delete sub.fired[id];
    sub.seen = seen;
    const messages = out.length > PUSH_BURST
      ? [{ id: 'tl-many', t: `${out.length} new events on the dashboard`, b: `${out.slice(0, 3).map((e) => e.t).join('\n')}\n…`, v: 'overview' }]
      : out;
    for (const ev of messages) {
      const payload = { id: ev.id, t: String(ev.t).slice(0, 200), b: String(ev.b || '').slice(0, 300), v: ev.v, o: ev.o || null };
      const urgent = ev.k === 'alert' && ev.p <= 2;
      const ttl = ev.k === 'meeting' ? Math.max(60, Math.round((ev.at - now) / 1000)) : 6 * 3600;
      try {
        const r = await sendPush(sub, payload, { keys: this.vapid, subject: this.pushSubject(), ttl, urgency: urgent ? 'high' : 'normal', topic: crypto.createHash('sha256').update(ev.id).digest('base64url').slice(0, 32), now });
        if (r.gone) {
          log(`Push subscription of ${sub.username} is gone (HTTP ${r.status}); forgotten`);
          this.pushSubs.delete(sub.endpoint);
          return;
        }
        if (!r.ok) log(`Push to ${sub.username} answered HTTP ${r.status}`);
      } catch (err) {
        log(`Push to ${sub.username} failed: ${err.message}`);
      }
    }
  }

  /** Why this signed-in user may not see the dashboard, or '': group membership and the optional allow-list. */
  async dashboardDenied(user, accessToken) {
    const name = String(user.username).toLowerCase();
    if (this.oauth.allowedUsers.size > 0 && !this.oauth.allowedUsers.has(name)) return `The GitLab user ${user.username} is not allowed to use this dashboard.`;
    if (!(await isGroupMember(this.gitlabHost, accessToken, this.dashboard.group, user.id))) return `The GitLab user ${user.username} is not a member of the GitLab group this dashboard is for.`;
    return '';
  }

  async handleDashboard(route, req, res) {
    const method = req.method;
    const notAllowed = (allow) => this.send(res, 405, this.page('Not allowed', '<p>Method not allowed.</p>', { tone: 'warn' }), { extra: { Allow: allow } });
    if (!this.dashboard) return this.send(res, 404, this.page('Not found', '<p>Nothing here.</p>', { tone: 'warn' }), { head: method === 'HEAD' });
    if (route === '/dashboard/signin') {
      if (method !== 'GET') return notAllowed('GET');
      return this.dashboardSignIn(res);
    }
    // The installable app's files: no data in them, so no session needed (the browser fetches them on its own).
    if (route === '/dashboard/sw.js' || route === '/dashboard/manifest.webmanifest' || route === '/dashboard/icon-192.png' || route === '/dashboard/icon-512.png') {
      if (method !== 'GET' && method !== 'HEAD') return notAllowed('GET, HEAD');
      const file = route.slice('/dashboard/'.length);
      const [type, body, extra] =
        file === 'sw.js'
          ? ['text/javascript; charset=utf-8', this.dashboardWorker, { 'Service-Worker-Allowed': this.dashPath, 'Cache-Control': 'no-cache' }]
          : file === 'manifest.webmanifest'
            ? ['application/manifest+json', JSON.stringify(webManifest(this.dashPath)), { 'Cache-Control': 'no-cache' }]
            : ['image/png', Buffer.from(file === 'icon-192.png' ? ICON_192 : ICON_512, 'base64'), { 'Cache-Control': 'public, max-age=86400' }];
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'X-Content-Type-Options': 'nosniff', ...extra });
      return res.end(method === 'HEAD' ? undefined : body);
    }
    const session = await this.freshDashSession(this.dashSessionOf(req));
    if (session) this.requestContext.getStore().user = session.user;
    if (route === '/dashboard') {
      if (method !== 'GET' && method !== 'HEAD') return notAllowed('GET, HEAD');
      if (method === 'HEAD') return this.send(res, 200, '', { head: true });
      if (!session) return this.dashboardGate(res);
      return this.showDashboard(res, session);
    }
    if (route === '/dashboard/data') {
      if (method !== 'GET') return notAllowed('GET');
      if (!session) return this.json(res, 401, {});
      try {
        return this.json(res, 200, await this.dashboardPayload(session), { 'X-TL-Offline': '1' });
      } catch {
        return this.json(res, 502, {});
      }
    }
    if (route === '/dashboard/issue' || route === '/dashboard/alert' || route === '/dashboard/mr') {
      if (method !== 'GET') return notAllowed('GET');
      if (!session) return this.json(res, 401, {});
      return this.dashboardDetail(route.slice('/dashboard/'.length), req, res, session);
    }
    if (route === '/dashboard/move') {
      if (method !== 'POST') return notAllowed('POST');
      if (!session) return this.json(res, 401, { status: 'failed', text: 'Signed out. Reload the page and sign in again. Nothing was changed.' });
      return this.dashboardMove(req, res, session);
    }
    if (route === '/dashboard/push') {
      if (method !== 'POST') return notAllowed('POST');
      if (!session) return this.json(res, 401, { status: 'failed' });
      return this.dashboardPush(req, res, session);
    }
    if (route === '/dashboard/approve') {
      if (method !== 'POST') return notAllowed('POST');
      if (!session) return this.json(res, 401, { status: 'failed', text: 'Signed out. Reload the page and sign in again. Nothing was approved.' });
      return this.dashboardApprove(req, res, session);
    }
    if (route === '/dashboard/signout') {
      if (method !== 'POST') return notAllowed('POST');
      if (!this.originAllowed(req)) return this.send(res, 403, this.page('Not allowed', '<p>Nothing was changed.</p>', { tone: 'warn' }));
      const parsed = await this.postForm(req);
      if (session && parsed.form && this.csrf.verify(parsed.form.get('csrf'), session.sid, 'dashboard', `who=${session.user.username}`)) {
        this.dashSessions.delete(sha256Hex(session.sid));
        this.dashData.delete(sha256Hex(session.sid));
        this.saveDashSessions();
        this.dropPushSubs((sub) => sub.session === sha256Hex(session.sid));
      }
      this.requestContext.getStore().user = null;
      const forget = `${WHO_COOKIE}=; Path=${this.basePath || '/'}; Max-Age=0; HttpOnly; SameSite=Strict${this.secure ? '; Secure' : ''}`;
      res.writeHead(303, this.headers({ Location: this.dashPath, 'Set-Cookie': [this.dashCookie('', 0), forget] }));
      return res.end();
    }
    return this.send(res, 404, this.page('Not found', '<p>Nothing here.</p>', { tone: 'warn' }));
  }

  /** Signed out: what the dashboard is and one button to sign in with GitLab. */
  dashboardGate(res) {
    const body =
      '<p>Your merge requests, the active sprint, open alerts with who is on call, and your next meetings in one place.</p>' +
      `<p class="links"><a class="btn" href="${escapeHtml(`${this.dashPath}/signin`)}">Sign in with GitLab</a></p>`;
    return this.send(res, 200, this.page('Dashboard', body, { kind: 'dashboard' }));
  }

  /** Starts a GitLab sign-in for the dashboard (no capability link needed: membership decides). */
  dashboardSignIn(res) {
    const now = this.now();
    for (const [k, v] of this.oauthStates) if (v.exp <= now) this.oauthStates.delete(k);
    while (this.oauthStates.size >= MAX_OAUTH_STATES) this.oauthStates.delete(this.oauthStates.keys().next().value);
    const nonce = crypto.randomBytes(32).toString('base64url');
    const verifier = crypto.randomBytes(48).toString('base64url');
    this.oauthStates.set(nonce, { dash: true, verifier, exp: now + OAUTH_STATE_TTL_MS });
    const url = new URL(`https://${this.gitlabHost}/oauth/authorize`);
    url.search = new URLSearchParams({
      client_id: this.oauth.clientId,
      redirect_uri: this.oauthRedirectUri(),
      response_type: 'code',
      scope: 'api',
      state: nonce,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    res.writeHead(302, this.headers({ Location: url.href }));
    res.end();
  }

  /** The OAuth answer for a dashboard sign-in: check who it is and whether they may see it, then open a session. */
  async dashboardCallback(res, params, state) {
    const fail = (status, text) => this.send(res, status, this.page('Sign-in failed', `<p>${escapeHtml(text)}</p><p class="links"><a class="btn btn-secondary" href="${escapeHtml(this.dashPath)}">Back to the dashboard</a></p>`, { tone: 'warn', kind: 'generic' }));
    if (!this.dashboard) return fail(404, 'The dashboard is switched off.');
    const code = params.get('code');
    if (!code) return fail(400, params.get('error') ? 'GitLab did not sign you in.' : 'The sign-in could not be completed.');
    let user, accessToken, refreshToken, expiresIn;
    try {
      ({ user, accessToken, refreshToken, expiresIn } = await this.oauthUser(code, state.verifier));
    } catch (err) {
      log(`Dashboard sign-in failed: ${err.message}`);
      return fail(400, 'GitLab could not confirm who you are.');
    }
    const denied = await this.dashboardDenied(user, accessToken);
    if (denied) {
      log(`Dashboard sign-in refused for ${user.username}`);
      return fail(403, denied);
    }
    const now = this.now();
    for (const [h, s] of this.dashSessions) if (s.expiresAt <= now) this.dashSessions.delete(h);
    while (this.dashSessions.size >= MAX_DASH_SESSIONS) this.dashSessions.delete(this.dashSessions.keys().next().value);
    const sid = crypto.randomBytes(32).toString('base64url');
    // Without a refresh token the session cannot outlive the access token (a minute early).
    const ttl = refreshToken ? DASH_SESSION_TTL_MS : Math.max(60_000, Math.min(DASH_SESSION_TTL_MS, expiresIn ? expiresIn * 1000 - 60_000 : DASH_SESSION_TTL_MS));
    const key = sha256Hex(sid);
    this.dashSessions.set(key, { user, accessToken, refreshToken, tokenExpiresAt: expiresIn ? now + expiresIn * 1000 : null, expiresAt: now + ttl });
    this.saveDashSessions();
    this.requestContext.getStore().user = user;
    try { await this.avatarWarm?.([user.name || user.username]); } catch { /* Use initials when the photo is unavailable. */ }
    const next = this.dashPath;
    return this.send(res, 200, this.page('Signed in', `<meta http-equiv="refresh" content="0;url=${escapeHtml(next)}"><p>Signed in as <code>${escapeHtml(user.username)}</code>.</p><p class="links"><a class="btn" href="${escapeHtml(next)}">Open the dashboard</a></p>`, { tone: 'ok', kind: 'generic' }), {
      extra: { 'Set-Cookie': [this.dashCookie(sid, Math.floor(ttl / 1000)), this.whoCookie(user)] },
    });
  }

  /** One source the bot reads (sprint, alerts, meetings), shared by every visitor for a minute. */
  dashSource(name) {
    const fn = this.dashboard.sources?.[name];
    if (typeof fn !== 'function') return Promise.resolve({ error: `${DASH_SOURCES[name]} is not configured.` });
    const now = this.now();
    const hit = this.dashSourceCache.get(name);
    if (hit && now - hit.at < DASH_SOURCE_CACHE_MS) return hit.promise;
    const promise = Promise.resolve()
      .then(fn)
      .then((data) => ({ data }))
      .catch((err) => {
        log(`Dashboard could not read ${name}: ${err.message}`);
        if (this.dashSourceCache.get(name) === entry) this.dashSourceCache.set(name, { ...entry, at: now - DASH_SOURCE_CACHE_MS + 10_000 });
        return hit?.ok ? hit.promise : { error: `Could not read ${DASH_SOURCES[name]} right now.` };
      });
    const entry = { at: now, promise, ok: false };
    promise.then((r) => { if (r.data !== undefined) entry.ok = true; });
    this.dashSourceCache.set(name, entry);
    return promise;
  }

  /**
   * POST <dash>/move: moves one ticket of the active sprint to another board column (a Jira transition, made with
   * the bot's Jira account; the server log names who asked). Same checks as an approval: Origin, CSRF, the ticket
   * must be on this visitor's board. Answers `{status: moved|failed, text}`.
   */
  async dashboardMove(req, res, session) {
    const answer = (status, text, code = 200) => this.json(res, code, { status, text });
    if (!this.originAllowed(req)) return answer('failed', 'The request did not come from the dashboard. Nothing was changed.', 403);
    const parsed = await this.postForm(req);
    if (!parsed.form) return answer('failed', 'The request was rejected. Nothing was changed.', parsed.status);
    if (!this.csrf.verify(parsed.form.get('csrf'), session.sid, 'dashboard', `who=${session.user.username}`)) return answer('failed', 'The page expired. Reload it and try again. Nothing was changed.', 403);
    const key = String(parsed.form.get('key') || '').toUpperCase();
    const column = String(parsed.form.get('to') || '');
    const labels = { todo: 'To do', inProgress: 'In progress', inReview: 'In review' };
    if (!/^[A-Z][A-Z0-9]{0,15}-[1-9]\d{0,8}$/.test(key) || !labels[column]) return answer('failed', 'The request was rejected. Nothing was changed.', 400);
    const data = await this.dashboardData(session);
    const onBoard = ['todo', 'inProgress', 'inReview'].some((k) => (data.sprint.data?.[k] || []).some((t) => String(t.key).toUpperCase() === key));
    if (!onBoard) return answer('failed', `${key} is not on the sprint board. Nothing was changed.`, 404);
    const fn = this.dashboard.sources?.move;
    if (typeof fn !== 'function') return answer('failed', 'Moving tickets is not available. Nothing was changed.', 404);
    try {
      const status = await this.withLock(`jira:${key}`, () => fn(key, column));
      log(`Dashboard: ${session.user.username} moved ${key} to ${status || labels[column]}`);
      this.dashSourceCache.delete('sprint');
      this.dashData.clear();
      return answer('moved', `${key} moved to ${status || labels[column]}.`);
    } catch (err) {
      log(`Dashboard: moving ${key} for ${session.user.username} failed: ${err.message}`);
      return answer('failed', err.userFacing ? `${key}: ${err.message} Nothing was changed.` : `Jira did not move ${key}. Reload the board to see its current state.`);
    }
  }

  /** The Jira tickets a merge request names (branch, title), as keys; [] without Jira. */
  mrIssueKeys(mr) {
    const fn = this.dashboard.sources?.issueKeys;
    if (typeof fn !== 'function') return [];
    try {
      return (fn(mr) || []).filter((k) => /^[A-Z][A-Z0-9]{0,15}-[1-9]\d{0,8}$/.test(k)).slice(0, 3);
    } catch {
      return [];
    }
  }

  /**
   * GET <dash>/issue?key=… and <dash>/alert?id=…: the details of a ticket or an alert for the preview drawer, read
   * by the bot. Only what this visitor's dashboard shows right now (a sprint ticket, a ticket named by a listed merge
   * request, an open alert), so the endpoint is no general Jira or OpsGenie reader. Answers `{title, html}`.
   */
  async dashboardDetail(kind, req, res, session) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const data = await this.dashboardData(session);
    let id;
    let allowed;
    if (kind === 'mr') return this.dashboardMrDetail(String(params.get('ref') || ''), res, session, data);
    if (kind === 'issue') {
      id = String(params.get('key') || '').toUpperCase();
      const keys = new Set();
      for (const k of ['todo', 'inProgress', 'inReview']) for (const t of data.sprint.data?.[k] || []) keys.add(String(t.key).toUpperCase());
      for (const mr of data.mrs.items || []) for (const k of mr.issues || []) keys.add(k);
      allowed = /^[A-Z][A-Z0-9]{0,15}-[1-9]\d{0,8}$/.test(id) && keys.has(id);
    } else {
      id = String(params.get('id') || '');
      allowed = /^[A-Za-z0-9-]{1,80}$/.test(id) && (data.alerts.data?.alerts || []).some((a) => a.id === id);
    }
    if (!allowed) return this.json(res, 404, {});
    const fn = this.dashboard.sources?.[kind];
    if (typeof fn !== 'function') return this.json(res, 404, {});
    const cacheKey = `${kind}:${id}`;
    const now = this.now();
    let hit = this.dashSourceCache.get(cacheKey);
    if (!hit || now - hit.at > DASH_SOURCE_CACHE_MS) {
      hit = { at: now, promise: Promise.resolve().then(() => fn(id)) };
      this.dashSourceCache.set(cacheKey, hit);
      hit.promise.catch(() => { if (this.dashSourceCache.get(cacheKey) === hit) this.dashSourceCache.delete(cacheKey); });
      for (const [k, v] of this.dashSourceCache) if (k.includes(':') && now - v.at > DASH_SOURCE_CACHE_MS) this.dashSourceCache.delete(k);
    }
    try {
      const item = await hit.promise;
      const names = kind === 'issue' ? [item.assignee, item.reporter].filter(Boolean) : [];
      if (names.length && this.avatarWarm) { try { await this.avatarWarm(names); } catch { /* initials */ } }
      const avatars = {};
      for (const n of names) { try { const u = this.avatarOf?.(n); if (u) avatars[n] = u; } catch { /* initials */ } }
      const ctx = { now: this.now(), timeZone: this.dashboard.timeZone, avatars };
      return this.json(res, 200, kind === 'issue' ? issueDetail(item, ctx) : alertDetail(item, ctx));
    } catch (err) {
      log(`Dashboard could not read ${kind} ${id}: ${err.message}`);
      return this.json(res, 502, {});
    }
  }

  /** The detail panel of a merge request the visitor's dashboard lists, read with the visitor's own token. */
  async dashboardMrDetail(ref, res, session, data) {
    const listed = (data.mrs.items || []).find((mr) => `${mr.project}!${mr.iid}` === ref);
    if (!listed) return this.json(res, 404, {});
    const key = `mr:${sha256Hex(session.sid)}:${ref}`;
    const now = this.now();
    let hit = this.dashSourceCache.get(key);
    if (!hit || now - hit.at > 30_000) {
      hit = { at: now, promise: fetchMrDetail(this.gitlabHost, session.accessToken, listed.project, listed.iid) };
      this.dashSourceCache.set(key, hit);
      hit.promise.catch(() => { if (this.dashSourceCache.get(key) === hit) this.dashSourceCache.delete(key); });
    }
    try {
      const detail = await hit.promise;
      const names = [detail.mr.author, ...(detail.mr.reviewers || [])].filter(Boolean).map((u) => u.name || u.username);
      if (names.length && this.avatarWarm) { try { await this.avatarWarm(names); } catch { /* initials */ } }
      const avatars = {};
      for (const n of names) { try { const u = this.avatarOf?.(n); if (u) avatars[n] = u; } catch { /* initials */ } }
      const ctx = { now: this.now(), timeZone: this.dashboard.timeZone, avatars, host: this.gitlabHost };
      return this.json(res, 200, mrDetail(detail, ctx, approveButton(listed, session.user.username)));
    } catch (err) {
      log(`Dashboard could not read ${ref} for ${session.user.username}: ${err.message}`);
      return this.json(res, 502, {});
    }
  }

  /** Everything the dashboard shows, for one visitor (their merge requests are read with their token). */
  dashboardData(session) {
    const key = session.key || sha256Hex(session.sid);
    const now = this.now();
    const hit = this.dashData.get(key);
    if (hit && now - hit.at < DASH_DATA_CACHE_MS) return hit.promise;
    const promise = (async () => {
      const [mrs, sprint, alerts, meetings] = await Promise.all([
        fetchGroupMrs(this.gitlabHost, session.accessToken, this.dashboard.group)
          .then((items) => ({ items: items.map((mr) => ({ ...mr, issues: this.mrIssueKeys(mr) })) }))
          .catch((err) => {
            log(`Dashboard could not list merge requests for ${session.user.username}: ${err.message}`);
            if (err.status === 401 && session.stored) session.stored.tokenExpiresAt = 0;
            return { error: err.status === 401 ? 'GitLab ended the sign-in. Reload the page to sign in again.' : 'Could not read the merge requests from GitLab right now.' };
          }),
        this.dashSource('sprint'),
        this.dashSource('alerts'),
        this.dashSource('meetings'),
      ]);
      return { at: this.now(), mrs, sprint, alerts, meetings };
    })();
    const entry = { at: now, promise };
    this.dashData.set(key, entry);
    promise.catch(() => { if (this.dashData.get(key) === entry) this.dashData.delete(key); });
    return promise;
  }

  /**
   * The drawing context: who looks, their pictures, the time zone of the meetings. Pictures not cached yet are
   * loaded first, bounded by the picture service's own deadline (1.5 s), so a cold cache after a restart does not
   * show initials everywhere until the next refresh.
   */
  async dashboardCtx(session, data) {
    const names = new Set();
    for (const mr of data.mrs.items || []) names.add(mr.author.name);
    for (const k of ['todo', 'inProgress', 'inReview']) for (const t of data.sprint.data?.[k] || []) if (t.assignee) names.add(t.assignee);
    if (this.avatarWarm && names.size) {
      try { await this.avatarWarm([...names].slice(0, 80)); } catch { /* initials */ }
    }
    const avatars = {};
    for (const name of names) {
      try {
        const uri = this.avatarOf?.(name);
        if (uri) avatars[name] = uri;
      } catch { /* initials */ }
    }
    // On-duty responders: OpsGenie knows their address, not their Teams name (which may be spelled differently).
    const duty = (data.alerts.data?.duty || []).flatMap((d) => (Array.isArray(d.people) ? d.people : [])).filter((p) => p?.name);
    if (duty.length && this.avatarWarm) {
      try { await this.avatarWarm(duty.map((p) => (p.email ? { name: p.name, email: p.email } : p.name))); } catch { /* initials */ }
    }
    for (const p of duty) {
      try {
        const uri = (this.avatarPeek && this.avatarPeek(p.email ? { name: p.name, email: p.email } : p.name)) || null;
        if (uri) avatars[p.name] = uri;
      } catch { /* initials */ }
    }
    return { username: session.user.username, name: session.user.name, host: this.gitlabHost, avatars, now: this.now(), timeZone: this.dashboard.timeZone };
  }

  dashboardUpdated(at) {
    return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: this.dashboard.timeZone });
  }

  async dashboardPayload(session) {
    const data = await this.dashboardData(session);
    const ctx = await this.dashboardCtx(session, data);
    return { sections: renderSections(data, ctx), counts: navCounts(data, ctx), events: notifyEvents(data, ctx), csrf: this.csrf.issue(session.sid, 'dashboard', `who=${session.user.username}`), updated: this.dashboardUpdated(data.at) };
  }

  async showDashboard(res, session) {
    const data = await this.dashboardData(session);
    const ctx = await this.dashboardCtx(session, data);
    const csrf = this.csrf.issue(session.sid, 'dashboard', `who=${session.user.username}`);
    const body = dashboardBody({ data, ctx, csrf, filter: defaultFilter(data.mrs.items || [], session.user.username), updated: this.dashboardUpdated(data.at), pushKey: this.vapid?.publicKey || '' });
    const html = this.documentHtml({ title: 'Dashboard', kicker: 'Dashboard', shell: 'shell dashboard', main: `<main>${body}<script>${this.dashboardScript}</script></main>`, css: DASHBOARD_CSS, dashLink: false, actions: CUSTOMIZE_BUTTON, footer: false, head: `<link rel="manifest" href="${escapeHtml(`${this.dashPath}/manifest.webmanifest`)}"><meta name="theme-color" content="#1f1e24"><link rel="apple-touch-icon" href="${escapeHtml(`${this.dashPath}/icon-192.png`)}">`, menu: `<div class="menu-sep"></div><div class="menu-theme"><span>${MENU_ICONS.theme}Theme</span><span class="theme-seg" role="group" aria-label="Theme">${['auto', 'light', 'dark'].map((t) => `<button type="button" data-theme-set="${t}" aria-pressed="${(this.requestContext.getStore()?.theme || 'auto') === t}" title="${t === 'auto' ? 'Follow the system' : `${t[0].toUpperCase()}${t.slice(1)}`}">${MENU_ICONS[t]}${t[0].toUpperCase()}${t.slice(1)}</button>`).join('')}</span></div><div class="menu-sep"></div><form method="post" action="${escapeHtml(`${this.origin}${this.dashPath}/signout`)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}" data-csrf><button class="menu-item" type="submit">${MENU_ICONS.signout}Sign out</button></form>` });
    return this.send(res, 200, html, { script: 'dashboard', extra: { 'X-TL-Offline': '1' } });
  }

  /**
   * POST <base>/dashboard/approve: ONE approval of one merge request at the head the dashboard showed, as the
   * signed-in user. The same checks as the approval page (identity, head, draft, author, GitLab's own rules);
   * never repeated. Answers JSON `{status: approved|already|failed|unknown, text}`.
   */
  async dashboardApprove(req, res, session) {
    const answer = (status, text, code = 200) => this.json(res, code, { status, text });
    if (!this.originAllowed(req)) return answer('failed', 'The request did not come from the dashboard. Nothing was approved.', 403);
    const parsed = await this.postForm(req);
    if (!parsed.form) return answer('failed', 'The request was rejected. Nothing was approved.', parsed.status);
    if (!this.csrf.verify(parsed.form.get('csrf'), session.sid, 'dashboard', `who=${session.user.username}`)) return answer('failed', 'The page expired. Reload it and try again. Nothing was approved.', 403);
    const project = String(parsed.form.get('project') || '');
    const iid = String(parsed.form.get('iid') || '');
    const sha = String(parsed.form.get('sha') || '');
    if (!/^[A-Za-z0-9_.\/-]{1,255}$/.test(project) || !/^[1-9]\d{0,9}$/.test(iid) || !/^[0-9a-f]{40,64}$/i.test(sha)) return answer('failed', 'The request was rejected. Nothing was approved.', 400);
    const group = this.dashboard.group.toLowerCase();
    if (!project.toLowerCase().startsWith(`${group}/`)) return answer('failed', 'This merge request is not in the dashboard’s group. Nothing was approved.', 403);
    const ref = `${project}!${iid}`;
    try {
      const outcome = await this.withLock(keyOf(project, iid), async () => {
        const item = { project, iid: Number(iid), sha };
        const checked = await userApprovalPreflight(this.gitlabHost, { ...item, status: 'open' }, session);
        if (checked.status === 'already') return ['already', `You had already approved ${ref}.`];
        if (checked.status !== 'ready') return ['failed', `${ref}: ${checked.reason || 'cannot be approved.'} Nothing was approved.`];
        const denied = this.signInDenied(session.user, checked.mr, 'approve');
        if (denied) return ['failed', `${denied} Nothing was approved.`];
        this.store.forgetApproved(project, item.iid, sha);
        const link = this.store.linkFor({ ...item, action: 'approve' });
        if (!link) return ['failed', 'The approval could not be prepared. Nothing was approved.'];
        const sent = await this.sendUserApproval(link.record, checked, session, { deferRefresh: true });
        if (sent.code === 200) return ['approved', `Approved ${ref} as ${session.user.username}.`];
        if (sent.title === 'Outcome unknown') return ['unknown', `GitLab did not confirm the approval of ${ref}. Check it in GitLab before retrying.`];
        return ['failed', `GitLab rejected the approval of ${ref}. Nothing was approved.`];
      });
      this.dashData.delete(sha256Hex(session.sid));
      return answer(outcome[0], outcome[1]);
    } catch {
      return answer('unknown', `The outcome for ${ref} is unknown. Check it in GitLab before retrying.`);
    }
  }

  usedPage(record) {
    const text = { reopen: 'reopen the merge request', merge: 'merge the merge request', rebase: 'rebase the merge request' }[record.action] || 'approve the merge request';
    return { code: 410, title: 'Link already used', body: `${this.summary(record, null, null)}<p>This link was already used to ${text}. Nothing more was sent.</p>` };
  }

  /** Short-lived, coalesced read for the confirmation page (never used to approve). */
  evaluateCached(record) {
    // The off switch is never served from the cache.
    if (record.action === 'merge' && !this.mergeEnabled) return this.evaluate(record);
    const now = this.now();
    for (const [id, c] of this.readCache) {
      if (now - c.at > READ_CACHE_MS || !this.store.records.has(id)) this.readCache.delete(id);
    }
    const hit = this.readCache.get(record.id);
    if (hit && hit.status === record.status) return hit.promise;
    const promise = this.evaluate(record);
    const entry = { at: now, status: record.status, promise };
    this.readCache.set(record.id, entry);
    promise.catch(() => {
      if (this.readCache.get(record.id) === entry) this.readCache.delete(record.id);
    });
    return promise;
  }

  /** The people a page shows: the merge request's author and the approvers. */
  peopleOf(mr, approvals) {
    const names = [mr?.author?.name || mr?.author?.username, ...(Array.isArray(approvals?.approvedBy) ? approvals.approvedBy : [])];
    return [...new Set(names.filter((n) => typeof n === 'string' && n.trim()))];
  }

  /** Pictures already known for those people (never starts a request); the page falls back to initials. */
  avatarsFor(mr, approvals) {
    const out = {};
    if (!this.avatarOf) return out;
    for (const name of this.peopleOf(mr, approvals)) {
      try {
        const uri = this.avatarOf(name);
        if (uri) out[name] = uri;
      } catch {
        // a picture is a nicety
      }
    }
    return out;
  }

  /** Loads the photos of those people (bounded by the picture service), before a page is drawn. */
  async warmAvatars(mr, approvals) {
    if (!this.avatarWarm) return;
    try {
      await this.avatarWarm(this.peopleOf(mr, approvals));
    } catch {
      // a picture is a nicety
    }
  }

  /** A JSON answer with the same hardening headers as the pages. */
  json(res, status, data, extra = {}) {
    const body = JSON.stringify(data);
    res.writeHead(status, this.headers({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extra }));
    res.end(body);
  }

  /**
   * What an open page shows live: its changing pieces as escaped HTML and whether the action is still
   * possible. One read per merge request every few seconds however many tabs are open.
   */
  liveSnapshot(record) {
    const now = this.now();
    for (const [id, c] of this.liveCache) if (now - c.at > 60_000 || !this.store.records.has(id)) this.liveCache.delete(id);
    const hit = this.liveCache.get(record.id);
    if (hit && now - hit.at < LIVE_CACHE_MS) return hit.promise;
    const promise = (async () => {
      const { mr } = await this.readMr(record);
      const approvals = await this.refreshApprovals(record);
      const kind = kindOf(record);
      await this.warmAvatars(mr, approvals);
      return { slots: liveSlots({ kind, mr, approvals, host: this.gitlabHost, avatars: this.avatarsFor(mr, approvals) }), actionable: liveState(kind, mr).actionable };
    })();
    const entry = { at: now, promise };
    this.liveCache.set(record.id, entry);
    promise.catch(() => {
      if (this.liveCache.get(record.id) === entry) this.liveCache.delete(record.id);
    });
    return promise;
  }

  /** The approvals of the merge request for the page (remembered for the next render); null when unknown. */
  async refreshApprovals(record) {
    if (typeof this.gitlab.getApprovalSummary !== 'function') return null;
    try {
      const approvals = await this.gitlab.getApprovalSummary(record.project, record.iid);
      if (approvals?.known === false) return this.lastApprovals.get(record.id) ?? null;
      this.lastApprovals.set(record.id, approvals);
      while (this.lastApprovals.size > 500) this.lastApprovals.delete(this.lastApprovals.keys().next().value);
      return approvals;
    } catch {
      return this.lastApprovals.get(record.id) ?? null;
    }
  }

  /** GET <base>/state: the live status of the merge request behind the session's link. */
  async state(req, res) {
    const session = this.sessionOf(req);
    if (!session) return this.json(res, 401, {});
    if (kindOf(session.record) === 'approve') {
      const result = await userApprovalPreflight(this.gitlabHost, session.record, session);
      if (!result.mr) return this.json(res, 403, {});
    }
    try {
      return this.json(res, 200, await this.liveSnapshot(session.record));
    } catch {
      return this.json(res, 502, {});
    }
  }

  /** Buttons that lead on after a finished action: the merge request in GitLab and the Teams card. */
  followLinks(record) {
    const mr = safeLink(typeof this.gitlab.mrLink === 'function' ? this.gitlab.mrLink(record.project, record.iid) : '', this.gitlabHost);
    const card = typeof this.locateCard === 'function' ? this.locateCard(record.project, record.iid) : null;
    const teams = card ? teamsMessageLink(card.conversationId, card.messageId) : '';
    const links = [
      mr ? `<a class="btn" href="${escapeHtml(mr)}" target="_blank" rel="noopener noreferrer">View merge request in GitLab</a>` : '',
      teams ? `<a class="btn btn-secondary" href="${escapeHtml(teams)}" target="_blank" rel="noopener noreferrer">Open the Teams card</a>` : '',
    ].filter(Boolean);
    return links.length ? `<p class="links">${links.join('')}</p>` : '';
  }

  /** The page contains individual links as a fallback when a browser blocks pop-ups. */
  async showBatchOpen(res, record) {
    const links = (await Promise.all(record.items.map(async (item) => {
      const url = safeLink(this.gitlab.mrLink(item.project, item.iid), this.gitlabHost);
      let mr = null;
      let approvals = null;
      try {
        ({ mr } = await this.readMr(item));
        approvals = await this.gitlab.getApprovalSummary?.(item.project, item.iid) || null;
        await this.warmAvatars(mr, approvals);
      } catch { /* Keep the link usable when GitLab is unavailable. */ }
      const summary = renderSummary({ record: item, mr: mr ? { ...mr, web_url: mr.web_url || url } : null, approvals, host: this.gitlabHost, avatars: this.avatarsFor(mr, approvals), live: false });
      const openLink = url ? `<a data-mr-link href="${escapeHtml(url)}" hidden tabindex="-1" aria-hidden="true"></a>` : '';
      const approveUrl = this.oauth && item.sha ? this.linkFor({ ...item, action: 'approve' }) : null;
      const approve = approveUrl ? `<a class="btn btn-secondary" href="${escapeHtml(approveUrl)}">👍 Approve</a>` : '<button class="btn btn-secondary" type="button" disabled>Cannot approve</button>';
      return `<section class="batch-item">${summary}${openLink}<div class="batch-actions">${approve}</div></section>`;
    }))).join('');
    const approvable = record.items.filter((item) => item.sha);
    const approveUrl = this.oauth && approvable.length ? this.batchLinkFor(approvable, 'approve') : null;
    const approve = approveUrl ? `<p><a class="btn" href="${escapeHtml(approveUrl)}">👍 Approve all</a></p><p class="note">Approvals are sent as the signed-in GitLab user.</p>` : '';
    const body = `<p>Opening the merge requests in separate tabs.</p><button id="open-all" class="btn" type="button">Open remaining</button><p id="open-note" class="note"></p><div class="batch-list">${links}</div><noscript><p>Open the links above individually.</p></noscript>${approve}`;
    return this.send(res, 200, this.page('Open merge requests', body, { kind: 'approve', script: `<script>${this.openAllScript}</script>` }), { script: 'open-all' });
  }

  /** Reuse the existing per-head approval records and checks for every member. */
  async batchPreflight(record, session) {
    const items = [];
    for (const item of record.items) {
      const initial = await userApprovalPreflight(this.gitlabHost, { ...item, status: 'open' }, session);
      if (initial.status === 'blocked') {
        items.push({ item, result: initial, status: 'blocked', reason: initial.reason });
        continue;
      }
      if (initial.status === 'already') {
        items.push({ item, result: initial, status: 'already' });
        continue;
      }
      this.store.forgetApproved(item.project, item.iid, item.sha);
      const link = this.store.linkFor({ ...item, action: 'approve' });
      if (!link) { items.push({ item, status: 'unavailable', reason: 'Approval link unavailable.' }); continue; }
      const result = initial;
      const actor = actorOf(result);
      const denied = result.status === 'ready' && this.signInDenied(session.user, result.mr, 'approve');
      items.push({ item, record: link.record, result, actor, status: denied || (result.status === 'ready' && !actor) ? 'blocked' : result.status, reason: denied || result.reason || '' });
    }
    return items;
  }

  async showBatchApproval(res, session) {
    if (!this.oauth) return this.send(res, 503, this.page('Sign-in unavailable', '<p>GitLab sign-in is required to approve.</p>', { tone: 'warn' }));
    if (!session.accessToken) return this.signInPage(res);
    const items = await this.batchPreflight(session.record, session);
    const ready = items.filter((item) => item.status === 'ready');
    const blocked = items.filter((item) => item.status !== 'ready' && item.status !== 'already');
    const actors = ready.map(({ record, actor }) => ({ id: record.id, user: actor.user, cred: actor.cred }));
    const encoded = Buffer.from(JSON.stringify(actors)).toString('base64url');
    const bind = this.bindOf({ user: 'batch', cred: encoded }, session.user);
    const csrf = this.csrf.issue(session.sid, session.record.id, bind);
    const rows = items.map(({ item, result, status, reason }, index) => {
      const label = status === 'ready' ? 'Ready to approve' : status === 'already' ? 'Already approved by you' : reason || status;
      const icon = status === 'ready' ? '⏳' : status === 'already' ? '✅' : '❌';
      const mr = result?.mr;
      const summary = renderSummary({ record: item, mr: mr ? { ...mr, web_url: mr.web_url || this.gitlab.mrLink?.(item.project, item.iid) } : null, approvals: result?.approvals, host: this.gitlabHost, avatars: this.avatarsFor(mr, result?.approvals), live: false });
      const action = status === 'ready' ? `<div class="batch-actions"><button class="btn btn-secondary" type="submit" name="item_index" value="${index}" data-approve-item>👍 Approve</button></div>` : '';
      return `<section class="batch-item" data-batch-item data-index="${index}" data-status="${escapeHtml(status)}">${summary}<div class="batch-status" data-batch-status data-status="${escapeHtml(status)}">${icon} ${escapeHtml(label)}</div>${action}</section>`;
    }).join('');
    const warning = blocked.length ? `<p class="callout">❌ ${blocked.length} of ${items.length} merge request(s) cannot be approved.</p>` : '';
    const action = ready.length ? `<p id="batch-prompt">Approve ${ready.length} eligible merge request(s) with the account shown above?</p><button id="batch-approve-all" class="btn" type="submit">👍 Approve ${ready.length === items.length ? 'all' : 'eligible'}</button>` : '<p>No approvals were sent. There are no eligible merge requests to approve.</p>';
    const form = `<form id="batch-approval" method="post" action="${escapeHtml(`${this.origin}${this.basePath}/confirm`)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="actors" value="${escapeHtml(encoded)}"><div class="batch-list">${rows}</div><div class="batch-bar"><p id="batch-message" class="batch-message" role="status" aria-live="polite"></p><progress id="batch-progress" class="batch-progress" hidden aria-label="Approval progress"></progress>${action}</div></form>`;
    return this.send(res, 200, this.page('Approve merge requests', `${warning}${form}`, { kind: 'approve', tone: blocked.length ? 'warn' : 'neutral', script: `<script>${BATCH_APPROVAL_SCRIPT}</script>` }), { script: 'batch' });
  }

  async approveBatch(req, res, session) {
    if (!this.originAllowed(req)) return this.send(res, 403, this.page('Not allowed', '<p>Nothing was approved.</p>', { tone: 'warn' }));
    if (!this.oauth || !session.accessToken) return this.send(res, 401, this.page('Sign in required', '<p>Nothing was approved.</p>', { tone: 'warn' }));
    const parsed = await this.postForm(req);
    if (!parsed.form) return this.send(res, parsed.status, this.page('Request rejected', '<p>Nothing was approved.</p>', { tone: 'warn' }));
    const encoded = parsed.form.get('actors') || '';
    const bind = this.bindOf({ user: 'batch', cred: encoded }, session.user);
    if (!this.csrf.verify(parsed.form.get('csrf'), session.sid, session.record.id, bind)) return this.send(res, 403, this.page('Page expired', '<p>Nothing was approved.</p>', { tone: 'warn' }));
    let actors;
    try { actors = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { actors = null; }
    if (!Array.isArray(actors) || actors.length > session.record.items.length) return this.send(res, 400, this.page('Request rejected', '<p>Nothing was approved.</p>', { tone: 'warn' }));
    const rawIndex = parsed.form.get('item_index');
    const wantsJson = String(req.headers.accept || '').includes('application/json');
    if ((rawIndex !== null && (!/^(0|[1-9]\d*)$/.test(rawIndex) || Number(rawIndex) >= session.record.items.length)) || (wantsJson && rawIndex === null)) {
      return this.send(res, 400, this.page('Request rejected', '<p>Nothing was approved.</p>', { tone: 'warn' }));
    }
    const selected = rawIndex === null ? session.record.items : [session.record.items[Number(rawIndex)]];
    const outcomes = [];
    for (const item of selected) {
      const key = keyOf(item.project, item.iid);
      let outcome;
      try { outcome = await this.withLock(key, async () => {
        const checked = await userApprovalPreflight(this.gitlabHost, { ...item, status: 'open' }, session);
        if (checked.status === 'already') return { status: 'already', text: 'Already approved by you', mr: checked.mr, approvals: checked.approvals };
        if (checked.status !== 'ready') return { status: 'failed', text: checked.reason || checked.status, mr: checked.mr, approvals: checked.approvals };
        const link = this.store.linkFor({ ...item, action: 'approve' });
        if (!link) return { status: 'failed', text: 'Approval link unavailable', mr: checked.mr, approvals: checked.approvals };
        const shown = actors.find((a) => a.id === link.record.id);
        if (!shown) return { status: 'failed', text: 'Not included in the confirmation', mr: checked.mr, approvals: checked.approvals };
        const result = checked;
        const actor = actorOf(result);
        if (!actor || actor.user !== shown.user || actor.cred !== shown.cred) return { status: 'failed', text: 'Account changed; review again', mr: checked.mr, approvals: checked.approvals };
        const denied = this.signInDenied(session.user, result.mr, 'approve');
        if (denied) return { status: 'failed', text: denied, mr: checked.mr, approvals: checked.approvals };
        const sent = await this.sendUserApproval(link.record, result, session, { deferRefresh: wantsJson });
        let shownResult = checked;
        if (!wantsJson && sent.code === 200) {
          try { shownResult = await userApprovalPreflight(this.gitlabHost, { ...item, status: 'open' }, session); } catch { /* Keep the pre-approval snapshot. */ }
        }
        return { status: sent.code === 200 ? 'approved' : sent.title === 'Outcome unknown' ? 'unknown' : 'failed', text: sent.title === 'Outcome unknown' ? 'Outcome unknown; check this merge request in GitLab before retrying' : sent.title, mr: shownResult.mr || checked.mr, approvals: shownResult.approvals || checked.approvals };
      }); } catch { outcome = { status: 'unknown', text: 'Outcome unknown; check this merge request in GitLab before retrying' }; }
      outcomes.push({ item, ...outcome });
    }
    if (wantsJson) return this.json(res, 200, { status: outcomes[0].status, text: outcomes[0].text });
    const incomplete = outcomes.filter(({ status }) => status === 'failed' || status === 'unknown').length;
    const heading = incomplete ? `❌ ${incomplete} of ${outcomes.length} merge request(s) were not confirmed as approved.` : rawIndex !== null ? '✅ This MR is approved.' : outcomes.every(({ status }) => status === 'approved') ? '✅ All MRs were approved successfully.' : '✅ All MRs are approved.';
    const rows = outcomes.map(({ item, status, text, mr, approvals }) => {
      const summary = renderSummary({ record: item, mr: mr ? { ...mr, web_url: mr.web_url || this.gitlab.mrLink?.(item.project, item.iid) } : null, approvals, host: this.gitlabHost, avatars: this.avatarsFor(mr, approvals), live: false });
      return `<section class="batch-item">${summary}<div class="batch-status" data-status="${escapeHtml(status)}">${status === 'unknown' ? '⚠️' : status === 'failed' ? '❌' : '✅'} ${escapeHtml(text)}</div></section>`;
    }).join('');
    return this.send(res, 200, this.page('Approval results', `<p class="callout">${heading}</p><div class="batch-list">${rows}</div>`, { kind: 'approve', tone: incomplete ? 'warn' : 'ok' }));
  }

  async showConfirmation(res, session) {
    const { sid, record } = session;
    if (kindOf(record) === 'approve' && !this.oauth) return this.send(res, 503, this.page('Sign-in unavailable', '<p>GitLab sign-in is required to approve.</p>', { tone: 'warn' }));
    if (kindOf(record) === 'approve' && !session.accessToken) return this.signInPage(res);
    if (this.oauth && !session.user) return this.signInPage(res);
    const result = kindOf(record) === 'approve' ? await userApprovalPreflight(this.gitlabHost, record, session) : await this.evaluateCached(record);
    // Do not read or reveal bot-visible MR details when the visitor cannot see it.
    if (result.mr) await this.refreshApprovals(record);
    await this.warmAvatars(result.mr, this.lastApprovals.get(record.id));
    if (result.status === 'used') {
      const u = this.usedPage(record);
      return this.send(res, u.code, this.page(u.title, u.body, { tone: toneForCode(u.code) }));
    }
    const kind = kindOf(record);
    const copy = COPY[kind];
    if (result.status === 'blocked') {
      return this.send(res, 409, this.page(copy.blocked, `${this.summary(record, result.mr, result.user)}<p>${escapeHtml(result.reason)}</p>`, { tone: 'warn', kind }));
    }
    if (result.status === 'already') {
      const [alreadyTitle, alreadyBody] = this.alreadyPage(record, result);
      // Up to date after a rebase link: the approval is the next step.
      const offer = kind === 'rebase' ? await this.approveFollowUp(session) : '';
      return this.send(res, 200, this.page(alreadyTitle, alreadyBody + offer + this.followLinks(record), { tone: 'ok', kind }));
    }
    const actor = actorOf(result);
    if (!actor) {
      return this.send(res, 409, this.page(copy.blocked, `${this.summary(record, result.mr, null)}<p>${escapeHtml(UNVERIFIED_ACCOUNT)}</p>`, { tone: 'warn', kind }));
    }
    const denied = this.signInDenied(session.user, result.mr, kind);
    if (denied) return this.send(res, 403, this.page(copy.blocked, `${this.summary(record, result.mr, result.user)}<p>${escapeHtml(denied)}</p>`, { tone: 'warn', kind }));
    // The shown account and credential travel with the form and are bound into the CSRF token.
    const token = this.csrf.issue(sid, record.id, this.bindOf(actor, session.user));
    const form = `<div class="actions" data-live-action><form method="post" data-act action="${escapeHtml(`${this.origin}${this.basePath}/confirm`)}"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><input type="hidden" name="user" value="${escapeHtml(actor.user)}"><input type="hidden" name="cred" value="${escapeHtml(actor.cred)}"><p>${copy.question}</p>${kind === 'rebase' ? `<p class="note">GitLab rebases the source branch onto the target branch and rewrites its commits, without a merge commit. This sends one request to GitLab; it is never repeated automatically.</p>` : ''}${kind === 'merge' ? `<p class="note">Merges exactly the head commit above. Source-branch removal and squash follow the merge request's own settings. This sends one request to GitLab; it is never repeated automatically.</p>` : ''}<button class="btn" type="submit" data-busy="${escapeHtml(copy.busy)}">${copy.button}</button></form></div>`;
    return this.send(res, 200, this.page(copy.title, `${this.summary(record, result.mr, result.user)}${form}`, { tone: 'neutral', kind }));
  }

  /** `[title, body]` for a merge request that is already in the wanted state. */
  alreadyPage(record, result, sent = false) {
    const summary = this.summary(record, result.mr, result.user);
    if (record.action === 'merge') {
      return ['Already merged', `${summary}<p>This merge request is already merged in GitLab. ${sent ? 'Nothing was sent.' : 'Nothing to do.'}</p>`];
    }
    if (record.action === 'rebase') {
      return ['Already up to date', `${summary}<p>${result.rebasing ? 'GitLab is rebasing this merge request right now.' : 'This merge request is already up to date with its target branch.'} ${sent ? 'Nothing was sent.' : 'Nothing to do.'}</p>`];
    }
    if (record.action === 'reopen') {
      return ['Already open', `${summary}<p>This merge request is already open in GitLab. ${sent ? 'Nothing was sent.' : 'Nothing to do.'}</p>`];
    }
    return ['Already approved', `${summary}<p>You have already approved this merge request in GitLab. ${sent ? 'Nothing was sent.' : 'Nothing to do.'}</p>`];
  }

  async withLock(key, fn) {
    const prev = this.locks.get(key) || Promise.resolve();
    let release;
    const next = new Promise((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => next);
    this.locks.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  async approve(req, res, session) {
    const { sid } = session;
    // The record and kind this POST acts on. After a rebase, the page offers the approval of the new head
    // (`follow=approve`): the rebase link's session then acts on that approval instead.
    let record = session.record;
    let kind = kindOf(record);
    const nothingOf = (k) => ({ reopen: 'Nothing was reopened.', merge: 'Nothing was merged.', rebase: 'Nothing was rebased.', approve: 'Nothing was approved.' })[k];
    let nothing = nothingOf(kind);
    if (!this.originAllowed(req)) {
      this.send(res, 403, this.page('Not allowed', `<p>The request did not come from the confirmation page. ${nothing}</p>`, { tone: 'warn', kind }));
      return;
    }
    if ((kind === 'approve' && (!this.oauth || !session.accessToken)) || (this.oauth && !session.user)) {
      this.send(res, 401, this.page('Sign in required', `<p>Sign in with GitLab first. ${nothing}</p>`, { tone: 'warn', kind }));
      return;
    }
    const parsed = await this.postForm(req);
    if (!parsed.form) {
      const msg = parsed.status === 415 ? 'Unsupported request.' : 'The request was rejected.';
      this.send(res, parsed.status, this.page('Not allowed', `<p>${msg} ${nothing}</p>`, { tone: 'warn', kind }));
      return;
    }
    const shown = { user: parsed.form.get('user') ?? '', cred: parsed.form.get('cred') ?? '' };
    const follow = kind === 'rebase' && parsed.form.get('follow') === 'approve' ? String(parsed.form.get('sha') ?? '') : '';
    const bind = follow ? `${this.bindOf(shown, session.user)};follow=${follow}` : this.bindOf(shown, session.user);
    if (!this.csrf.verify(parsed.form.get('csrf'), sid, record.id, bind)) {
      this.send(res, 403, this.page('Page expired', `<p>This page expired. Open the link again and confirm. ${nothing}</p>`, { tone: 'warn', kind }));
      return;
    }
    if (follow) {
      if (!this.oauth || !session.accessToken) return this.send(res, 401, this.page('Sign in required', '<p>Nothing was approved.</p>', { tone: 'warn' }));
      // The approval of exactly the head commit the page showed: a head that changed since is refused by the
      // evaluation below (the record is pinned to it), and GitLab guards the approval with the same commit.
      const link = /^[0-9a-f]{40,64}$/i.test(follow) ? this.store.linkFor({ project: record.project, iid: record.iid, sha: follow, action: 'approve' }) : null;
      if (!link) {
        this.send(res, 409, this.page('Nothing to approve', '<p>This merge request is already approved by the configured account, or the page is outdated. Nothing was approved.</p>', { tone: 'warn', kind: 'approve' }));
        return;
      }
      record = link.record;
      kind = 'approve';
      nothing = nothingOf(kind);
    }

    const outcome = await this.withLock(keyOf(record.project, record.iid), async () => {
      this.readCache.delete(record.id);
      const current = this.store.byId(record.id);
      if (!current) return { code: 410, title: 'Link expired', body: `<p>This link expired. ${nothing}</p>` };
      const result = kind === 'approve' ? await userApprovalPreflight(this.gitlabHost, current, session) : await this.evaluate(current);
      if (result.status === 'used') return this.usedPage(current);
      if (result.status === 'blocked') {
        return { code: 409, title: COPY[kind].blocked, body: `${this.summary(current, result.mr, result.user)}<p>${escapeHtml(result.reason)}</p>` };
      }
      if (result.status === 'already') {
        if (kind === 'reopen') this.store.markReopened(current.project, current.iid);
        else if (kind === 'rebase') this.store.markRebased(current.project, current.iid);
        else if (kind === 'merge') this.store.markMerged(current.project, current.iid);
        const [title, body] = this.alreadyPage(current, result, true);
        return { code: 200, title, body };
      }
      // Only the account and credential the page showed may act.
      const actor = actorOf(result);
      if (!actor) {
        return { code: 409, title: COPY[kind].blocked, body: `${this.summary(current, result.mr, null)}<p>${escapeHtml(UNVERIFIED_ACCOUNT)}</p>` };
      }
      const denied = this.signInDenied(session.user, result.mr, kind);
      if (denied) return { code: 403, title: COPY[kind].blocked, body: `${this.summary(current, result.mr, result.user)}<p>${escapeHtml(denied)} ${nothing}</p>` };
      if (actor.user !== shown.user || actor.cred !== shown.cred) {
        return this.identityChanged(this.summary(current, result.mr, result.user), { reopen: 'reopened', merge: 'merged', rebase: 'rebased', approve: 'approved' }[kind]);
      }
      // Who asked, for the comment the action leaves on the merge request.
      result.ctx = { ip: this.clientIp(req), signedIn: session.user };
      if (kind === 'reopen') return this.sendReopen(current, result);
      if (kind === 'rebase') return this.sendRebase(current, result);
      return kind === 'merge' ? this.sendMerge(current, result) : this.sendUserApproval(current, result, session);
    });
    // After a rebase: offer the approval of the new head right on the result page.
    const offer = kind === 'rebase' && outcome.code === 200 ? await this.approveFollowUp(session) : '';
    this.send(res, outcome.code, this.page(outcome.title, outcome.body + offer + (outcome.code === 200 ? this.followLinks(record) : ''), { tone: outcome.tone || toneForCode(outcome.code), kind }));
  }

  /**
   * After a rebase, the Approve button for the new head commit: a form that acts through the rebase link's
   * session (`follow=approve`, the head it shows and the account it names are bound into the CSRF token).
   * Empty when there is nothing to approve: not open, still rebasing, no head, already approved by the account,
   * not approvable, or the signed-in user may not approve it.
   */
  async approveFollowUp(session) {
    const { sid, record } = session;
    if (kindOf(record) !== 'rebase') return '';
    let mr;
    try {
      ({ mr } = await this.readMr(record));
    } catch {
      return '';
    }
    if (mr?.state !== 'opened') return '';
    if (mr.rebase_in_progress === true) return '<p class="note">GitLab is still rebasing. Reload this page in a moment to approve.</p>';
    const head = mr.sha || mr.diff_refs?.head_sha || '';
    if (!/^[0-9a-f]{40,64}$/i.test(head)) return '';
    const link = this.store.linkFor({ project: record.project, iid: record.iid, sha: head, action: 'approve' });
    if (!link) return '';
    if (!session.accessToken) return '';
    const result = await userApprovalPreflight(this.gitlabHost, link.record, session);
    if (result.status !== 'ready') return '';
    const actor = actorOf(result);
    if (!actor || this.signInDenied(session.user, result.mr, 'approve')) return '';
    const token = this.csrf.issue(sid, record.id, `${this.bindOf(actor, session.user)};follow=${head}`);
    const who = escapeHtml(result.user?.username || result.user?.name || result.user?.id);
    const field = (name, value) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
    return (
      `<div class="actions" data-live-action><form method="post" data-act action="${escapeHtml(`${this.origin}${this.basePath}/confirm`)}">` +
      `${field('csrf', token)}${field('user', actor.user)}${field('cred', actor.cred)}${field('follow', 'approve')}${field('sha', head)}` +
      `<p>Approve this merge request now (head <code>${escapeHtml(head.slice(0, 12))}</code>) as <code>${who}</code>?</p>` +
      `<button class="btn" type="submit" data-busy="${escapeHtml(COPY.approve.busy)}">👍 Approve</button></form></div>`
    );
  }

  /**
   * Rebases the merge request: ONE request, never resent. GitLab answers at once and rebases in the
   * background, so the result is read back (`rebase_in_progress`, `merge_error`) a few times, spaced out.
   * The link is used up as soon as GitLab accepted the request.
   */
  async sendRebase(record, result) {
    const summary = this.summary(record, result.mr, result.user);
    try {
      await this.gitlab.rebaseMr(record.project, record.iid, this.asActor(result));
    } catch (err) {
      if (err?.identityMismatch) return this.identityChanged(summary, 'rebased');
      const status = gitlabStatus(err);
      log(`Rebase of ${record.project}!${record.iid} failed${status ? ` (HTTP ${status})` : ' (no response)'}`);
      if (status === 401 || status === 403) {
        return { code: 403, title: 'Rebase refused', body: `${summary}<p>GitLab refused the request (the configured account may not be allowed to rebase this merge request). Nothing was rebased.</p>` };
      }
      if (status === 404) return { code: 404, title: 'Rebase failed', body: `${summary}<p>GitLab could not find the merge request. Nothing was rebased.</p>` };
      if (status !== null && status < 500) {
        return { code: 409, title: 'Rebase failed', body: `${summary}<p>GitLab rejected the request (HTTP ${status}), for example because a rebase is already running or the merge request changed. Nothing was rebased. Reload the page to review it again.</p>` };
      }
      // No answer, or a server error: the request may have landed. Look before saying anything.
      const state = await this.readRebase(record, result);
      if (state?.rebase_in_progress === true) return this.rebaseStarted(record, summary, result);
      return { code: 502, title: 'Outcome unknown', body: `${summary}<p>GitLab did not give a clear answer. The merge request may or may not be rebased: check it in GitLab before retrying.</p>` };
    }
    this.store.markRebased(record.project, record.iid);
    let state = null;
    for (let i = 0; i < this.rebasePollAttempts; i++) {
      if (i > 0) await this.sleep(this.rebasePollMs);
      state = await this.readRebase(record, result);
      if (state && state.rebase_in_progress !== true) break;
    }
    if (state?.merge_error) {
      return { code: 409, title: 'Rebase failed', body: `${summary}<p>GitLab could not rebase the merge request: ${escapeHtml(String(state.merge_error).slice(0, 300))}</p>` };
    }
    if (state && state.rebase_in_progress !== true) return this.rebased(record, summary, result);
    return this.rebaseStarted(record, summary, result);
  }

  /** The merge request read back after a rebase request (null when it could not be read). */
  async readRebase(record, result) {
    return await this.gitlab.getMr(record.project, record.iid, this.asToken(result?.tokenIndex)).catch(() => null);
  }

  async rebased(record, summary, result = null) {
    this.store.markRebased(record.project, record.iid);
    await this.noteAction(record, result, { action: 'rebased', button: 'Rebase', ...(result?.ctx || {}) });
    const refresh = await this.refresh(record);
    return { code: 200, title: 'Rebased', body: `${summary}<p>Rebased in GitLab.</p><p class="note">${escapeHtml(refresh)}</p>` };
  }

  async rebaseStarted(record, summary, result = null) {
    this.store.markRebased(record.project, record.iid);
    await this.noteAction(record, result, { action: 'rebased', button: 'Rebase', ...(result?.ctx || {}) });
    const refresh = await this.refresh(record);
    return { code: 200, title: 'Rebase started', body: `${summary}<p>GitLab accepted the rebase and is still working on it. The card updates when it is done.</p><p class="note">${escapeHtml(refresh)}</p>` };
  }

  /**
   * Reopens the merge request. The outcome of a failed or unanswered request is
   * looked up before anything is said: nothing is used up unless it is open.
   */
  async sendReopen(record, result) {
    const summary = this.summary(record, result.mr, result.user);
    let response;
    try {
      response = await this.gitlab.reopenMr(record.project, record.iid, this.asActor(result));
    } catch (err) {
      if (err?.identityMismatch) return this.identityChanged(summary, 'reopened');
      const status = gitlabStatus(err);
      log(`Reopen of ${record.project}!${record.iid} failed${status ? ` (HTTP ${status})` : ' (no response)'}`);
      if (status === null || status >= 500) {
        return this.confirmReopen(record, summary, result);
      }
      if (status === 401 || status === 403) {
        return { code: 403, title: 'Reopen refused', body: `${summary}<p>GitLab refused the request (the configured account may not be allowed to reopen this merge request). Nothing was reopened.</p>` };
      }
      if (status === 404) {
        return { code: 404, title: 'Reopen failed', body: `${summary}<p>GitLab could not find the merge request. Nothing was reopened.</p>` };
      }
      return { code: 409, title: 'Reopen failed', body: `${summary}<p>GitLab rejected the request (HTTP ${status}), for example because the merge request cannot be reopened. Nothing was reopened. Reload the page to review it again.</p>` };
    }
    // Only an answer that says "opened" counts. Anything else (closed, merged,
    // an empty or odd body) is looked up again before a word is said.
    if (response?.state === 'opened') return this.reopened(record, summary, result);
    log(`Reopen of ${record.project}!${record.iid} answered with state ${JSON.stringify(response?.state ?? null)}`);
    return this.confirmReopen(record, summary, result);
  }

  /**
   * Reads the merge request back after a failed, unanswered or inconclusive
   * reopen. Only a confirmed "opened" uses the link up and refreshes the card.
   */
  async confirmReopen(record, summary, result = null) {
    const mr = await this.gitlab.getMr(record.project, record.iid, this.asToken(result?.tokenIndex)).catch(() => null);
    if (mr?.state === 'opened') return this.reopened(record, summary, result);
    if (mr?.state === 'merged') {
      this.store.invalidate(record.project, record.iid, 'reopen');
      return { code: 409, title: 'Reopen failed', body: `${summary}<p>This merge request is merged and cannot be reopened. Nothing was reopened.</p>` };
    }
    if (mr?.state === 'closed') {
      return { code: 502, title: 'Reopen failed', body: `${summary}<p>GitLab did not confirm the request and the merge request is still closed. Nothing was reopened. Reload the page to try again.</p>` };
    }
    if (mr) {
      return { code: 502, title: 'Outcome unknown', body: `${summary}<p>GitLab reported an unexpected state for the merge request. It may or may not be open again: check it in GitLab before retrying.</p>` };
    }
    return { code: 502, title: 'Outcome unknown', body: `${summary}<p>GitLab did not give a clear answer and the result could not be checked. The merge request may or may not be open again: check it in GitLab before retrying.</p>` };
  }

  async reopened(record, summary, result = null) {
    this.store.markReopened(record.project, record.iid);
    await this.noteAction(record, result, { action: 'reopened', button: 'Reopen', ...(result?.ctx || {}) });
    const refresh = await this.refresh(record);
    return { code: 200, title: 'Reopened', body: `${summary}<p>Reopened in GitLab.</p><p class="note">${escapeHtml(refresh)}</p>` };
  }

  /**
   * Merges the merge request: ONE request guarded by the head commit, never
   * resent. GitLab enforces its own rules and answers with a rejection when they
   * are not met. Nothing is claimed from the answer alone: every answer that is
   * not a plain "merged" at the expected head, a rejection included, is checked
   * by reading the merge request back before the page says what happened.
   */
  async sendMerge(record, result) {
    const summary = this.summary(record, result.mr, result.user);
    let response;
    try {
      response = await this.gitlab.mergeMrOnce(record.project, record.iid, { sha: record.sha, ...this.asActor(result) });
    } catch (err) {
      if (err?.identityMismatch) return this.identityChanged(summary, 'merged');
      const status = gitlabStatus(err);
      log(`Merge of ${record.project}!${record.iid} failed${status ? ` (HTTP ${status})` : ' (no response)'}`);
      return this.confirmMerge(record, summary, { status, result });
    }
    const head = response?.sha || response?.diff_refs?.head_sha || null;
    if (response?.state === 'merged' && head === record.sha) return this.merged(record, summary, result);
    log(`Merge of ${record.project}!${record.iid} answered with state ${JSON.stringify(response?.state ?? null)}`);
    return this.confirmMerge(record, summary, { accepted: true, result });
  }

  /**
   * Reads the merge request back after a rejected, failed, unanswered or
   * inconclusive merge. A merge may be queued and finish a moment later, so an
   * unclear outcome (timeout, 5xx, an answer that is not "merged") is read a few
   * times, spaced out; a plain 4xx rejection is read once. The merge itself is
   * never sent again. Only a confirmed "merged" at the expected head uses the
   * link up and refreshes the card, and "not merged" is only said where a read
   * shows the merge request open (or closed).
   */
  async confirmMerge(record, summary, { status = null, accepted = false, result = null } = {}) {
    const rejected = !accepted && status !== null && status < 500;
    const attempts = rejected ? 1 : this.mergePollAttempts;
    let mr = null;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await this.sleep(this.mergePollMs);
      mr = await this.gitlab.getMr(record.project, record.iid, this.asToken(result?.tokenIndex)).catch(() => null);
      if (mr?.state === 'merged') break;
      if (mr && mr.state !== 'opened' && mr.state !== 'locked') break;
    }
    if (mr?.state === 'merged') {
      const head = mr.sha || mr.diff_refs?.head_sha || null;
      if (head && head === record.sha) return this.merged(record, summary, result);
      this.store.invalidate(record.project, record.iid, 'merge');
      return { code: 409, title: 'Merge not confirmed', body: `${summary}<p>The merge request is merged, but not at the head commit this link was made for. It was not recorded as merged by this link: check it in GitLab.</p>` };
    }
    if (mr?.state === 'closed') {
      this.store.invalidate(record.project, record.iid, 'merge');
      return { code: 409, title: 'Merge failed', body: `${summary}<p>The merge request is closed, so it was not merged.</p>` };
    }
    if (mr?.state === 'locked') {
      return { code: 502, title: 'Merge in progress', body: `${summary}<p>GitLab is still merging this merge request and has not confirmed the result yet. It was not recorded as merged. Check it in GitLab, then reload the page.</p>` };
    }
    const answer = rejected ? `GitLab rejected the merge (HTTP ${status})` : status !== null ? `GitLab answered with an error (HTTP ${status})` : accepted ? 'GitLab accepted the request but did not report the merge request as merged' : 'GitLab did not answer the merge request';
    if (mr?.state === 'opened') {
      if (rejected) {
        const why = this.mergeRejectionHint(status);
        return { code: status === 401 || status === 403 ? 403 : status === 404 ? 404 : 409, title: status === 401 || status === 403 ? 'Merge refused' : 'Merge failed', body: `${summary}<p>${answer}${why}. The merge request is still open in GitLab, so it was not merged. Reload the page to review it again.</p>` };
      }
      const waited = Math.round(((attempts - 1) * this.mergePollMs) / 1000);
      return { code: 502, title: 'Merge not confirmed', body: `${summary}<p>${answer}${waited > 0 ? `. It still shows as open after ${waited} seconds` : '. It still shows as open'}, but a merge that GitLab queued can finish later. It was not recorded as merged. Check it in GitLab before trying again.</p>` };
    }
    if (mr) {
      return { code: 502, title: 'Outcome unknown', body: `${summary}<p>${answer}, and the merge request is in an unexpected state. It may or may not be merged: check it in GitLab before retrying.</p>` };
    }
    return { code: 502, title: 'Outcome unknown', body: `${summary}<p>${answer}, and the merge request could not be read back. It may or may not be merged: check it in GitLab before retrying.</p>` };
  }

  /** A short reason for a GitLab rejection of the merge, as a clause (leading text included) or empty. */
  mergeRejectionHint(status) {
    if (status === 401 || status === 403) return ' (the configured account may not be allowed to merge this merge request)';
    if (status === 404) return ' (it could not find the merge request or the merge endpoint)';
    if (status === 405 || status === 406) return ' (the merge request cannot be merged right now, for example because of conflicts or a failed rule)';
    if (status === 409) return ' (the head commit changed or a rule is not met)';
    return ' (its rules for this merge request are not met right now, or the merge request changed)';
  }

  async merged(record, summary, result = null) {
    this.store.markMerged(record.project, record.iid);
    await this.noteAction(record, result, { action: 'merged', button: 'Merge', ...(result?.ctx || {}) });
    // The merge request is gone from the approvable states for good.
    this.store.invalidate(record.project, record.iid, 'approve');
    const refresh = await this.refresh(record);
    return { code: 200, title: 'Merged', body: `${summary}<p>Merged in GitLab.</p><p class="note">${escapeHtml(refresh)}</p>` };
  }

  /**
   * The address the request came from. The server only listens on a loopback address, so a reverse proxy
   * is in front of it and the socket's peer is the proxy: then the address the proxy saw is used
   * (`X-Real-IP`, else the last `X-Forwarded-For` entry, which is the one the proxy itself added).
   */
  clientIp(req) {
    const peer = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    if (!LOOPBACK_HOSTS.has(peer) && peer !== '::1') return isIP(peer) ? peer : '';
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (isIP(real)) return real;
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((v) => v.trim()).filter(Boolean).at(-1) || '';
    return isIP(forwarded) ? forwarded : '';
  }

  /** Approve as the visitor; on an uncertain response, check the same account before reporting success. */
  async sendUserApproval(record, result, session, { deferRefresh = false } = {}) {
    const summary = this.summary(record, result.mr, result.user);
    try {
      await userApprovalWrite(this.gitlabHost, record, session);
    } catch (err) {
      if (!err.status || err.status >= 500 || err.status === 401 || err.status === 403) {
        const state = await userApprovalPreflight(this.gitlabHost, record, session);
        if (state.status !== 'already') {
          return { code: 502, title: 'Outcome unknown', body: `${summary}<p>GitLab did not confirm the approval. Check the merge request in GitLab before retrying.</p>` };
        }
      } else {
        return { code: 409, title: 'Approval failed', body: `${summary}<p>GitLab rejected the approval (HTTP ${err.status}). Review the merge request and try again.</p>` };
      }
    }
    if (deferRefresh) {
      void this.refresh(record);
      return { code: 200, title: 'Approved', body: '' };
    }
    const refresh = await this.refresh(record);
    return { code: 200, title: 'Approved', body: `${summary}<p>Approved in GitLab as your account.</p><p class="note">${escapeHtml(refresh)}</p>` };
  }

  async sendApproval(record, result, { ip = '', signedIn = null } = {}) {
    const summary = this.summary(record, result.mr, result.user);
    try {
      await this.gitlab.approveMr(record.project, record.iid, { sha: record.sha, ...this.asActor(result) });
    } catch (err) {
      if (err?.identityMismatch) return this.identityChanged(summary, 'approved');
      const status = gitlabStatus(err);
      log(`Approval of ${record.project}!${record.iid} failed${status ? ` (HTTP ${status})` : ' (no response)'}`);
      if (status === null || status >= 500 || status === 401 || status === 403) {
        // The outcome is uncertain (a first attempt may have landed before a
        // later answer): look before saying anything. Nothing is consumed
        // unless an approval is confirmed.
        // Asked as the very account the approval was sent as, never another one.
        const state = await this.gitlab.getUserApprovalState(record.project, record.iid, this.asToken(result.tokenIndex)).catch(() => ({ known: false }));
        if (state.known && state.hasApproved) {
          return this.approved(record, summary);
        }
        if (state.known && (status === 401 || status === 403)) {
          return { code: 403, title: 'Approval refused', body: `${summary}<p>GitLab refused the approval (the configured account may not be allowed to approve this merge request) and no approval is recorded. Nothing was approved.</p>` };
        }
        if (state.known) {
          return { code: 502, title: 'Approval failed', body: `${summary}<p>GitLab did not confirm the request and no approval is recorded. Nothing was approved. Reload the page to try again.</p>` };
        }
        return { code: 502, title: 'Outcome unknown', body: `${summary}<p>GitLab did not give a clear answer and the result could not be checked. The merge request may or may not be approved: check it in GitLab before retrying.</p>` };
      }
      if (status === 404) {
        return { code: 404, title: 'Approval failed', body: `${summary}<p>GitLab could not find the merge request. Nothing was approved.</p>` };
      }
      return { code: 409, title: 'Approval failed', body: `${summary}<p>GitLab rejected the approval (HTTP ${status}), for example because the merge request changed. Nothing was approved. Reload the page to review it again.</p>` };
    }
    // Always say how the approval came about: the bot's account approves, so GitLab alone would not tell.
    await this.noteAction(record, result, { action: 'approved', button: 'Approve', ip, signedIn });
    // The approval is the bot's account's, but the card should show who asked (with the Teams mark) when it is known.
    if (signedIn && this.recordApprover) {
      try {
        this.recordApprover(record.project, record.iid, signedIn);
      } catch (err) {
        log(`Could not record the approver of ${record.project}!${record.iid}: ${err.message}`);
      }
    }
    return this.approved(record, summary);
  }

  /**
   * Leaves a comment on the merge request after a successful action (approve, merge, rebase, reopen): the
   * configured account acts, so GitLab alone would not say who asked or how. Who asked is the signed-in GitLab user
   * when there is one; only when that is not known the comment carries the address the request came from (and
   * where it is). Best effort: a comment that cannot be left never fails the action.
   */
  async noteAction(record, result, { action, button, ip = '', signedIn = null }) {
    if (typeof this.gitlab.addMrNote !== 'function') return;
    try {
      const account = String(result?.user?.username || '').replace(/[^A-Za-z0-9_.-]/g, '');
      const card = typeof this.locateCard === 'function' ? this.locateCard(record.project, record.iid) : null;
      const note = buildApprovalNote({
        action,
        button,
        trigger: 'button',
        requesterNote: signedIn
          ? `@${signedIn.username} (signed in with GitLab)`
          : `someone with the card's ${button} link${account ? ` (confirmed as @${account})` : ''}`,
        message: card || {},
        // The address only tells something when nobody signed in.
        ip: signedIn ? '' : ip,
        place: !signedIn && ip && this.geoip ? formatPlace(this.geoip.lookup(ip)) : '',
      });
      await this.gitlab.addMrNote(record.project, record.iid, note, this.asToken(result?.tokenIndex));
    } catch (err) {
      log(`Could not comment the ${action} on ${record.project}!${record.iid}: ${err.message}`);
    }
  }

  /** The account that was shown is no longer the one that would act: nothing was sent. */
  identityChanged(summary, verb) {
    return { code: 409, title: 'Account changed', body: `${summary}<p>The GitLab account that would act is no longer the one shown above, so nothing was sent. Nothing was ${verb}. Reload the page to review it again.</p>` };
  }

  async approved(record, summary) {
    this.store.markApproved(record.project, record.iid, record.sha);
    const refresh = await this.refresh(record);
    return { code: 200, title: 'Approved', body: `${summary}<p>Approved in GitLab.</p><p class="note">${escapeHtml(refresh)}</p>` };
  }

  /** Runs the card refresh. The text says only what is known. */
  async refresh(record) {
    if (!this.refreshCards) return 'The Teams card is not refreshed by this service.';
    try {
      const result = await Promise.race([
        this.refreshCards(record.project, record.iid),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout')), REFRESH_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      if (!result || result.failed > 0) return 'The Teams card could not be refreshed yet. It updates at the next check.';
      if (result.matched === 0) return 'No watched Teams card needed a refresh.';
      return 'The Teams card refresh was run.';
    } catch {
      return 'The Teams card could not be refreshed yet. It updates at the next check.';
    }
  }
}

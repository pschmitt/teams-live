// The dashboard: one signed-in page with the open merge requests of the configured GitLab group, the active
// sprint, the open alerts with who is on call, and the next meetings.
//
// Who may see it: a GitLab user who signs in (OAuth, the same application as the approval flow) and is an
// active member of the configured group (and, when `oauth.allowed_users` is set, on that list too). The merge
// requests are read with the visitor's own token, so nobody sees a merge request GitLab would hide from them.
// Sprint, alerts and meetings come from the bot's own accounts.
//
// Data in, HTML out, plus two small GitLab reads (membership and one GraphQL query). Every value that reaches
// the HTML goes through `escapeHtml`, every link through `safeLink` (GitLab host) or `webLink` (http(s) only).

import { GITHUB_MARK, avatarImg, escapeHtml, safeLink } from './approve-page.mjs';
import { approvalBadge } from './approval-badges.mjs';
import { SERVICE_ICONS } from './card-icons.mjs';
import { ciStatusIcon, ciStatusInfo } from './cards.mjs';

const GITLAB_TIMEOUT_MS = 20_000;
const MAX_MR_PAGES = 3;
const GUEST_ACCESS = 10;

/** http(s) links only (Jira, OpsGenie and Teams links come from the configuration, not from GitLab). */
export function webLink(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

async function gitlabRequest(host, token, path, { method = 'GET', body = null } = {}) {
  const response = await fetch(`https://${host}/api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(GITLAB_TIMEOUT_MS),
  });
  if (!response.ok) {
    const error = new Error(`GitLab returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/** Whether the user is an active member of the group (directly or through a parent group), asked with their token. */
export async function isGroupMember(host, token, group, userId) {
  if (!group || !userId) return false;
  try {
    const member = await gitlabRequest(host, token, `v4/groups/${encodeURIComponent(group)}/members/all/${encodeURIComponent(userId)}`);
    return member?.state === 'active' && Number(member?.access_level) >= GUEST_ACCESS;
  } catch {
    return false;
  }
}

const MRS_QUERY = `query($group: ID!, $after: String) {
  group(fullPath: $group) {
    mergeRequests(state: opened, includeSubgroups: true, first: 100, after: $after, sort: UPDATED_DESC) {
      pageInfo { hasNextPage endCursor }
      nodes {
        iid title webUrl draft updatedAt sourceBranch targetBranch diffHeadSha detailedMergeStatus
        approved approvalsRequired approvalsLeft
        project { fullPath }
        author { username name bot }
        reviewers { nodes { username } }
        approvedBy { nodes { username name } }
        headPipeline { status }
        userPermissions { canApprove }
      }
    }
  }
}`;

const lower = (value) => String(value ?? '').toLowerCase();

/** The open merge requests of the group as the user sees them, newest activity first. One query per 100. */
export async function fetchGroupMrs(host, token, group) {
  const mrs = [];
  let after = null;
  for (let page = 0; page < MAX_MR_PAGES; page++) {
    const answer = await gitlabRequest(host, token, 'graphql', { method: 'POST', body: { query: MRS_QUERY, variables: { group, after } } });
    if (Array.isArray(answer?.errors) && answer.errors.length) throw new Error('GitLab could not list the merge requests');
    const conn = answer?.data?.group?.mergeRequests;
    if (!conn) break;
    for (const n of conn.nodes || []) mrs.push(normalizeMr(n));
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return mrs;
}

export function normalizeMr(n) {
  return {
    project: n.project?.fullPath || '',
    iid: Number(n.iid),
    title: String(n.title || ''),
    url: n.webUrl || '',
    draft: n.draft === true,
    updatedAt: n.updatedAt || '',
    source: n.sourceBranch || '',
    target: n.targetBranch || '',
    sha: n.diffHeadSha || '',
    mergeStatus: lower(n.detailedMergeStatus),
    approved: n.approved === true,
    required: Number.isFinite(n.approvalsRequired) ? n.approvalsRequired : null,
    left: Number.isFinite(n.approvalsLeft) ? n.approvalsLeft : null,
    author: { username: n.author?.username || '', name: n.author?.name || n.author?.username || '', bot: n.author?.bot === true },
    reviewers: (n.reviewers?.nodes || []).map((r) => lower(r.username)).filter(Boolean),
    approvedBy: (n.approvedBy?.nodes || []).map((u) => ({ username: lower(u.username), name: u.name || u.username })).filter((u) => u.username),
    pipeline: lower(n.headPipeline?.status),
    canApprove: n.userPermissions?.canApprove === true,
  };
}

/** One merge request for the detail panel, read with the visitor's token: itself, its approvals, its pipeline's jobs. */
export async function fetchMrDetail(host, token, project, iid) {
  const base = `v4/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(iid)}`;
  const [mr, approvals] = await Promise.all([gitlabRequest(host, token, base), gitlabRequest(host, token, `${base}/approvals`).catch(() => null)]);
  let jobs = [];
  if (mr?.head_pipeline?.id) {
    jobs = await gitlabRequest(host, token, `v4/projects/${encodeURIComponent(project)}/pipelines/${encodeURIComponent(mr.head_pipeline.id)}/jobs?per_page=100`).catch(() => []);
  }
  return { mr, approvals, jobs: Array.isArray(jobs) ? jobs : [] };
}

/** Bot-made merge requests (Renovate, service accounts, dependency updates): the same rules as `/mrs`. */
export function isBotMr(mr) {
  const username = lower(mr.author?.username);
  const name = lower(mr.author?.name);
  const title = lower(mr.title);
  return (
    mr.author?.bot === true ||
    ['renovate', 'bot', 'service'].some((w) => username.includes(w) || name.includes(w)) ||
    username.startsWith('sa_') ||
    ['chore(deps', 'update dependency', 'update module', 'pin dependency', 'lock file maintenance'].some((p) => title.startsWith(p))
  );
}

/** Which filters a merge request belongs to, for the signed-in user. */
export function mrFilters(mr, username) {
  const me = lower(username);
  const mine = lower(mr.author.username) === me;
  const approvedByMe = mr.approvedBy.some((u) => u.username === me);
  const f = [isBotMr(mr) ? 'bots' : 'human'];
  if (mine) f.push('mine');
  if (!mine && !mr.draft && !approvedByMe && mr.reviewers.includes(me)) f.push('review');
  if (mr.draft) f.push('draft');
  return f;
}

/** "5 min", "3 h", "2 d": how long ago, short. */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// --- pictures (inline: the CSP allows no images from elsewhere) ---

const svg = (d, cls = 'di') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`;
export const ICONS = {
  overview: svg('<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>'),
  mrs: svg('<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="19" r="2.2"/><path d="M6 7.2v9.6M18 16.8V9a3 3 0 0 0-3-3h-4"/><path d="M13 3.8L10.8 6 13 8.2"/>'),
  sprint: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9.5 4v16M14.5 4v16"/>'),
  alerts: svg('<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>'),
  meetings: svg('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  cross: svg('<path d="M7 7l10 10M17 7L7 17"/>'),
  run: svg('<path d="M12 3a9 9 0 1 0 9 9"/>', 'di spin'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  thumb: svg('<path d="M7 11v9H4v-9zM7 11l4-8a2 2 0 0 1 2 2v4h5.5a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.3 20H7"/>'),
  video: svg('<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/>'),
  ext: svg('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  ticket: svg('<path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  undo: svg('<path d="M4 9h11a5 5 0 0 1 0 10h-4"/><path d="M8 5L4 9l4 4"/>'),
  bolt: svg('<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>'),
  hide: svg('<path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 8.5 4.4 9.5 6-.5.8-1.4 2-2.7 3.2M6.6 6.6C4.6 7.9 3.2 9.8 2.5 12c1 1.6 4.5 6 9.5 6 1.6 0 3-.4 4.3-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  grip: svg('<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
  offline: svg('<path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5-2.7M19 13a10 10 0 0 0-2.4-1.6M2 9.5a15 15 0 0 1 6-3.3M22 9.5A15 15 0 0 0 12 5.5"/><circle cx="12" cy="20" r=".8"/>'),
  refresh: svg('<path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4"/>'),
  collapse: svg('<path d="M11 7l-5 5 5 5M18 7l-5 5 5 5"/>'),
  signout: svg('<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>'),
  phone: svg('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z"/>'),
};


/** An embedded picture descriptor (`{url}`) as an <img>, or ''. Only data: images (the CSP allows nothing else). */
function img(desc, label, height, cls) {
  const url = desc?.url;
  if (typeof url !== 'string' || !/^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(url)) return '';
  const width = desc.width && desc.height ? Math.round((desc.width * height) / desc.height) : height;
  return `<img class="${cls}" src="${escapeHtml(url)}" width="${width}" height="${height}" alt="${escapeHtml(label)}" title="${escapeHtml(label)}">`;
}

/** The pipeline as GitLab's own status icon (the one on the Teams card), with its state as the tooltip. */
function pipelineIcon(status) {
  if (!status) return '<span class="ci-none" title="No pipeline"></span>';
  return img(ciStatusIcon(status), `Pipeline: ${ciStatusInfo(status).label}`, 16, 'ci-ic') || `<span class="ci-none" title="Pipeline: ${escapeHtml(status)}"></span>`;
}

// --- sections ---

const FILTERS = [
  ['review', 'Needs my review'],
  ['mine', 'Mine'],
  ['human', 'Human'],
  ['bots', 'Bots'],
];

/** The default filter: what waits for the user when anything does, else everything made by people. */
export function defaultFilter(mrs, username) {
  return mrs.some((mr) => mrFilters(mr, username).includes('review')) ? 'review' : 'human';
}

/** The inline Approve button for a listed merge request, or '' (approved already, not allowed, draft, failed pipeline). */
export function approveButton(mr, username) {
  const me = lower(username);
  const filters = mrFilters(mr, username);
  if (mr.approvedBy.some((u) => u.username === me)) return '';
  if (!(filters.includes('review') || (mr.canApprove && !filters.includes('mine') && !mr.draft))) return '';
  if (!(mr.canApprove && mr.sha && mr.pipeline !== 'failed')) return '';
  return `<button class="btn btn-secondary btn-sm" type="button" data-approve data-project="${escapeHtml(mr.project)}" data-iid="${escapeHtml(mr.iid)}" data-sha="${escapeHtml(mr.sha)}" aria-label="Approve ${escapeHtml(mr.project)}!${escapeHtml(mr.iid)}">${ICONS.thumb}Approve</button>`;
}

function mrRow(mr, { username, host, avatars, now }) {
  const me = lower(username);
  const filters = mrFilters(mr, username);
  const url = safeLink(mr.url, host);
  const projectUrl = url ? url.replace(/\/-\/merge_requests\/\d+.*$/, '') : '';
  const approvedByMe = mr.approvedBy.some((u) => u.username === me);
  const given = mr.approvedBy.length;
  const required = mr.required ?? 0;
  // The approval badge of the Teams card ("Approved", "1 of 2 Approvals", "Not approved yet"); who approved in its tooltip.
  const names = mr.approvedBy.map((u) => (u.username === me ? 'you' : u.name));
  // Without approval rules GitLab calls every merge request approved; like the cards, it then takes one approver.
  const state = required > 0 ? mr.approved || given >= required : given > 0;
  const badgeLabel = `${state ? 'Approved' : required > 0 ? `${given} of ${required} approvals` : 'Not approved yet'}${names.length ? ` (by ${names.join(', ')})` : ''}`;
  const badge = img(approvalBadge({ approved: state, approvalsGiven: given, approvalsRequired: required }), badgeLabel, 18, 'appr-badge');
  const action = approveButton(mr, username);
  // The title opens the detail panel (the row's click); the small icon next to it goes straight to GitLab.
  const open = url ? `<a class="mr-ext" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="Open in GitLab" aria-label="Open ${escapeHtml(mr.project)}!${escapeHtml(mr.iid)} in GitLab">${ICONS.ext}</a>` : '';
  const title = `${mr.draft ? '<span class="pill pill-draft">Draft</span>' : ''}<span class="tt">${escapeHtml(mr.title)}</span>${open}`;
  const ref = projectUrl ? `<a class="muted-link" href="${escapeHtml(projectUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(mr.project)}</a>!${escapeHtml(mr.iid)}` : `${escapeHtml(mr.project)}!${escapeHtml(mr.iid)}`;
  return (
    `<li class="mrrow" data-f="${filters.join(' ')}" data-key="${escapeHtml(`${mr.project}!${mr.iid}`)}" data-mr="${escapeHtml(`${mr.project}!${mr.iid}`)}" tabindex="0" aria-label="${escapeHtml(`Details of ${mr.project}!${mr.iid}: ${mr.title}`)}">` +
    `${avatarImg(mr.author.name, avatars)}` +
    `<div class="mrmain"><span class="t">${title}</span><span class="m">${(mr.issues || []).map((k) => `<button type="button" class="tchip" data-issue="${escapeHtml(k)}" title="Preview ${escapeHtml(k)}">${ICONS.ticket}${escapeHtml(k)}</button>`).join('')}<span>${ref}</span><span>· ${escapeHtml(mr.author.name)}</span><span>· ${escapeHtml(ago(mr.updatedAt, now))}</span></span></div>` +
    `<div class="mrside">${pipelineIcon(mr.pipeline)}${badge}${action}</div>` +
    '</li>'
  );
}

export function mrsSection(state, ctx) {
  if (state.error) return `<p class="empty">${escapeHtml(state.error)}</p>`;
  const mrs = state.items || [];
  const counts = Object.fromEntries(FILTERS.map(([k]) => [k, mrs.filter((mr) => mrFilters(mr, ctx.username).includes(k)).length]));
  const drafts = mrs.filter((mr) => mr.draft).length;
  const chips = `<div class="chips" role="group" aria-label="Filter merge requests">${FILTERS.map(([k, label]) => `<button type="button" data-mrf-to="${k}">${label}<span class="n">${counts[k]}</span></button>`).join('')}<span class="chips-sep"></span><button type="button" class="toggle" data-nodraft-toggle aria-pressed="false" title="Hide draft merge requests">Hide drafts<span class="n">${drafts}</span></button></div>`;
  const rows = mrs.map((mr) => mrRow(mr, ctx)).join('');
  const empties = FILTERS.map(([k]) => `<li class="empty only-${k}">${k === 'review' ? 'Nothing waits for your review.' : k === 'mine' ? 'You have no open merge requests.' : 'No open merge requests.'}</li>`).join('');
  return `${chips}<ul class="mrlist">${rows}${empties}</ul>`;
}

const SPRINT_COLUMNS = [
  ['todo', 'To do'],
  ['inProgress', 'In progress'],
  ['inReview', 'In review'],
];

export function sprintSection(state, ctx) {
  if (state.error) return `<p class="empty">${escapeHtml(state.error)}</p>`;
  const sprint = state.data || {};
  const all = SPRINT_COLUMNS.flatMap(([k]) => sprint[k] || []);
  if (!all.length) return '<p class="empty">No open tickets in the active sprint.</p>';
  const me = lower(ctx.name);
  const counts = SPRINT_COLUMNS.map(([k]) => (sprint[k] || []).length);
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  const bar = `<div class="sbar" role="img" aria-label="${counts[2]} in review, ${counts[1]} in progress, ${counts[0]} to do"><i class="s-rev" style="width:${((100 * counts[2]) / total).toFixed(1)}%"></i><i class="s-prog" style="width:${((100 * counts[1]) / total).toFixed(1)}%"></i></div>`;
  const legend = `<p class="slegend"><span><i class="s-rev"></i>${counts[2]} in review</span><span><i class="s-prog"></i>${counts[1]} in progress</span><span><i class="s-todo"></i>${counts[0]} to do</span></p>`;
  const cols = SPRINT_COLUMNS.map(([k, label]) => {
    const tickets = (sprint[k] || []).map((t) => {
      const url = webLink(t.url);
      const mine = me && lower(t.assignee) === me;
      const key = escapeHtml(t.key);
      return `<li class="tk${mine ? ' mine' : ''}" data-key="${escapeHtml(t.key)}" data-issue="${escapeHtml(t.key)}" role="button" tabindex="0" aria-label="${escapeHtml(`${t.key}: ${t.summary}`)}"><span class="key">${key}<span>${escapeHtml(t.status || '')}</span></span><span class="sum">${escapeHtml(t.summary)}</span><span class="who">${avatarImg(t.assignee || 'Unassigned', ctx.avatars)}${escapeHtml(t.assignee || 'Unassigned')}</span></li>`;
    });
    return `<div class="col" data-col="${k}"><h4>${label}<span data-col-count>${tickets.length}</span></h4><ul>${tickets.join('') || '<li class="none">Nothing here</li>'}</ul></div>`;
  }).join('');
  return `${bar}${legend}<div class="board">${cols}</div>`;
}

const PRIORITY_ORDER = { P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 };

export function alertsSection(state, ctx) {
  if (state.error) return `<p class="empty">${escapeHtml(state.error)}</p>`;
  const data = state.data || {};
  const alerts = [...(data.alerts || [])].sort((a, b) => (PRIORITY_ORDER[a.priority] || 9) - (PRIORITY_ORDER[b.priority] || 9));
  const rows = alerts.slice(0, 12).map((a) => {
    const url = webLink(a.url);
    const prio = /^P[1-5]$/.test(a.priority) ? a.priority : 'P?';
    const msg = escapeHtml(a.message || 'Alert');
    const acked = a.acknowledged ? ' · acknowledged' : '';
    const open = /^[A-Za-z0-9-]{1,80}$/.test(String(a.id || '')) ? ` data-alert="${escapeHtml(a.id)}" role="button" tabindex="0" aria-label="${escapeHtml(`${prio} alert: ${a.message || ''}`)}"` : '';
    return `<li class="al${a.acknowledged ? ' acked' : ''}" data-key="${escapeHtml(a.tinyId || a.id || a.message || '')}"${open}><span class="prio prio-${prio.toLowerCase()}">${prio}</span><div><b>${msg}</b><small>${escapeHtml(a.queue || '')}${a.count > 1 ? ` · ${escapeHtml(a.count)}×` : ''} · ${escapeHtml(ago(a.createdAt, ctx.now))}${acked}</small></div></li>`;
  });
  const more = alerts.length > 12 ? `<li class="none">${alerts.length - 12} more in OpsGenie</li>` : '';
  const list = rows.length ? `<ul class="alist">${rows.join('')}${more}</ul>` : `<p class="empty ok">${ICONS.check}No open alerts.</p>`;
  // Who is on duty, per queue: their photo (initials without one) and name; nobody on duty reads "Off-duty".
  const duty = (data.duty || [])
    .filter(Boolean)
    .map((d) => {
      const people = Array.isArray(d.people) ? d.people.filter((p) => p?.name) : d.who ? [{ name: d.who }] : [];
      const who = people.length ? people.map((p) => `<span class="duty-p">${avatarImg(p.name, ctx.avatars)}<b>${escapeHtml(p.name)}</b></span>`).join('') : '<span class="note">Off-duty</span>';
      return `<li>${ICONS.phone}<span class="duty-who">${who}<small>${escapeHtml(d.queue)}</small></span></li>`;
    })
    .join('');
  return `${list}${duty ? `<ul class="duty">${duty}</ul>` : ''}`;
}

export function meetingsSection(state, ctx) {
  if (state.error) return `<p class="empty">${escapeHtml(state.error)}</p>`;
  const meetings = (state.data || []).filter((m) => Date.parse(m.endTime) > ctx.now).slice(0, 8);
  if (!meetings.length) return '<p class="empty">No more meetings this week.</p>';
  const tz = ctx.timeZone;
  const dayKey = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: tz });
  const today = dayKey(ctx.now);
  const tomorrow = dayKey(ctx.now + 86_400_000);
  const time = (d) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  let lastDay = '';
  const rows = meetings.map((m) => {
    const day = dayKey(m.startTime);
    const label = day === today ? 'Today' : day === tomorrow ? 'Tomorrow' : new Date(m.startTime).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: tz });
    const head = day !== lastDay ? `<li class="day">${escapeHtml(label)}</li>` : '';
    lastDay = day;
    const now = Date.parse(m.startTime) <= ctx.now && Date.parse(m.endTime) > ctx.now;
    const join = webLink(m.joinUrl);
    const button = join ? `<a class="btn ${now ? '' : 'btn-secondary '}btn-sm" href="${escapeHtml(join)}" target="_blank" rel="noopener noreferrer">${ICONS.video}${now ? 'Join' : '<span class="sr">Join</span>'}</a>` : '';
    return `${head}<li class="mt${now ? ' now' : ''}" data-key="${escapeHtml(`${m.subject}@${m.startTime}`)}"><time>${escapeHtml(time(m.startTime))}</time><div><b>${escapeHtml(m.subject || 'Meeting')}</b><small>${now ? 'Now · ' : ''}${escapeHtml(time(m.startTime))}–${escapeHtml(time(m.endTime))}${m.organizer ? ` · ${escapeHtml(m.organizer)}` : ''}</small></div>${button}</li>`;
  });
  return `<ul class="mlist">${rows.join('')}</ul>`;
}

const clip = (text, max) => {
  const t = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
};
const when = (iso, ctx) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return `${new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: ctx.timeZone })} (${ago(iso, ctx.now)})`;
};
const facts = (rows) => `<dl class="dfacts">${rows.filter(([, v]) => v).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

/**
 * Jira wiki markup (what the REST API v2 returns for a description) as safe HTML. Everything is escaped first;
 * only known markup becomes tags: headings (h1.-h6.), bulleted and numbered lists (nested), {code}/{noformat}
 * blocks, quotes (bq. and {quote}), tables, *bold*, _italic_, -strike-, {{monospace}} and [text|url] links
 * (http(s) only). Anything else stays visible as text.
 */
export function jiraWikiToHtml(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = [];
  const inline = (text) => {
    const codes = [];
    let t = escapeHtml(text).replace(/\{\{(.+?)\}\}/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
    t = t.replace(/\[([^\]|]*?)\|?([^\]|]+)\]/g, (whole, label, target) => {
      const raw = target.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
      const href = webLink(raw.trim());
      if (!href) return whole;
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label || escapeHtml(raw)}</a>`;
    });
    t = t
      .replace(/(^|[\s(>])\*(?=\S)([^*\n]*?\S)\*(?=$|[\s.,;:!?)<])/g, '$1<strong>$2</strong>')
      .replace(/(^|[\s(>])_(?=\S)([^_\n]*?\S)_(?=$|[\s.,;:!?)<])/g, '$1<em>$2</em>')
      .replace(/(^|[\s(>])-(?=\S)([^-\n]*?\S)-(?=$|[\s.,;:!?)<])/g, '$1<del>$2</del>');
    return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  };
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list.length) return;
    // Nested lists from the marker depth ("**" is level 2); the marker's last char picks ul or ol.
    let html = '';
    const open = [];
    for (const { depth, kind, text } of list) {
      while (open.length > depth) html += `</li></${open.pop()}>`;
      // Same level, other kind (bullets, then numbers): close the list and open the other one.
      if (open.length === depth && open[depth - 1] !== kind) html += `</li></${open.pop()}>`;
      else if (open.length === depth && depth > 0) html += '</li>';
      while (open.length < depth) {
        open.push(kind);
        html += `<${kind}>`;
      }
      html += `<li>${inline(text)}`;
    }
    while (open.length) html += `</li></${open.pop()}>`;
    out.push(html);
    list = [];
  };
  const flush = () => {
    flushPara();
    flushList();
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const block = /^\s*\{(code|noformat)(?::[^}]*)?\}(.*)$/.exec(line);
    if (block) {
      flush();
      const body = [];
      let rest = block[2];
      const close = new RegExp(`\\{${block[1]}\\}`);
      while (!close.test(rest) && i + 1 < lines.length) {
        if (rest) body.push(rest);
        rest = lines[++i];
      }
      const before = rest.split(close)[0];
      if (before) body.push(before);
      out.push(`<pre>${escapeHtml(body.join('\n'))}</pre>`);
      continue;
    }
    if (/^\s*\{quote\}\s*$/.test(line)) {
      flush();
      const body = [];
      while (i + 1 < lines.length && !/^\s*\{quote\}\s*$/.test(lines[i + 1])) body.push(lines[++i]);
      i++;
      out.push(`<blockquote>${body.map(inline).join('<br>')}</blockquote>`);
      continue;
    }
    const h = /^\s*h([1-6])\.\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push(`<h${Math.min(6, Number(h[1]) + 2)}>${inline(h[2])}</h${Math.min(6, Number(h[1]) + 2)}>`);
      continue;
    }
    const bq = /^\s*bq\.\s+(.*)$/.exec(line);
    if (bq) {
      flush();
      out.push(`<blockquote>${inline(bq[1])}</blockquote>`);
      continue;
    }
    const li = /^\s*([*#-]+)\s+(.*)$/.exec(line);
    if (li && (li[1][0] !== '-' || li[1].length === 1)) {
      flushPara();
      list.push({ depth: li[1].length, kind: li[1].endsWith('#') ? 'ol' : 'ul', text: li[2] });
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++].trim());
      i--;
      const cells = (row) => {
        const head = row.startsWith('||');
        // Keep the "|" of [label|url] links out of the cell split.
        const links = [];
        const safe = row.replace(/\[[^\]]*\]/g, (l) => `\u0001${links.push(l) - 1}\u0001`);
        const parts = safe.replace(/^\|\|?|\|\|?$/g, '').split(head ? '||' : '|');
        return { head, cells: parts.map((x) => x.replace(/\u0001(\d+)\u0001/g, (_, k) => links[Number(k)])) };
      };
      out.push(`<div class="tbl"><table>${rows.map((r) => { const c = cells(r); return `<tr>${c.cells.map((x) => (c.head ? `<th>${inline(x.trim())}</th>` : `<td>${inline(x.trim())}</td>`)).join('')}</tr>`; }).join('')}</table></div>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (list.length) flushList();
    para.push(line);
  }
  flush();
  return out.join('');
}

/**
 * GitLab Markdown (a merge request description) as safe HTML. HTML comments, images and wrapper tags (details,
 * summary, div, p, br, …, which Renovate uses) are dropped first; the rest is escaped, and only known Markdown
 * becomes tags: headings, lists (nested by indent), fenced code, quotes, tables, rules, **bold**, *italic*,
 * ~~strike~~, `code` and [text](url) links (http(s) only).
 */
export function markdownToHtml(src) {
  const text = String(src ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<\/?(details|summary|div|p|span|sup|sub|small|center|b|strong|i|em|code|br|hr|table|thead|tbody|tr|td|th|a)\b[^>]*>/gi, (t) => (/^<br|^<\/?(p|div|summary|tr)\b/i.test(t) ? '\n' : ''));
  const lines = text.split('\n');
  const out = [];
  let para = [];
  let list = [];
  const inline = (raw) => {
    const codes = [];
    let t = escapeHtml(raw).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
    t = t.replace(/!?\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (whole, label, target) => {
      const href = webLink(target.replace(/&amp;/g, '&'));
      return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label || escapeHtml(href)}</a>` : label || whole;
    });
    t = t
      .replace(/\*\*(?=\S)([^*]*?\S)\*\*|__(?=\S)([^_]*?\S)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
      .replace(/(^|[\s(>])[*_](?=\S)([^*_\n]*?\S)[*_](?=$|[\s.,;:!?)<])/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([^~]*?\S)~~/g, '<del>$1</del>');
    return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  };
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list.length) return;
    let html = '';
    const open = [];
    for (const { depth, kind, text: item } of list) {
      while (open.length > depth) html += `</li></${open.pop()}>`;
      if (open.length === depth && open[depth - 1] !== kind) html += `</li></${open.pop()}>`;
      else if (open.length === depth && depth > 0) html += '</li>';
      while (open.length < depth) {
        open.push(kind);
        html += `<${kind}>`;
      }
      html += `<li>${inline(item)}`;
    }
    while (open.length) html += `</li></${open.pop()}>`;
    out.push(html);
    list = [];
  };
  const flush = () => {
    flushPara();
    flushList();
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      const body = [];
      while (i + 1 < lines.length && !lines[i + 1].trim().startsWith(fence[1])) body.push(lines[++i]);
      i++;
      out.push(`<pre>${escapeHtml(body.join('\n'))}</pre>`);
      continue;
    }
    const h = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const level = Math.min(6, h[1].length + 2);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push('<hr>');
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      i--;
      out.push(`<blockquote>${body.map(inline).join('<br>')}</blockquote>`);
      continue;
    }
    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      flush();
      const split = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = split(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(split(lines[i++]));
      i--;
      out.push(`<div class="tbl"><table><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</table></div>`);
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (li) {
      flushPara();
      list.push({ depth: Math.floor(li[1].replace(/\t/g, '  ').length / 2) + 1, kind: /\d/.test(li[2]) ? 'ol' : 'ul', text: li[3] });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (list.length) flushList();
    para.push(line.trim());
  }
  flush();
  return out.join('');
}

const MR_STATE = { opened: ['ok', 'Open'], merged: ['merged', 'Merged'], closed: ['bad', 'Closed'], locked: ['idle', 'Locked'] };
const MERGE_TEXT = { mergeable: 'Ready to merge', not_approved: 'Approval required', ci_still_running: 'Pipeline running', ci_must_pass: 'Pipeline must succeed', conflict: 'Merge conflicts', need_rebase: 'Needs a rebase', draft_status: 'Draft', discussions_not_resolved: 'Unresolved threads', checking: 'Checking', not_open: 'Not open', blocked_status: 'Blocked by another merge request', requested_changes: 'Changes requested' };

/** A merge request for the detail panel: `{title, html, url}`; `approve` is the row's Approve button, if any. */
export function mrDetail({ mr, approvals, jobs }, ctx, approve = '') {
  const host = ctx.host;
  const url = safeLink(mr.web_url, host);
  const project = mr.references?.full ? mr.references.full.replace(/!\d+$/, '') : String(mr.web_url || '').replace(/^https?:\/\/[^/]+\//, '').replace(/\/-\/merge_requests\/.*$/, '');
  const draft = mr.draft || mr.work_in_progress;
  const [tone, stateText] = MR_STATE[mr.state] || ['idle', mr.state || 'Unknown'];
  const person = (u) => (u ? `<span class="who">${avatarImg(u.name || u.username, ctx.avatars)}${escapeHtml(u.name || u.username)}</span>` : '');
  const approvedBy = (approvals?.approved_by || []).map((a) => a.user).filter(Boolean);
  const required = Number(approvals?.approvals_required) || 0;
  const given = approvedBy.length;
  const ok = required > 0 ? approvals?.approved === true || given >= required : given > 0;
  const badge = img(approvalBadge({ approved: ok, approvalsGiven: given, approvalsRequired: required }), ok ? 'Approved' : `${given} of ${required} approvals`, 18, 'appr-badge');
  const pipe = mr.head_pipeline;
  const pipeUrl = safeLink(pipe?.web_url, host);
  const stages = [];
  for (const j of jobs || []) {
    let st = stages.find((x) => x.name === j.stage);
    if (!st) stages.push((st = { name: j.stage, jobs: [] }));
    st.jobs.push(j);
  }
  const stageStatus = (st) => {
    const ss = st.jobs.map((j) => j.status);
    for (const k of ['failed', 'running', 'pending', 'created', 'manual', 'canceled', 'skipped']) if (ss.includes(k) && !(k === 'failed' && st.jobs.every((j) => j.status !== 'failed' || j.allow_failure))) return k;
    return ss.every((x) => x === 'success' || x === 'skipped') ? 'success' : ss[0] || 'created';
  };
  const pipeline = pipe?.status
    ? `<span class="pipe">${img(ciStatusIcon(pipe.status), `Pipeline: ${ciStatusInfo(pipe.status).label}`, 16, 'ci-ic')}${pipeUrl ? `<a href="${escapeHtml(pipeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(ciStatusInfo(pipe.status).label)} #${escapeHtml(pipe.id)}</a>` : escapeHtml(ciStatusInfo(pipe.status).label)}</span>` +
      (stages.length ? `<span class="stages">${stages.map((st) => `<span class="stage" title="${escapeHtml(`${st.name}: ${st.jobs.map((j) => `${j.name} (${j.status})`).join(', ')}`)}">${img(ciStatusIcon(stageStatus(st)), '', 14, 'ci-ic')}${escapeHtml(st.name)}</span>`).join('')}</span>` : '')
    : '<span class="note">No pipeline</span>';
  const branch = (b) => `<code>${escapeHtml(b)}</code>`;
  const html =
    `<div class="dmeta"><div class="dhead"><span class="pill pill-${tone === 'merged' ? 'merged' : tone}">${escapeHtml(stateText)}</span>${draft ? '<span class="pill pill-draft">Draft</span>' : ''}<span class="dref">${escapeHtml(project)}!${escapeHtml(mr.iid)}</span></div>` +
    facts([
      ['Branches', `${branch(mr.source_branch)} → ${branch(mr.target_branch)}`],
      ['Author', person(mr.author)],
      ['Reviewers', (mr.reviewers || []).map(person).join(' ')],
      ['Approvals', `<span class="appr-line">${badge}${approvedBy.length ? `<span class="note">by ${approvedBy.map((u) => escapeHtml(u.name || u.username)).join(', ')}</span>` : ''}</span>`],
      ['Pipeline', pipeline],
      ['Merge status', escapeHtml(MERGE_TEXT[String(mr.detailed_merge_status || '').toLowerCase()] || String(mr.detailed_merge_status || '').replace(/_/g, ' '))],
      ['Changes', mr.changes_count ? escapeHtml(`${mr.changes_count} file(s)`) : ''],
      ['Labels', (mr.labels || []).map((l) => `<span class="lbl">${escapeHtml(l)}</span>`).join(' ')],
      ['Created', escapeHtml(when(mr.created_at, ctx))],
      ['Updated', escapeHtml(when(mr.updated_at, ctx))],
    ]) +
    (approve ? `<p class="dactions">${approve}</p>` : '') +
    '</div>' +
    (mr.description && mr.description.trim() ? `<div class="dtext rich">${markdownToHtml(clip(mr.description, 20000))}</div>` : '<p class="note">No description.</p>');
  return { title: mr.title || `Merge request !${mr.iid}`, html, url, urlLabel: 'Open in GitLab' };
}

/** A Jira ticket for the preview drawer: `{title, html}`, everything escaped, the link to Jira at the end. */
export function issueDetail(i, ctx) {
  const url = webLink(i.url);
  const html =
    '<div class="dmeta">' +
    facts([
      ['Status', `<span class="pill pill-${i.statusCategory === 'done' ? 'ok' : i.statusCategory === 'indeterminate' ? 'run' : 'idle'}">${escapeHtml(i.status)}</span>`],
      ['Type', escapeHtml(i.issueType)],
      ['Priority', escapeHtml(i.priority)],
      ['Assignee', `${avatarImg(i.assignee || 'Unassigned', ctx.avatars)}${escapeHtml(i.assignee || 'Unassigned')}`],
      ['Reporter', i.reporter ? `${avatarImg(i.reporter, ctx.avatars)}${escapeHtml(i.reporter)}` : ''],
      ['Labels', (i.labels || []).map((l) => `<span class="lbl">${escapeHtml(l)}</span>`).join(' ')],
      ['Created', escapeHtml(when(i.created, ctx))],
      ['Updated', escapeHtml(when(i.updated, ctx))],
    ]) +
    '</div>' +
    (i.description ? `<div class="dtext rich">${jiraWikiToHtml(clip(i.description, 20000))}</div>` : '<p class="note">No description.</p>');
  return { title: `${i.key} · ${i.summary}`, html, url, urlLabel: 'Open in Jira' };
}

/** An OpsGenie alert for the drawer: `{title, html}`. */
export function alertDetail(a, ctx) {
  const url = webLink(a.url);
  const prio = /^P[1-5]$/.test(a.priority) ? a.priority : 'P?';
  const details = a.details && typeof a.details === 'object' ? Object.entries(a.details).slice(0, 24) : [];
  const html =
    '<div class="dmeta">' +
    facts([
      ['Priority', `<span class="prio prio-${prio.toLowerCase()}">${prio}</span>`],
      ['Status', escapeHtml(`${a.status || 'open'}${a.acknowledged ? ', acknowledged' : ''}${a.snoozed ? ', snoozed' : ''}`)],
      ['Owner', escapeHtml(a.owner || '')],
      ['Count', a.count > 1 ? escapeHtml(`${a.count}×`) : ''],
      ['Source', escapeHtml(a.source || '')],
      ['Entity', escapeHtml(a.entity || '')],
      ['Created', escapeHtml(when(a.createdAt, ctx))],
      ['Last seen', escapeHtml(when(a.lastOccurredAt || a.updatedAt, ctx))],
      ['Tags', (a.tags || []).slice(0, 30).map((t) => `<span class="lbl">${escapeHtml(t)}</span>`).join(' ')],
    ]) +
    '</div>' +
    (a.description ? `<div class="dtext">${escapeHtml(clip(a.description, 4000))}</div>` : '') +
    (details.length ? `<h3 class="dsub">Details</h3>${facts(details.map(([k, v]) => [k, escapeHtml(clip(typeof v === 'string' ? v : JSON.stringify(v), 400))]))}` : '');
  return { title: a.message || 'Alert', html, url, urlLabel: 'Open in OpsGenie' };
}

/** The numbers at the top: what waits for the user, their own merge requests, their sprint tickets, open alerts. */
export function statsSection(data, ctx) {
  const mrs = data.mrs.items || [];
  const review = mrs.filter((mr) => mrFilters(mr, ctx.username).includes('review')).length;
  const mine = mrs.filter((mr) => mrFilters(mr, ctx.username).includes('mine'));
  const mineReady = mine.filter((mr) => mr.mergeStatus === 'mergeable').length;
  const me = lower(ctx.name);
  const sprint = data.sprint.data || {};
  const myTickets = [...(sprint.todo || []), ...(sprint.inProgress || [])].filter((t) => me && lower(t.assignee) === me).length;
  const alerts = data.alerts.data?.alerts || [];
  const urgent = alerts.filter((a) => a.priority === 'P1' || a.priority === 'P2').length;
  const tile = (view, icon, label, value, sub, tone = '', filter = '') =>
    `<button type="button" class="stat${tone ? ` stat-${tone}` : ''}" data-view-to="${view}"${filter ? ` data-mrf-set="${filter}"` : ''}><span class="k">${ICONS[icon]}${label}</span><span class="v">${value}</span><span class="s">${sub}</span></button>`;
  return [
    tile('mrs', 'mrs', 'Review requested', data.mrs.error ? '–' : review, review === 1 ? 'merge request waits for you' : 'merge requests wait for you', review ? 'accent' : '', 'review'),
    tile('mrs', 'mrs', 'Your merge requests', data.mrs.error ? '–' : mine.length, `${mineReady} ready to merge`, '', 'mine'),
    tile('sprint', 'sprint', 'Your sprint tickets', data.sprint.error ? '–' : myTickets, 'to do or in progress'),
    tile('alerts', 'alerts', 'Open alerts', data.alerts.error ? '–' : alerts.length, urgent ? `${urgent} with P1 or P2` : 'none urgent', urgent ? 'bad' : ''),
  ].join('');
}

/** All sections as HTML by name: the page and its refreshes are drawn by the same code. */
export function renderSections(data, ctx) {
  return {
    stats: statsSection(data, ctx),
    mrs: mrsSection(data.mrs, ctx),
    sprint: sprintSection(data.sprint, ctx),
    alerts: alertsSection(data.alerts, ctx),
    meetings: meetingsSection(data.meetings, ctx),
  };
}

/** Counters for the navigation, by section. */
export function navCounts(data, ctx) {
  const mrs = data.mrs.items || [];
  return {
    mrs: mrs.filter((mr) => mrFilters(mr, ctx.username).includes('review')).length,
    alerts: (data.alerts.data?.alerts || []).length,
  };
}

const NAV = [
  ['overview', 'Overview', 'Overview'],
  ['mrs', 'Merge requests', 'MRs'],
  ['sprint', 'Sprint', 'Sprint'],
  ['alerts', 'Alerts', 'Alerts'],
  ['meetings', 'Meetings', 'Meetings'],
];

// The cards in their default order, with their default width in columns of a 12-column grid. Each visitor can
// move and resize them; the layout is kept in their browser (localStorage), never on the server.
const SECTIONS = [
  ['mrs', 'Merge requests'],
  ['alerts', 'Alerts and on-call'],
  ['sprint', 'Active sprint'],
  ['meetings', 'Meetings'],
];

// The default layout: rows of columns (relative widths) holding stacks of cards. Each visitor can rearrange it.
export const DEFAULT_LAYOUT = { rows: [{ cols: [{ w: 8, cards: ['mrs', 'sprint'] }, { w: 4, cards: ['alerts', 'meetings'] }] }] };

/** The body of the dashboard page (inside the common header). */
export function dashboardBody({ data, ctx, csrf, filter, updated }) {
  const s = renderSections(data, ctx);
  const counts = navCounts(data, ctx);
  const badge = (k) => (counts[k] ? `<span class="badge${k === 'alerts' ? ' badge-bad' : ''}" data-count="${k}">${counts[k]}</span>` : `<span class="badge" data-count="${k}" hidden></span>`);
  const nav = (short) => NAV.map(([k, label, brief]) => `<button type="button" data-view-to="${k}"${short && brief !== label ? ` aria-label="${label}"` : ''}${short ? '' : ` title="${label}"`}>${ICONS[k]}<span>${short ? brief : label}</span>${k === 'mrs' || k === 'alerts' ? badge(k) : ''}</button>`).join('');
  const box = ([k, title]) =>
    `<section class="box box-${k}" data-sec="${k}" aria-labelledby="h-${k}">` +
    `<header><h2 id="h-${k}">${ICONS[k]}${title}</h2><span class="tools"><button type="button" class="tool" data-hide title="Hide this card" aria-label="Hide ${title}">${ICONS.hide}</button><button type="button" class="tool grip" data-grip title="Move with the arrow keys" aria-label="Move ${title}: arrow keys">${ICONS.grip}</button></span></header>` +
    `<div class="box-body" data-sec-body="${k}">${s[k]}</div><span class="rs" data-resize title="Drag to resize (height, and the width against the next column); double-click to reset the height" aria-hidden="true"></span></section>`;
  const byKey = Object.fromEntries(SECTIONS.map((sec) => [sec[0], sec]));
  const layout = DEFAULT_LAYOUT.rows
    .map((r) => `<div class="lrow">${r.cols.map((c) => `<div class="lcol" style="--w:${c.w}">${c.cards.map((k) => box(byKey[k])).join('')}</div>`).join('')}</div>`)
    .join('');
  return (
    `<div class="dash" id="dash" data-view="overview" data-mrf="${escapeHtml(filter)}">` +
    `<nav class="side" aria-label="Dashboard">${nav(false)}<div class="side-foot"><button type="button" class="sync" data-refresh title="Updated ${escapeHtml(updated)}, refreshes every minute. Click to refresh now.">${ICONS.refresh}<span id="dash-updated">${escapeHtml(updated)}</span></button><a class="side-gh" href="https://github.com/pschmitt/teams-live" target="_blank" rel="noopener noreferrer" title="teams-live on GitHub" aria-label="teams-live on GitHub">${GITHUB_MARK}</a><button type="button" class="side-toggle" data-collapse aria-expanded="true" title="Collapse sidebar" aria-label="Collapse sidebar">${ICONS.collapse}</button></div></nav>` +
    `<div class="dmain"><h1 class="sr">Dashboard</h1><div class="offline-bar" data-offline-bar hidden>${ICONS.offline}<span>You are offline. This is the dashboard as last loaded; approving and moving tickets wait until you are back online.</span></div>` +
    `<div class="stats" data-sec-body="stats">${s.stats}</div>` +
    `<div class="editbar" data-editbar><span class="hint">${ICONS.edit}Drag a card by its header: onto a card to stack it, to a card's side for a new column, onto a "New row" strip for a row of its own. Drag a card's corner or the column gaps to resize.</span><span class="hidden-bar" data-hidden-bar hidden></span><span class="sp"></span><button type="button" class="btn btn-secondary btn-sm" data-layout-reset disabled>Reset layout</button><button type="button" class="btn btn-sm" data-edit-done>Done</button></div>` +
    `<div class="layout" data-layout data-default="${escapeHtml(JSON.stringify(DEFAULT_LAYOUT))}">${layout}</div></div>` +
    `<nav class="tabbar" aria-label="Dashboard sections">${nav(true)}</nav>` +
    `<div class="palette" data-palette hidden><div class="pal-bg" data-pal-close></div><div class="pal-box" role="dialog" aria-modal="true" aria-label="Search and commands"><div class="pal-top">${ICONS.search}<input class="pal-in" data-pal-in type="text" placeholder="Search merge requests, tickets and alerts, or type a command" autocomplete="off" spellcheck="false" aria-controls="pal-list"></div><ul class="pal-list" id="pal-list" data-pal-list role="listbox"></ul><div hidden data-pal-icons>${['gitlab', 'jira', 'opsgenie'].map((k) => `<img data-ico="${k}" src="${escapeHtml(SERVICE_ICONS[k])}" width="16" height="16" alt="">`).join('')}${['overview', 'mrs', 'sprint', 'alerts', 'meetings', 'bolt', 'refresh', 'edit', 'collapse', 'hide', 'undo'].map((k) => `<span data-ico="${k}">${ICONS[k]}</span>`).join('')}</div><div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div></div></div>` +
    `<div class="drawer" data-drawer hidden><div class="drawer-bg" data-drawer-close></div><aside class="drawer-panel" role="dialog" aria-modal="true" aria-labelledby="drawer-title"><header><h2 id="drawer-title"></h2><a class="tool" data-drawer-link href="#" target="_blank" rel="noopener noreferrer" hidden>${ICONS.ext}</a><button type="button" class="tool" data-drawer-close aria-label="Close">${ICONS.close}</button></header><div class="drawer-body" data-drawer-body></div></aside></div>` +
    `<input type="hidden" id="dash-csrf" value="${escapeHtml(csrf)}"><div class="toasts" id="toasts" role="status" aria-live="polite"></div></div>`
  );
}


/** The web app manifest: the dashboard installs as an app (standalone window, the cap as its icon). */
export function webManifest(dashPath) {
  return {
    name: 'teams-live dashboard',
    short_name: 'teams-live',
    description: 'Merge requests, the active sprint, alerts and meetings.',
    id: dashPath,
    start_url: dashPath,
    scope: dashPath,
    display: 'standalone',
    background_color: '#18171d',
    theme_color: '#1f1e24',
    icons: [
      { src: `${dashPath}/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: `${dashPath}/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  };
}

/**
 * The service worker: the offline mode. It keeps the last signed-in dashboard page and its data (only responses
 * the server marks with X-TL-Offline, never the sign-in page) and the app icons; when the network fails it answers
 * from that copy, marked X-TL-From-Cache so the page shows that it is offline. Writes (approve, move) always go to
 * the network. A sign-out (or a 401) clears the copy.
 */
export function serviceWorkerScript(dashPath) {
  const root = JSON.stringify(dashPath);
  return `const CACHE='tl-dashboard',ROOT=${root};
const KEEP=[ROOT,ROOT+'/data'],ASSETS=[ROOT+'/manifest.webmanifest',ROOT+'/icon-192.png',ROOT+'/icon-512.png'];
self.addEventListener('install',function(){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});
self.addEventListener('message',function(e){if(e.data==='forget')e.waitUntil?e.waitUntil(caches.delete(CACHE)):caches.delete(CACHE)});
function cached(path){return caches.open(CACHE).then(function(c){return c.match(path)}).then(function(m){if(!m)return new Response('offline',{status:503,headers:{'Content-Type':'text/plain'}});var h=new Headers(m.headers);h.set('X-TL-From-Cache','1');return new Response(m.body,{status:m.status,headers:h})})}
self.addEventListener('fetch',function(e){var r=e.request;if(r.method!=='GET')return;var u=new URL(r.url);if(u.origin!==self.location.origin)return;var p=u.pathname,page=KEEP.indexOf(p)>=0,asset=ASSETS.indexOf(p)>=0;if(!page&&!asset)return;
e.respondWith(fetch(r).then(function(res){if(res.ok&&(asset||res.headers.get('X-TL-Offline')==='1')){var copy=res.clone();e.waitUntil(caches.open(CACHE).then(function(c){return c.put(p,copy)}))}if(res.status===401&&page)e.waitUntil(caches.delete(CACHE));return res}).catch(function(){return cached(p)}))});
`;
}

/** The page action in the top bar, next to the account: switches the layout edit mode. */
export const CUSTOMIZE_BUTTON = `<button type="button" class="hdr-btn hdr-search" data-pal-open title="Search and commands (Ctrl+K)" aria-label="Search and commands">${ICONS.search}<span>Search</span><kbd>Ctrl K</kbd></button><button type="button" class="hdr-btn" data-edit-toggle aria-pressed="false" title="Customize the dashboard: move, resize and hide cards" aria-label="Customize the dashboard">${ICONS.edit}</button>`;

export const DASHBOARD_CSS = [
  '.hdr-search{width:auto!important;gap:.45rem;padding:0 .6rem!important;font:inherit;font-size:.85rem;display:inline-flex!important;align-items:center}.hdr-search kbd{font:600 .68rem var(--mono);border:1px solid rgba(255,255,255,.25);border-radius:4px;padding:0 .3rem;opacity:.75}.hdr-search+.hdr-btn{margin-left:.35rem}',
  '.palette{position:fixed;inset:0;z-index:50}.palette[hidden]{display:none}.pal-bg{position:absolute;inset:0;background:rgba(0,0,0,.4);animation:tl-fade .15s var(--ease)}',
  '.pal-box{position:relative;margin:12vh auto 0;width:min(40rem,calc(100vw - 2rem));background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow-lg);overflow:hidden;animation:tl-menu .16s var(--ease)}',
  '.pal-top{display:flex;align-items:center;gap:.6rem;padding:.75rem 1rem;border-bottom:1px solid var(--line)}.pal-top .di{width:18px;height:18px;color:var(--muted)}.pal-in{flex:1;border:0;outline:0;background:none;color:var(--text);font:inherit;font-size:1rem}',
  '.pal-list{list-style:none;margin:0;padding:.35rem;max-height:min(55vh,28rem);overflow:auto;scrollbar-width:thin}.pal-list .grp{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:.55rem .6rem .25rem}',
  '.pal-list .ico{flex:none;width:16px;height:16px;display:grid;place-items:center;align-self:center;color:var(--muted)}.pal-list .ico .di{width:15px;height:15px}.pal-list .it[aria-selected=true] .ico{color:inherit}',
  '.pal-list .it{display:flex;gap:.6rem;align-items:baseline;padding:.45rem .6rem;border-radius:6px;cursor:pointer}.pal-list .it .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pal-list .it .s{font:.75rem var(--mono);color:var(--muted);white-space:nowrap}.pal-list .it[aria-selected=true]{background:var(--run-bg);color:var(--run)}.pal-list .none{color:var(--muted);padding:.75rem .6rem}',
  '.pal-foot{display:flex;gap:1rem;padding:.45rem 1rem;border-top:1px solid var(--line);font-size:.75rem;color:var(--muted);background:var(--subtle)}.pal-foot kbd{font:600 .7rem var(--mono);border:1px solid var(--line-strong);border-bottom-width:2px;border-radius:4px;padding:0 .3rem;margin-right:.2rem;background:var(--panel)}',
  '.offline-bar{display:flex;gap:.6rem;align-items:center;padding:.6rem .85rem;border-radius:8px;background:var(--warn-bg);color:var(--warn);font-size:.88rem;font-weight:600}.offline-bar[hidden]{display:none}.offline-bar .di{width:18px;height:18px;flex:none}.dash.is-offline .side .sync{color:var(--warn)}',
  '@media (max-width:48rem){.hdr-search span,.hdr-search kbd{display:none}}',
  '.hdr-btn{margin-left:auto;display:grid;place-items:center;width:32px;height:32px;border:0;border-radius:6px;background:none;color:var(--bar-text);opacity:.8;cursor:pointer;transition:background .15s,opacity .15s}.hdr-btn:hover{background:rgba(255,255,255,.1);opacity:1}.hdr-btn[aria-pressed=true]{background:var(--btn);opacity:1}.hdr-btn .di{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}.hdr-btn+.header-account{margin-left:.5rem}',
  '.shell.dashboard{max-width:none;padding:0}body:has(.dash) .brand{margin-bottom:0}',
  '.dash{--sw:13.5rem;background:linear-gradient(90deg,var(--subtle) 0 calc(var(--sw) - 1px),var(--line) calc(var(--sw) - 1px) var(--sw),transparent var(--sw));display:grid;grid-template-columns:13.5rem minmax(0,1fr);gap:0;min-height:calc(100vh - 49px);min-height:calc(100dvh - 49px);transition:grid-template-columns .3s var(--ease)}',
  '.side span{white-space:nowrap;overflow:hidden;transition:opacity .2s}.side button{position:relative;min-height:36px}',
  '.dash.collapsed{--sw:3.75rem;grid-template-columns:3.75rem minmax(0,1fr)}.dash.collapsed .side span{opacity:0;width:0}.dash.collapsed .side button{justify-content:center;gap:0;padding-inline:0}',
  '.side-foot{margin-top:auto;display:flex;align-items:center;gap:.25rem;padding-top:.5rem;border-top:1px solid var(--line)}',
  '.side .side-foot button{min-height:30px;border-radius:6px;color:var(--muted)}.side .sync{flex:1;gap:.4rem;padding:.25rem .5rem;font-size:.75rem;font-variant-numeric:tabular-nums}.side .sync .di{width:13px;height:13px}.side .sync.busy .di{animation:tl-spin .8s linear infinite}',
  '.side-gh{flex:none;width:30px;height:30px;display:grid;place-items:center;border-radius:6px;color:var(--muted);transition:background .15s,color .15s}.side-gh:hover{background:var(--panel);color:var(--text);text-decoration:none}.side-gh svg{width:15px;height:15px}.dash.collapsed .side-gh{width:auto}',
  '.side .side-toggle{flex:none;width:30px;justify-content:center;padding:0}.side .side-foot button:hover{background:var(--panel);color:var(--text)}.side-toggle .di{transition:transform .3s var(--ease)}',
  '.dash.collapsed .side-foot{flex-direction:column;align-items:stretch}.dash.collapsed .side .sync{flex:none;padding:.25rem 0}.dash.collapsed .side-toggle{width:auto}.dash.collapsed .side-toggle .di{transform:rotate(180deg)}',
  '.dash.collapsed .side .badge{position:absolute;top:1px;right:2px;margin:0;font-size:.6rem;padding:0 .3rem;opacity:1;width:auto}',
  '.dash .di{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}.dash .di.spin{animation:tl-spin 1.6s linear infinite}',
  '.side{position:sticky;top:49px;align-self:start;height:calc(100vh - 49px);overflow-y:auto;display:flex;flex-direction:column;gap:.15rem;padding:.75rem .6rem 1rem max(.6rem,env(safe-area-inset-left,0px));background:var(--subtle);border-right:1px solid var(--line)}',
  '.side button,.tabbar button{display:flex;align-items:center;gap:.6rem;border:0;background:none;font:inherit;color:var(--text);padding:.45rem .6rem;border-radius:6px;cursor:pointer;text-align:left;transition:background .15s}',
  '.side button:hover{background:var(--subtle)}.side button[aria-current=true]{background:var(--panel);box-shadow:inset 0 0 0 1px var(--line);font-weight:600}',
  '.badge{margin-left:auto;background:var(--run-bg);color:var(--run);border-radius:999px;font-size:.72rem;padding:0 .45rem;font-weight:700;font-variant-numeric:tabular-nums}.badge-bad{background:var(--closed-bg);color:var(--closed)}.badge[hidden]{display:none}',
    '.dmain{padding:1.25rem max(1.5rem,env(safe-area-inset-right,0px)) 0 1.5rem;display:flex;flex-direction:column;gap:1.1rem;align-content:start;min-width:0}',
    '.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.75rem}',
  '.stat{font:inherit;color:inherit;text-align:left;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:.8rem .95rem;display:grid;gap:.1rem;cursor:pointer;transition:transform .15s,box-shadow .15s,border-color .15s;animation:tl-rise .4s var(--ease) both}',
  '.stat:nth-child(2){animation-delay:.05s}.stat:nth-child(3){animation-delay:.1s}.stat:nth-child(4){animation-delay:.15s}',
  '.stat:hover{transform:translateY(-2px);box-shadow:var(--shadow);border-color:var(--line-strong)}.stat .k{font-size:.78rem;color:var(--muted);display:flex;gap:.4rem;align-items:center}',
  '.stat .v{font-size:1.7rem;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums}.stat .s{font-size:.78rem;color:var(--muted)}.stat-accent .v{color:var(--run)}.stat-bad .v{color:var(--closed)}',
  '.layout{display:flex;flex-direction:column;gap:1.1rem;flex:1 1 auto}.dash[data-view=overview] .lrow.lrow-last{flex:1 1 auto}.dmain{padding-bottom:1.25rem!important}.lrow{display:flex;gap:1.1rem;align-items:stretch;min-width:0}.lcol{flex:var(--w,4) 1 0;min-width:0;display:flex;flex-direction:column;gap:1.1rem;position:relative}.lcol>.box{flex:none}.dash[data-view=overview] .lcol>.box.fill{flex:1 1 auto}.lcol-empty{display:none!important}',
  '.box{display:flex;flex-direction:column;position:relative;min-width:0;transition:box-shadow .2s,opacity .2s,transform .2s}.box-body{flex:1;min-height:0;overflow:auto}',
  '.box>header .tools{margin-left:auto;display:flex;gap:.1rem}.dash:not(.editing) .tools,.dash:not(.editing) .rs,.dash:not(.editing) .editbar{display:none}',
  '.dash.editing .box{outline:1.5px dashed var(--line-strong);outline-offset:3px}.dash.editing .box>header{cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none}.dash.editing .box-body{pointer-events:none}.dash.editing .rs{opacity:1}',
  '.box.lifted{position:fixed;z-index:35;margin:0;pointer-events:none;box-shadow:var(--shadow-lg);transform:rotate(.6deg) scale(1.015);outline-color:var(--btn)!important;animation:none!important}.box.lifted>header{cursor:grabbing}',
  '.lcol-rs{position:absolute;top:0;bottom:0;right:calc(-.55rem - 5px);width:10px;cursor:col-resize;z-index:6;display:none}.dash.editing .lcol-rs{display:block}.lcol-rs::after{content:"";position:absolute;left:4px;top:15%;bottom:15%;width:2px;border-radius:1px;background:var(--line-strong);transition:background .15s}.lcol-rs:hover::after,.resizing-col>.lcol-rs::after{background:var(--btn)}',
  '.dash[data-view=overview] .lcol:not(:has(>.box:not(.is-hidden))):not(:has(>.box-ph)),.dash[data-view=overview] .lrow:not(:has(.box:not(.is-hidden))):not(:has(.box-ph)){display:none}',
  '.dash[data-view=mrs] .lcol:not(:has([data-sec=mrs])),.dash[data-view=mrs] .lrow:not(:has([data-sec=mrs])),.dash[data-view=sprint] .lcol:not(:has([data-sec=sprint])),.dash[data-view=sprint] .lrow:not(:has([data-sec=sprint])),.dash[data-view=alerts] .lcol:not(:has([data-sec=alerts])),.dash[data-view=alerts] .lrow:not(:has([data-sec=alerts])),.dash[data-view=meetings] .lcol:not(:has([data-sec=meetings])),.dash[data-view=meetings] .lrow:not(:has([data-sec=meetings])){display:none}',
  '.hidden-bar button.wiggle{animation:tl-wiggle .7s var(--ease),tl-chip 1.6s var(--ease)}@keyframes tl-wiggle{0%{transform:scale(.6)}25%{transform:scale(1.12) rotate(-6deg)}45%{transform:rotate(5deg)}65%{transform:rotate(-3deg)}85%{transform:rotate(1.5deg)}100%{transform:none}}@keyframes tl-chip{0%,40%{background:var(--run-bg);color:var(--run);border-color:var(--run)}}',
  '.lstrip{flex:none;height:44px;border:2px dashed var(--line-strong);border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:.8rem;animation:tl-fade .2s var(--ease);transition:background .15s,border-color .15s,color .15s}.lstrip.hot{border-color:var(--btn);background:var(--run-bg);color:var(--run)}',
  '.box-ph{flex:none;border:2px dashed var(--btn);border-radius:8px;background:var(--run-bg);opacity:.55}.tk-ph{list-style:none;border:2px dashed var(--btn);border-radius:6px;background:var(--run-bg);opacity:.6}.tk.lifted-tk{position:fixed;z-index:35;pointer-events:none;box-shadow:var(--shadow-lg);transform:rotate(1.5deg) scale(1.03);cursor:grabbing}',
  '.editbar{display:flex;flex-wrap:wrap;gap:.5rem .75rem;align-items:center;padding:.55rem .75rem;border:1px solid var(--line);border-radius:8px;background:var(--subtle);font-size:.85rem;animation:tl-rise .25s var(--ease)}.editbar .hint{display:inline-flex;gap:.4rem;align-items:center;color:var(--muted)}.editbar .sp{flex:1}.editbar .hidden-bar{margin:0}',
  '.tool{border:0;background:none;color:var(--muted);cursor:pointer;padding:.2rem;border-radius:4px;display:grid;place-items:center;transition:background .15s,color .15s}.tool:hover{background:var(--subtle);color:var(--text)}.grip{cursor:grab}.grip:active{cursor:grabbing}',
  '.dash[data-view=overview] .box.is-hidden{display:none}.dash:not([data-view=overview]) .hidden-bar{display:none}',
  '.hidden-bar{display:flex;flex-wrap:wrap;gap:.35rem;align-items:center;font-size:.78rem;color:var(--muted);margin-bottom:-.35rem}.hidden-bar[hidden]{display:none}.hidden-bar button{font:inherit;color:var(--muted);background:none;border:1px dashed var(--line-strong);border-radius:999px;padding:.05rem .6rem;cursor:pointer;transition:color .15s,border-color .15s}.hidden-bar button:hover{color:var(--text);border-color:var(--text)}',
  '.box.moving{opacity:.45;transform:scale(.98)}.box.drop-before{box-shadow:-4px 0 0 0 var(--btn)}.box.drop-after{box-shadow:4px 0 0 0 var(--btn)}',
  '.rs{position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;z-index:4;background:linear-gradient(135deg,transparent 0 50%,var(--line-strong) 50% 58%,transparent 58% 68%,var(--line-strong) 68% 76%,transparent 76% 86%,var(--line-strong) 86% 94%,transparent 94%);border-bottom-right-radius:8px;transition:filter .15s}.rs:hover,.box.resizing .rs{filter:brightness(1.6) saturate(2)}',
  '.box.resizing{box-shadow:0 0 0 2px var(--btn);transition:none}.dash.layouting{user-select:none;-webkit-user-select:none}',
  '.box{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden;animation:tl-rise .45s var(--ease) both}.box:nth-child(2){animation-delay:.05s}.box:nth-child(n+3){animation-delay:.1s}',
  '.box>header{display:flex;flex-wrap:wrap;gap:.25rem .75rem;align-items:baseline;padding:.7rem 1rem;border-bottom:1px solid var(--line)}.box>header h2{margin:0;font-size:.98rem;display:flex;gap:.45rem;align-items:center;flex:1}.box>header small{color:var(--muted);font-size:.75rem}',
  
  '.empty{color:var(--muted);padding:1.25rem 1rem;margin:0;text-align:center}.empty.ok{display:flex;gap:.5rem;align-items:center;justify-content:center;color:var(--ok)}',
  '.chips{display:flex;gap:.3rem;flex-wrap:wrap;padding:.6rem 1rem;border-bottom:1px solid var(--line);background:var(--subtle)}',
  '.chips button{font:inherit;font-size:.8rem;border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:999px;padding:.15rem .65rem;cursor:pointer;display:inline-flex;gap:.35rem;align-items:center;transition:background .15s,color .15s,border-color .15s}',
  '.chips .n{font-variant-numeric:tabular-nums;color:var(--muted);font-weight:600}.chips button[aria-pressed=true]{background:var(--text);color:var(--panel);border-color:var(--text)}.chips button[aria-pressed=true] .n{color:inherit;opacity:.75}',
  '.mrlist,.alist,.mlist,.duty,.board ul{list-style:none;margin:0;padding:0}',
  '.mrrow{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:.7rem;align-items:center;padding:.65rem 1rem;border-top:1px solid var(--line);transition:background .15s;animation:tl-rise .3s var(--ease) both}.mrrow:first-child{border-top:0}.mrrow:hover{background:var(--subtle)}',
  '.mrrow .av{margin:0;width:28px;height:28px}.mrmain{min-width:0}.mrmain .t{display:flex;align-items:center;gap:.35rem;font-weight:600;min-width:0}.mrmain .t .tt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.mrmain .t .pill{flex:none}.mr-ext{flex:none;display:grid;place-items:center;width:20px;height:20px;border-radius:4px;color:var(--muted);opacity:.55;transition:opacity .15s,background .15s,color .15s}.mr-ext .di{width:13px;height:13px}.mrrow:hover .mr-ext,.mr-ext:focus-visible{opacity:1}.mr-ext:hover{background:var(--subtle);color:var(--accent);text-decoration:none}.mrmain .m{font-size:.8rem;color:var(--muted);display:flex;flex-wrap:wrap;gap:.1rem .4rem}',
  '.muted-link{color:var(--muted)}.mrside{display:flex;gap:.6rem;align-items:center}',
  '.dot{width:20px;height:20px;border-radius:50%;display:grid;place-items:center}.dot .di{width:12px;height:12px;stroke-width:2.6}.dot-ok{background:var(--ok-bg);color:var(--ok)}.dot-bad{background:var(--closed-bg);color:var(--closed)}.dot-run{background:var(--run-bg);color:var(--run)}.dot-idle{background:var(--draft-bg);color:var(--draft)}',
  '.ci-ic{display:block;flex:none}.ci-none{width:16px;height:16px;border-radius:50%;border:1.5px dashed var(--line-strong);flex:none}.appr-badge{display:block;flex:none;height:18px;width:auto}.side [hidden]{display:none!important}',
  '.col.drop-here{background:var(--run-bg);box-shadow:inset 0 0 0 2px var(--btn)}.tk[data-issue]{touch-action:none}.tk.moved{animation:tl-new 1.6s var(--ease)}',
  '.tk[data-issue],.al[data-alert]{cursor:pointer}.tk[data-issue]:focus-visible,.al[data-alert]:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}.al[data-alert]{transition:background .15s}.al[data-alert]:hover{background:var(--subtle)}',
  '.tchip{display:inline-flex;align-items:center;gap:.25rem;font:600 .72rem var(--mono);color:var(--run);background:var(--run-bg);border:0;border-radius:4px;padding:.05rem .35rem;cursor:pointer;transition:filter .15s}.tchip:hover{filter:brightness(1.15)}.tchip .di{width:12px;height:12px}',
  '.drawer{position:fixed;inset:0;z-index:40}.drawer[hidden]{display:none}.drawer-bg{position:absolute;inset:0;background:rgba(0,0,0,.35);animation:tl-fade .2s var(--ease)}@keyframes tl-fade{from{opacity:0}}',
  '.drawer-panel{position:absolute;top:0;right:0;bottom:0;width:min(36rem,100vw);background:var(--panel);border-left:1px solid var(--line);box-shadow:var(--shadow-lg);display:flex;flex-direction:column;animation:tl-slide .28s var(--ease);padding-bottom:env(safe-area-inset-bottom,0px)}@keyframes tl-slide{from{transform:translateX(100%)}}',
  '.drawer-panel>header .tool{flex:none;width:30px;height:30px}.drawer-panel>header .tool .di{width:16px;height:16px}.drawer-panel>header .tool[hidden]{display:none}',
  '.drawer-panel>header{display:flex;gap:.35rem;align-items:center;padding:1rem 1.1rem .85rem;border-bottom:1px solid var(--line)}.drawer-panel h2{margin:0;font-size:1.05rem;line-height:1.35;flex:1;overflow-wrap:anywhere}',
  '.drawer-body{padding:0 1.1rem 1.5rem;overflow:auto;flex:1}.dmeta{position:sticky;top:0;z-index:2;background:var(--panel);padding-top:1rem;margin:0 -1.1rem 1rem;padding-inline:1.1rem;border-bottom:1px solid var(--line);box-shadow:0 8px 12px -12px rgba(0,0,0,.45)}.dmeta .dfacts{margin-bottom:.9rem}.dmeta .dactions{margin:0 0 .9rem}@media (max-height:600px){.dmeta{position:static}}.dfacts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:.45rem 1rem;margin:0 0 1rem;font-size:.88rem}.dfacts dt{color:var(--muted)}.dfacts dd{margin:0;overflow-wrap:anywhere}.dfacts .av{width:18px;height:18px}',
  '.dtext{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.88rem;line-height:1.55;background:var(--subtle);border:1px solid var(--line);border-radius:6px;padding:.75rem .85rem}.drawer-body{scrollbar-width:none}.drawer-body::-webkit-scrollbar{display:none}.dsub{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:1.1rem 0 .5rem}',
  '.dhead{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;margin:0 0 .9rem}.dref{font:.82rem var(--mono);color:var(--muted)}.who{display:inline-flex;align-items:center;margin-right:.6rem}.who .av{width:18px;height:18px}',
  '.pipe{display:inline-flex;gap:.4rem;align-items:center}.stages{display:flex;flex-wrap:wrap;gap:.3rem;margin-top:.4rem}.stage{display:inline-flex;align-items:center;gap:.3rem;font-size:.78rem;border:1px solid var(--line);border-radius:999px;padding:.05rem .5rem .05rem .25rem;background:var(--subtle)}.appr-line{display:inline-flex;flex-wrap:wrap;gap:.5rem;align-items:center}',
  '.dactions{margin:0 0 1rem}.rich hr{border:0;border-top:1px solid var(--line);margin:.75rem 0}.mrrow[data-mr]{cursor:pointer}.mrrow[data-mr]:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}',
  '.dtext.rich{white-space:normal;max-height:none;overflow:visible}.rich>:first-child{margin-top:0}.rich>:last-child{margin-bottom:0}.rich p{margin:.5rem 0}.rich h3,.rich h4,.rich h5,.rich h6{margin:1rem 0 .35rem;font-size:.92rem;font-weight:700}.rich h3{font-size:1rem}.rich ul,.rich ol{margin:.35rem 0;padding-left:1.3rem}.rich li{margin:.15rem 0}',
  '.rich code{font:.85em var(--mono);background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:0 .25rem}.rich pre{font:.8rem/1.45 var(--mono);background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:.6rem .75rem;overflow:auto;white-space:pre}.rich blockquote{margin:.5rem 0;padding:.1rem .75rem;border-left:3px solid var(--line-strong);color:var(--muted)}',
  '.rich .tbl{overflow-x:auto}.rich table{border-collapse:collapse;font-size:.82rem;margin:.5rem 0}.rich th,.rich td{border:1px solid var(--line);padding:.25rem .5rem;text-align:left;vertical-align:top}.rich th{background:var(--panel)}.rich a{overflow-wrap:anywhere}',
  '.lbl{display:inline-block;font-size:.75rem;background:var(--subtle);border:1px solid var(--line);border-radius:999px;padding:0 .5rem;margin:0 .2rem .2rem 0}.drawer .sk{height:12px;border-radius:4px;background:var(--subtle);margin:.6rem 0}',
  '.tl-new{animation:tl-new 1.6s var(--ease)}@keyframes tl-new{0%,30%{background:var(--run-bg)}100%{background:transparent}}',
  '.btn-sm{padding:.2rem .6rem;font-size:.82rem;width:auto}.btn-sm .di{width:14px;height:14px}.btn-sm[data-busy]::before{content:"";width:12px;height:12px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:tl-spin .7s linear infinite}.btn-sm[data-busy] .di{display:none}',
  '.mrlist .empty{display:none}.dash[data-nodraft="1"] .mrrow[data-f~=draft]{display:none}.chips-sep{flex:1}',
  '.chips .toggle[aria-pressed=true]{background:var(--run-bg);color:var(--run);border-color:var(--run)}',
  '.dash[data-mrf=review] .mrrow:not([data-f~=review]),.dash[data-mrf=mine] .mrrow:not([data-f~=mine]),.dash[data-mrf=human] .mrrow:not([data-f~=human]),.dash[data-mrf=bots] .mrrow:not([data-f~=bots]){display:none}',
  '.dash[data-mrf=review] .mrlist:not(:has([data-f~=review])) .only-review,.dash[data-mrf=mine] .mrlist:not(:has([data-f~=mine])) .only-mine,.dash[data-mrf=human] .mrlist:not(:has([data-f~=human])) .only-human,.dash[data-mrf=bots] .mrlist:not(:has([data-f~=bots])) .only-bots{display:block}',
  '.sbar{display:flex;height:6px;margin:.85rem 1rem 0;border-radius:3px;background:var(--line);overflow:hidden}.sbar i{display:block;height:100%;transition:width .6s var(--ease)}.s-rev{background:var(--ok)}.s-prog{background:var(--run)}.s-todo{background:var(--line-strong)}',
  '.slegend{display:flex;flex-wrap:wrap;gap:.2rem 1rem;margin:.4rem 1rem 0;font-size:.78rem;color:var(--muted)}.slegend span{display:inline-flex;gap:.35rem;align-items:center}.slegend i{width:8px;height:8px;border-radius:2px;display:inline-block}',
  '.box-sprint .box-body{display:flex;flex-direction:column}.box-sprint .board{flex:1 1 auto}.board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.6rem;padding:.75rem 1rem 1rem}.col{background:var(--subtle);border-radius:8px;padding:.5rem;min-width:0}',
  '.col h4{margin:0 0 .45rem;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);display:flex;justify-content:space-between;padding:.1rem .2rem}.col ul{display:grid;gap:.4rem}',
  '.tk{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:.5rem .55rem;font-size:.82rem;display:grid;gap:.25rem;transition:transform .15s,box-shadow .15s}.tk:hover{transform:translateY(-1px);box-shadow:var(--shadow)}.tk.mine .who{color:var(--text)}.tk.mine .who .av{border-radius:50%;box-shadow:0 0 0 1.5px var(--panel),0 0 0 3px var(--run);margin-right:.5rem}',
  '.tk .key{font:.72rem var(--mono);color:var(--muted);display:flex;justify-content:space-between;gap:.4rem}.tk .key a{white-space:nowrap;flex:none}.tk .key span{font-family:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.tk .sum{overflow-wrap:anywhere}.tk .who{display:flex;align-items:center;gap:.1rem;color:var(--muted);font-size:.75rem}.tk .who .av{width:16px;height:16px}',
  '.none{color:var(--muted);font-size:.8rem;padding:.3rem .2rem}',
  '.al{display:grid;grid-template-columns:auto minmax(0,1fr);gap:.6rem;align-items:center;padding:.6rem 1rem;border-top:1px solid var(--line)}.al:first-child{border-top:0}.al b{display:block;font-size:.86rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.al b a{color:var(--text)}.al small{color:var(--muted)}.al.acked{opacity:.6}',
  '.prio{font:700 .72rem var(--mono);border-radius:4px;padding:.05rem .35rem;background:var(--draft-bg);color:var(--draft)}.prio-p1,.prio-p2{background:var(--closed-bg);color:var(--closed)}.prio-p3{background:var(--warn-bg);color:var(--warn)}',
  '.duty-who{display:flex;flex-wrap:wrap;align-items:center;gap:.2rem .7rem}.duty-p{display:inline-flex;align-items:center}.duty-p .av{width:22px;height:22px;margin-right:.45rem}.duty{border-top:1px solid var(--line);background:var(--subtle);padding:.4rem 0}.duty li{display:flex;gap:.55rem;align-items:center;padding:.3rem 1rem;font-size:.86rem}.duty small{color:var(--muted)}',
  '.mlist .day{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:.6rem 1rem .2rem}',
  '.mt{display:grid;grid-template-columns:3.2rem minmax(0,1fr) auto;gap:.6rem;align-items:center;padding:.5rem 1rem}.mt time{font:.8rem var(--mono);color:var(--muted);font-variant-numeric:tabular-nums}.mt b{display:block;font-size:.86rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mt small{color:var(--muted)}',
  '.mt.now{background:var(--run-bg)}.mt.now time{color:var(--run);font-weight:700}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}',
  '.tabbar{display:none}',
  '.toasts{position:fixed;z-index:30;right:max(1rem,env(safe-area-inset-right,0px));bottom:calc(1rem + env(safe-area-inset-bottom,0px));display:grid;gap:.5rem;justify-items:end;pointer-events:none}',
  '.toast{pointer-events:auto;background:var(--bar);color:var(--bar-text);padding:.6rem .85rem;border-radius:8px;box-shadow:var(--shadow-lg);font-weight:500;max-width:min(360px,calc(100vw - 2rem));animation:tl-toast .4s var(--spring)}.toast.out{opacity:0;transform:translateX(24px);transition:opacity .3s,transform .3s}',
  '@keyframes tl-toast{from{opacity:0;transform:translateY(12px) scale(.96)}to{opacity:1;transform:none}}',
  // one section at a time when a section is picked; everything on the overview
  '.dash:not([data-view=overview]) .stats{display:none}.dash[data-view=mrs] .box:not([data-sec=mrs]),.dash[data-view=sprint] .box:not([data-sec=sprint]),.dash[data-view=alerts] .box:not([data-sec=alerts]),.dash[data-view=meetings] .box:not([data-sec=meetings]){display:none}',
  '.dash:not([data-view=overview]) .box{height:auto!important}.dash:not([data-view=overview]) .lcol-rs,.dash:not([data-view=overview]) .tools,.dash:not([data-view=overview]) .rs{display:none}',
    '@media (max-width:68rem){.lrow{flex-direction:column}.lcol{flex:none}.box{height:auto!important}.lcol-rs{display:none!important}.tools .grip,.rs{display:none!important}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}}',
  '@media (max-width:48rem){.dash,.dash.collapsed{grid-template-columns:1fr;background:none}.side{display:none}.dmain{padding:1rem max(1rem,env(safe-area-inset-right,0px)) 5.5rem max(1rem,env(safe-area-inset-left,0px))}',
  '.board{grid-template-columns:repeat(3,minmax(11rem,1fr));overflow-x:auto;scroll-snap-type:x mandatory}.col{scroll-snap-align:start}.mrside .appr-badge{display:none}',
  '.tabbar{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:20;background:var(--panel);border-top:1px solid var(--line);padding:.3rem max(.25rem,env(safe-area-inset-right,0px)) calc(.3rem + env(safe-area-inset-bottom,0px)) max(.25rem,env(safe-area-inset-left,0px))}',
  '.tabbar button{flex:1;flex-direction:column;gap:.1rem;font-size:.68rem;color:var(--muted);padding:.3rem 0;position:relative;text-align:center;justify-content:center}.tabbar button[aria-current=true]{color:var(--accent)}.tabbar .di{width:20px;height:20px}',
  '.tabbar .badge{position:absolute;top:0;left:calc(50% + 4px);margin:0;font-size:.6rem;padding:0 .3rem}.toasts{bottom:calc(4.75rem + env(safe-area-inset-bottom,0px))}}',
  '@media (max-width:30rem){.stats{gap:.5rem}.stat{padding:.65rem .75rem}.stat .v{font-size:1.4rem}}',
].join('');

/**
 * The page script: switches sections and merge request filters, refreshes the sections every minute while the
 * page is visible, and sends an inline approval as ONE background POST (never repeated; a lost answer is reported
 * as such). It only puts the server's escaped HTML into the page.
 */
export function dashboardScript(dashPath) {
  const B = JSON.stringify(dashPath);
  return `(function(){var B=${B},d=document.getElementById('dash');if(!d)return;var csrf=document.getElementById('dash-csrf'),busy=0;
function theme(t){var root=document.documentElement,sec=location.protocol==='https:'?'; Secure':'';if(t==='light'||t==='dark'){root.setAttribute('data-theme',t);document.cookie='tl_theme='+t+'; Path=/; Max-Age=31536000; SameSite=Lax'+sec}else{root.removeAttribute('data-theme');document.cookie='tl_theme=; Path=/; Max-Age=0; SameSite=Lax'+sec}document.querySelectorAll('[data-theme-set]').forEach(function(b){b.setAttribute('aria-pressed',String(b.getAttribute('data-theme-set')===(t==='light'||t==='dark'?t:'auto')))})}
function nodraft(on){d.setAttribute('data-nodraft',on?'1':'0');try{localStorage.setItem('tl-nodraft',on?'1':'0')}catch(e){}mark()}
function mark(){document.querySelectorAll('[data-nodraft-toggle]').forEach(function(b){b.setAttribute('aria-pressed',String(d.getAttribute('data-nodraft')==='1'))});var v=d.getAttribute('data-view'),f=d.getAttribute('data-mrf');document.querySelectorAll('[data-view-to]').forEach(function(b){if(b.closest('.side,.tabbar'))b.setAttribute('aria-current',String(b.getAttribute('data-view-to')===v))});document.querySelectorAll('[data-mrf-to]').forEach(function(b){b.setAttribute('aria-pressed',String(b.getAttribute('data-mrf-to')===f))})}
function toast(t){var r=document.getElementById('toasts');if(!r||!t)return;var e=document.createElement('div');e.className='toast';e.textContent=t;r.appendChild(e);setTimeout(function(){e.classList.add('out');setTimeout(function(){e.remove()},320)},3600)}
function view(v){d.setAttribute('data-view',v);mark();try{sessionStorage.setItem('tl-view',v)}catch(e){}window.scrollTo({top:0,behavior:'smooth'})}
var tk=null;
function colCount(c){var n=c.querySelectorAll('.tk').length,s=c.querySelector('[data-col-count]');if(s)s.textContent=n;var ul=c.querySelector('ul'),none=ul&&ul.querySelector('.none');if(n&&none)none.remove()}
d.addEventListener('pointerdown',function(e){if(editing()||e.button>0||tk)return;var t=e.target.closest&&e.target.closest('.tk[data-issue]');if(!t||!t.closest('[data-col]'))return;tk={t:t,x:e.clientX,y:e.clientY,on:false,pid:e.pointerId}});
d.addEventListener('pointermove',function(e){if(!tk)return;var t=tk.t;if(!tk.on){if(Math.abs(e.clientX-tk.x)+Math.abs(e.clientY-tk.y)<6)return;var r=t.getBoundingClientRect(),ph=mk('tk-ph');ph.style.height=r.height+'px';tk.from=t.closest('[data-col]');tk.list=t.parentNode;tk.index=arr(tk.list.children).indexOf(t);t.parentNode.insertBefore(ph,t);tk.ph=ph;tk.on=true;tk.dx=tk.x-r.left;tk.dy=tk.y-r.top;t.style.width=r.width+'px';t.style.left=r.left+'px';t.style.top=r.top+'px';t.classList.add('lifted-tk');d.appendChild(t);d.classList.add('layouting');try{t.setPointerCapture(tk.pid)}catch(x){}}
autoAt(e.clientY);t.style.left=(e.clientX-tk.dx)+'px';t.style.top=(e.clientY-tk.dy)+'px';var col=null;d.querySelectorAll('[data-col]').forEach(function(c){if(inRect(c.getBoundingClientRect(),e.clientX,e.clientY))col=c});if(!col)return;d.querySelectorAll('.col.drop-here').forEach(function(x){if(x!==col)x.classList.remove('drop-here')});if(col!==tk.from)col.classList.add('drop-here');var ul=col.querySelector('ul'),items=arr(ul.querySelectorAll('.tk')).filter(function(x){return x!==t}),ref=null;for(var i=0;i<items.length;i++){var ir=items[i].getBoundingClientRect();if(e.clientY<ir.top+ir.height/2){ref=items[i];break}}var cur=tk.ph.nextSibling;while(cur&&cur===t)cur=cur.nextSibling;if(tk.ph.parentNode===ul&&cur===ref)return;var none=ul.querySelector('.none');if(none)none.hidden=true;ul.insertBefore(tk.ph,ref)});
function tkDrop(){if(!tk)return;var m=tk;tk=null;asp=0;if(!m.on)return;if(!online()){m.t.classList.remove('lifted-tk');['left','top','width'].forEach(function(p){m.t.style[p]=''});m.ph.parentNode.insertBefore(m.t,m.ph);m.ph.remove();d.classList.remove('layouting');d.querySelectorAll('.col.drop-here').forEach(function(x){x.classList.remove('drop-here')});toast('You are offline. Move the ticket again once you are back online.');return}var t=m.t,to=m.ph.closest('[data-col]'),pr=m.ph.getBoundingClientRect();t.dataset.dragged='1';setTimeout(function(){delete t.dataset.dragged},60);t.style.transition='left .16s var(--ease),top .16s var(--ease)';t.style.left=pr.left+'px';t.style.top=pr.top+'px';setTimeout(function(){m.ph.parentNode.insertBefore(t,m.ph);m.ph.remove();t.classList.remove('lifted-tk');['transition','left','top','width'].forEach(function(p){t.style[p]=''});d.classList.remove('layouting');d.querySelectorAll('.col.drop-here').forEach(function(x){x.classList.remove('drop-here')});d.querySelectorAll('.board .none[hidden]').forEach(function(x){x.hidden=false});colCount(to);colCount(m.from);if(to===m.from)return;function back(){m.list.insertBefore(t,m.list.children[m.index]||null);colCount(to);colCount(m.from)}busy++;var body=new URLSearchParams();body.set('csrf',csrf.value);body.set('key',t.getAttribute('data-issue'));body.set('to',to.getAttribute('data-col'));
fetch(B+'/move',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:body.toString()}).then(function(r){return r.json().catch(function(){return {status:'failed',text:'The answer could not be read. Reload the board.'}})}).then(function(r){if(r.status==='moved')t.classList.add('moved');else flip(back);toast(r.text)}).catch(function(){back();toast('The connection was lost. Reload the board to see where the ticket is now.')}).then(function(){busy--;setTimeout(refresh,800)})},170)}
d.addEventListener('pointerup',tkDrop);d.addEventListener('pointercancel',tkDrop);
var dr=d.querySelector('[data-drawer]'),dlast=null,dreq=0;
function closeDetail(){if(!dr||dr.hidden)return;dr.hidden=true;document.body.style.overflow='';if(dlast&&dlast.focus)dlast.focus()}
function openDetail(el){if(!dr)return;var issue=el.getAttribute('data-issue'),alertId=el.getAttribute('data-alert'),mrk=el.getAttribute('data-mr'),n=++dreq;dlast=el;var t=dr.querySelector('#drawer-title'),body=dr.querySelector('[data-drawer-body]');var lk=dr.querySelector('[data-drawer-link]');if(lk){lk.hidden=true;lk.removeAttribute('href')}t.textContent=issue||mrk||'Alert';body.innerHTML='<div class="sk" style="width:60%"></div><div class="sk" style="width:85%"></div><div class="sk" style="width:40%"></div><div class="sk" style="height:120px"></div>';dr.hidden=false;document.body.style.overflow='hidden';var c=dr.querySelector('.drawer-panel [data-drawer-close]');if(c)c.focus();
var q=mrk?'/mr?ref='+encodeURIComponent(mrk):issue?'/issue?key='+encodeURIComponent(issue):'/alert?id='+encodeURIComponent(alertId);fetch(B+q,{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(x){if(n!==dreq)return;if(!x){body.innerHTML='';var p=document.createElement('p');p.className='note';p.textContent='Could not load the details right now.';body.appendChild(p);return}t.textContent=x.title||'';body.innerHTML=x.html||'';if(lk&&x.url&&/^https?:/.test(x.url)){lk.href=x.url;lk.title=x.urlLabel||'Open';lk.setAttribute('aria-label',x.urlLabel||'Open');lk.hidden=false}}).catch(function(){if(n===dreq)body.textContent='Could not load the details right now.'})}
d.addEventListener('keydown',function(e){if(e.key==='Escape'&&dr&&!dr.hidden){closeDetail();return}if(e.key==='Escape'&&editing()&&!mv&&!rz){setEdit(false);return}var el=e.target;if((e.key==='Enter'||e.key===' ')&&el&&el.matches&&el.matches('[role=button][data-issue],[role=button][data-alert],.mrrow[data-mr]')){e.preventDefault();openDetail(el)}});
function collapse(on){d.classList.toggle('collapsed',on);var c=document.querySelector('[data-collapse]');if(c){c.setAttribute('aria-expanded',String(!on));c.title=on?'Expand sidebar':'Collapse sidebar'}try{localStorage.setItem('tl-side',on?'1':'0')}catch(e){}}
try{if(localStorage.getItem('tl-side')==='1'){d.style.transition='none';collapse(true);requestAnimationFrame(function(){requestAnimationFrame(function(){d.style.transition=''})})}}catch(e){}
var L=d.querySelector('[data-layout]'),LK='tl-layout2',DEFL=null,BOX={};try{DEFL=JSON.parse(L.getAttribute('data-default'))}catch(e){}
if(L)L.querySelectorAll('[data-sec]').forEach(function(b){BOX[b.getAttribute('data-sec')]=b});
function arr(x){return Array.prototype.slice.call(x)}
function boxes(){return L?arr(L.querySelectorAll('[data-sec]')):[]}
function rowsEl(){return L?arr(L.children).filter(function(n){return n.classList.contains('lrow')}):[]}
function colsOf(r){return arr(r.children).filter(function(n){return n.classList.contains('lcol')})}
function cardsOf(c){return arr(c.children).filter(function(n){return n.hasAttribute&&n.hasAttribute('data-sec')})}
function wOf(c){return +(c.style.getPropertyValue('--w'))||4}
function mk(cls){var e=document.createElement('div');e.className=cls;return e}
function markFill(){var rs=rowsEl();rs.forEach(function(r,i){r.classList.toggle('lrow-last',i===rs.length-1)});rs.forEach(function(r){colsOf(r).forEach(function(c){var vis=cardsOf(c).filter(function(b){return !b.classList.contains('is-hidden')&&!b.classList.contains('lifted')});cardsOf(c).forEach(function(b){b.classList.toggle('fill',b===vis[vis.length-1])})})})}
function decorate(){rowsEl().forEach(function(r){colsOf(r).forEach(function(c){var live=arr(c.children).some(function(x){return (x.hasAttribute('data-sec')&&!x.classList.contains('lifted'))||x.classList.contains('box-ph')});if(!live&&!c.querySelector('.lifted'))c.remove();else c.classList.toggle('lcol-empty',!live)});if(!colsOf(r).length)r.remove()});L.querySelectorAll('[data-col-resize]').forEach(function(h){h.remove()});rowsEl().forEach(function(r){var cs=colsOf(r).filter(function(c){return !c.classList.contains('lcol-empty')});cs.forEach(function(c,i){if(i<cs.length-1){var h=document.createElement('span');h.className='lcol-rs';h.setAttribute('data-col-resize','');h.title='Drag to change the column widths, double-click to even them out';c.appendChild(h)}})});markFill()}
function snap(){var h={},hid=[];boxes().forEach(function(b){var k=b.getAttribute('data-sec');if(b.style.height)h[k]=parseInt(b.style.height,10);if(b.classList.contains('is-hidden'))hid.push(k)});return {rows:rowsEl().map(function(r){return {cols:colsOf(r).map(function(c){return {w:wOf(c),cards:cardsOf(c).map(function(b){return b.getAttribute('data-sec')})}}).filter(function(c){return c.cards.length})}}).filter(function(r){return r.cols.length}),height:h,hidden:hid}}
var hseen=null;
function hbar(){var bar=d.querySelector('[data-hidden-bar]');if(!bar)return;var hs=boxes().filter(function(b){return b.classList.contains('is-hidden')}),before=hseen;hseen={};hs.forEach(function(b){hseen[b.getAttribute('data-sec')]=1});bar.textContent='';if(!hs.length){bar.hidden=true;return}bar.hidden=false;var lab=document.createElement('span');lab.textContent='Hidden:';bar.appendChild(lab);hs.forEach(function(b){var t=document.createElement('button');t.type='button';t.setAttribute('data-unhide',b.getAttribute('data-sec'));t.title='Show this card again';var h=b.querySelector('h2');t.textContent=h?h.textContent:b.getAttribute('data-sec');if(before&&!before[b.getAttribute('data-sec')])t.classList.add('wiggle');bar.appendChild(t)})}
function saveL(){markFill();var l=snap(),custom=JSON.stringify(l.rows)!==JSON.stringify(DEFL&&DEFL.rows)||Object.keys(l.height).length||l.hidden.length;try{if(custom)localStorage.setItem(LK,JSON.stringify(l));else localStorage.removeItem(LK)}catch(e){}hbar();var r=document.querySelector('[data-layout-reset]');if(r)r.disabled=!custom}
function readL(){try{var l=JSON.parse(localStorage.getItem(LK)||'null');return l&&Array.isArray(l.rows)?l:null}catch(e){return null}}
function build(rows){var used={},out=[];(rows||[]).forEach(function(r){var re=mk('lrow');(r.cols||[]).forEach(function(c){var ce=mk('lcol'),w=+c.w;ce.style.setProperty('--w',String(w>0&&w<=24?w:4));(c.cards||[]).forEach(function(k){if(BOX[k]&&!used[k]){used[k]=1;ce.appendChild(BOX[k])}});if(ce.children.length)re.appendChild(ce)});if(re.children.length)out.push(re)});Object.keys(BOX).forEach(function(k){if(used[k])return;var re=mk('lrow'),ce=mk('lcol');ce.style.setProperty('--w','12');ce.appendChild(BOX[k]);re.appendChild(ce);out.push(re)});L.textContent='';out.forEach(function(r){L.appendChild(r)});decorate()}
function applyL(l){if(!L)return;build(l?l.rows:(DEFL&&DEFL.rows));boxes().forEach(function(b){var k=b.getAttribute('data-sec'),h=l&&l.height&&+l.height[k];b.style.height=h>=120&&h<=4000?h+'px':'';b.classList.toggle('is-hidden',!!(l&&Array.isArray(l.hidden)&&l.hidden.indexOf(k)>=0))});hbar();var r=document.querySelector('[data-layout-reset]');if(r)r.disabled=!l}
applyL(readL());
function wide(){return window.matchMedia('(min-width:68.01rem)').matches&&d.getAttribute('data-view')==='overview'}
function editing(){return d.classList.contains('editing')}
function setEdit(on){d.classList.toggle('editing',on);document.querySelectorAll('[data-edit-toggle]').forEach(function(t){t.setAttribute('aria-pressed',String(on))});if(on&&d.getAttribute('data-view')!=='overview')view('overview')}
function flip(fn){var bs=boxes().filter(function(b){return !b.classList.contains('lifted')}),r={};bs.forEach(function(b){r[b.getAttribute('data-sec')]=b.getBoundingClientRect()});fn();bs.forEach(function(b){var o=r[b.getAttribute('data-sec')],n=b.getBoundingClientRect();if(!o||!n.width)return;var dx=o.left-n.left,dy=o.top-n.top;if(!dx&&!dy)return;b.style.transition='none';b.style.transform='translate('+dx+'px,'+dy+'px)';requestAnimationFrame(function(){requestAnimationFrame(function(){b.style.transition='transform .25s var(--ease)';b.style.transform='';setTimeout(function(){b.style.transition=''},270)})})})}
function nextCard(n){n=n.nextSibling;while(n&&!(n.hasAttribute&&n.hasAttribute('data-sec')&&!n.classList.contains('lifted')))n=n.nextSibling;return n}
var mv=null;
function unsplit(){if(mv&&mv.split){mv.split.col.style.setProperty('--w',String(mv.split.w0));mv.split=null}}
function placeIn(col,ref){if(mv.ph.parentNode===col&&nextCard(mv.ph)===ref)return;flip(function(){unsplit();col.insertBefore(mv.ph,ref||null);decorate()})}
function placeCol(row,col,side){var cs=colsOf(row),i=cs.indexOf(col),nb=side==='before'?cs[i-1]:cs[i+1],pc=mv.ph.parentNode;if(nb&&nb===pc&&pc.classList.contains('lcol-new'))return;flip(function(){unsplit();var nc=mk('lcol lcol-new'),alone=mv.src!==col&&!cardsOf(mv.src).some(function(x){return x!==mv.b});if(alone){nc.style.setProperty('--w',String(wOf(mv.src)))}else{var w0=wOf(col),nw=Math.max(2,Math.round(w0/2*2)/2);nc.style.setProperty('--w',String(nw));col.style.setProperty('--w',String(Math.max(2,w0-nw)));mv.split={col:col,w0:w0}}nc.appendChild(mv.ph);row.insertBefore(nc,side==='before'?col:col.nextSibling);decorate()})}
function placeRow(before){var pr=mv.ph.parentNode&&mv.ph.parentNode.parentNode;if(pr&&pr.classList.contains('lrow-new')&&pr.nextSibling===before)return;flip(function(){unsplit();var nr=mk('lrow lrow-new'),nc=mk('lcol lcol-new');nc.style.setProperty('--w','12');nc.appendChild(mv.ph);nr.appendChild(nc);L.insertBefore(nr,before||null);decorate()})}
function inRect(r,x,y){return x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom}
d.addEventListener('pointerdown',function(e){if(!editing()||!wide()||e.button>0||mv)return;var hd=e.target.closest&&e.target.closest('.box>header');if(!hd||e.target.closest('[data-hide]'))return;var b=hd.closest('[data-sec]');e.preventDefault();var r=b.getBoundingClientRect(),ph=mk('box-ph');ph.style.height=r.height+'px';b.parentNode.insertBefore(ph,b);mv={b:b,ph:ph,src:b.parentNode,dx:e.clientX-r.left,dy:e.clientY-r.top,h0:b.style.height,split:null};b.style.width=r.width+'px';b.style.height=r.height+'px';b.style.left=r.left+'px';b.style.top=r.top+'px';b.classList.add('lifted');d.classList.add('layouting');decorate();strips(true);try{hd.setPointerCapture(e.pointerId)}catch(x){}});
d.addEventListener('pointermove',function(e){if(!mv)return;autoAt(e.clientY);cardMove(e.clientX,e.clientY)});
function strips(on){L.querySelectorAll('.lstrip').forEach(function(x){x.remove()});if(!on)return;var rs=rowsEl();rs.concat([null]).forEach(function(r){var st=mk('lstrip');st.textContent='New row';L.insertBefore(st,r)})}
function nextRow(n){n=n.nextSibling;while(n&&!(n.classList&&n.classList.contains('lrow')))n=n.nextSibling;return n}
function cardMove(x,y){if(!mv)return;mv.x=x;mv.y=y;mv.b.style.left=(x-mv.dx)+'px';mv.b.style.top=(y-mv.dy)+'px';var st=null;L.querySelectorAll('.lstrip').forEach(function(s2){var on=inRect(s2.getBoundingClientRect(),x,y);s2.classList.toggle('hot',on);if(on)st=s2});if(st)return placeRow(nextRow(st));var t=null;boxes().forEach(function(b){if(b===mv.b||b.classList.contains('is-hidden'))return;if(inRect(b.getBoundingClientRect(),x,y))t=b});if(t){var r=t.getBoundingClientRect(),fx=(x-r.left)/r.width,col=t.parentNode,row=col.parentNode;if(fx<0.18)return placeCol(row,col,'before');if(fx>0.82)return placeCol(row,col,'after');return placeIn(col,(y-r.top)/r.height<0.5?t:nextCard(t))}if(inRect(mv.ph.getBoundingClientRect(),x,y))return;var rows=rowsEl(),c=null;rows.forEach(function(rw){colsOf(rw).forEach(function(cl){if(!cl.classList.contains('lcol-empty')&&inRect(cl.getBoundingClientRect(),x,y))c=cl})});if(c)return placeIn(c,null);if(!rows.length)return placeRow(null);if(y<rows[0].getBoundingClientRect().top)return placeRow(rows[0]);var last=rows[rows.length-1].getBoundingClientRect();if(y>last.bottom)return placeRow(null);for(var i=1;i<rows.length;i++){var a=rows[i-1].getBoundingClientRect(),bb=rows[i].getBoundingClientRect();if(y>a.bottom&&y<bb.top)return placeRow(rows[i])}}
var asp=0,aloop=false;
function autoAt(y){var edge=72,h=window.innerHeight;asp=y<edge?-Math.ceil((edge-y)/3):y>h-edge?Math.ceil((y-(h-edge))/3):0;if(asp&&!aloop){aloop=true;requestAnimationFrame(autoStep)}}
function autoStep(){if(!asp||(!mv&&!(tk&&tk.on))){aloop=false;return}window.scrollBy(0,asp);if(mv)cardMove(mv.x,mv.y);requestAnimationFrame(autoStep)}
function drop(){if(!mv)return;var m=mv;mv=null;asp=0;var pr=m.ph.getBoundingClientRect();m.b.style.transition='left .18s var(--ease),top .18s var(--ease),width .18s var(--ease)';m.b.style.left=pr.left+'px';m.b.style.top=pr.top+'px';m.b.style.width=pr.width+'px';setTimeout(function(){m.ph.parentNode.insertBefore(m.b,m.ph);m.ph.remove();m.b.classList.remove('lifted');['transition','left','top','width'].forEach(function(p){m.b.style[p]=''});m.b.style.height=m.h0;L.querySelectorAll('.lcol-new,.lrow-new').forEach(function(n){n.classList.remove('lcol-new','lrow-new')});strips(false);d.classList.remove('layouting');decorate();saveL()},190)}
d.addEventListener('pointerup',drop);d.addEventListener('pointercancel',drop);
d.addEventListener('keydown',function(e){var g=e.target.closest&&e.target.closest('[data-grip]');if(!g||!wide()||!editing())return;var b=g.closest('[data-sec]'),col=b.parentNode,row=col.parentNode,cards=cardsOf(col),i=cards.indexOf(b),cs=colsOf(row),ci=cs.indexOf(col);if(e.key==='ArrowUp'){if(i>0)flip(function(){col.insertBefore(b,cards[i-1])})}else if(e.key==='ArrowDown'){if(i<cards.length-1)flip(function(){col.insertBefore(b,cards[i+1].nextSibling)})}else if(e.key==='ArrowLeft'){if(ci>0)flip(function(){cs[ci-1].appendChild(b)})}else if(e.key==='ArrowRight'){if(ci<cs.length-1)flip(function(){cs[ci+1].appendChild(b)})}else return;e.preventDefault();decorate();g.focus();saveL()});
var rz=null,cz=null;
d.addEventListener('pointerdown',function(e){if(!wide()||!editing()||e.button>0)return;var h=e.target.closest&&e.target.closest('[data-resize]');var ch=e.target.closest&&e.target.closest('[data-col-resize]');if(!h&&!ch)return;e.preventDefault();e.stopPropagation();if(h){var b=h.closest('[data-sec]'),c=b.parentNode,vis=colsOf(c.parentNode).filter(function(x){return !x.classList.contains('lcol-empty')}),i=vis.indexOf(c),rc=c.getBoundingClientRect();rz={b:b,top:b.getBoundingClientRect().top,cz:null};if(vis[i+1]){var rn=vis[i+1].getBoundingClientRect();rz.cz={c:c,n:vis[i+1],left:rc.left,span:rn.right-rc.left,total:wOf(c)+wOf(vis[i+1]),x0:null}}else if(vis[i-1]){var rp=vis[i-1].getBoundingClientRect();rz.cz={c:vis[i-1],n:c,left:rp.left,span:rc.right-rp.left,total:wOf(vis[i-1])+wOf(c),x0:e.clientX,b0:rc.left}}b.classList.add('resizing')}else{var c=ch.parentNode,cs=colsOf(c.parentNode).filter(function(x){return !x.classList.contains('lcol-empty')}),n=cs[cs.indexOf(c)+1];if(!n)return;var rc=c.getBoundingClientRect(),rn=n.getBoundingClientRect();cz={c:c,n:n,left:rc.left,span:rn.right-rc.left,total:wOf(c)+wOf(n)};c.classList.add('resizing-col')}d.classList.add('layouting');try{(h||ch).setPointerCapture(e.pointerId)}catch(x){}},true);
d.addEventListener('pointermove',function(e){if(rz){rz.b.style.height=Math.max(120,Math.round(e.clientY-rz.top))+'px';var z=rz.cz;if(z){var edge=z.x0===null?e.clientX:z.b0-(e.clientX-z.x0),f=Math.max(0.15,Math.min(0.85,(edge-z.left)/z.span)),wc=Math.round(z.total*f*2)/2;z.c.style.setProperty('--w',String(wc));z.n.style.setProperty('--w',String(Math.round((z.total-wc)*2)/2))}}if(cz){var f=Math.max(0.15,Math.min(0.85,(e.clientX-cz.left)/cz.span)),wc=Math.round(cz.total*f*2)/2;cz.c.style.setProperty('--w',String(wc));cz.n.style.setProperty('--w',String(Math.round((cz.total-wc)*2)/2))}});
function endRz(){if(!rz&&!cz)return;if(rz)rz.b.classList.remove('resizing');if(cz)cz.c.classList.remove('resizing-col');rz=null;cz=null;d.classList.remove('layouting');saveL()}
d.addEventListener('pointerup',endRz);d.addEventListener('pointercancel',endRz);
d.addEventListener('dblclick',function(e){if(!editing())return;var h=e.target.closest&&e.target.closest('[data-resize]');if(h){h.closest('[data-sec]').style.height='';saveL();return}var ch=e.target.closest&&e.target.closest('[data-col-resize]');if(ch){var c=ch.parentNode,cs=colsOf(c.parentNode),n=cs[cs.indexOf(c)+1];if(n){var t=wOf(c)+wOf(n);c.style.setProperty('--w',String(t/2));n.style.setProperty('--w',String(t/2));saveL()}}});
try{if(localStorage.getItem('tl-nodraft')==='1')d.setAttribute('data-nodraft','1')}catch(e){}
try{var sv=sessionStorage.getItem('tl-view'),sf=sessionStorage.getItem('tl-mrf');if(sv)d.setAttribute('data-view',sv);if(sf)d.setAttribute('data-mrf',sf)}catch(e){}if(location.hash==='#overview'){d.setAttribute('data-view','overview');try{history.replaceState(null,'',location.pathname)}catch(e){}}mark();
document.addEventListener('click',function(e){document.querySelectorAll('[data-account-menu][open]').forEach(function(m){if(!m.contains(e.target))m.removeAttribute('open')})});document.addEventListener('keydown',function(e){if(e.key==='Escape')document.querySelectorAll('[data-account-menu][open]').forEach(function(m){m.removeAttribute('open')})});
document.addEventListener('click',function(e){var h=e.target.closest('[data-home]');if(h){e.preventDefault();view('overview');return}var rf=e.target.closest('[data-refresh]');if(rf){refresh();return}var mrr=e.target.closest('.mrrow[data-mr]');if(mrr&&!e.target.closest('a,button')){openDetail(mrr);return}var di=e.target.closest('[data-issue],[data-alert]');if(di&&di.dataset.dragged)return;if(di&&!e.target.closest('a')){e.preventDefault();openDetail(di);return}if(e.target.closest('[data-drawer-close]')){closeDetail();return}var th=e.target.closest('[data-theme-set]');if(th){theme(th.getAttribute('data-theme-set'));return}if(e.target.closest('[data-nodraft-toggle]')){nodraft(d.getAttribute('data-nodraft')!=='1');return}if(e.target.closest('[data-edit-toggle]')){setEdit(!editing());return}if(e.target.closest('[data-edit-done]')){setEdit(false);return}var hd=e.target.closest('[data-hide]');if(hd){var hb=hd.closest('[data-sec]');hb.classList.add('is-hidden');saveL();toast('Card hidden. Show it again from the toolbar above the cards.');return}var uh=e.target.closest('[data-unhide]');if(uh){var ub=d.querySelector('[data-sec="'+uh.getAttribute('data-unhide')+'"]');if(ub)ub.classList.remove('is-hidden');saveL();return}var lr=e.target.closest('[data-layout-reset]');if(lr){try{localStorage.removeItem(LK)}catch(x){}applyL(null);toast('Layout reset');return}var t=e.target.closest('[data-collapse]');if(t){collapse(!d.classList.contains('collapsed'));return}var v=e.target.closest('[data-view-to]');if(v){var vf=v.getAttribute('data-mrf-set');if(vf){d.setAttribute('data-mrf',vf);try{sessionStorage.setItem('tl-mrf',vf)}catch(e){}}view(v.getAttribute('data-view-to'));return}var f=e.target.closest('[data-mrf-to]');if(f){d.setAttribute('data-mrf',f.getAttribute('data-mrf-to'));mark();try{sessionStorage.setItem('tl-mrf',f.getAttribute('data-mrf-to'))}catch(e){}return}var a=e.target.closest('[data-approve]');if(a)approve(a)});
function pill(cls,text,title){var s=document.createElement('span');s.className='pill '+cls;s.textContent=text;if(title)s.title=title;return s}
function approve(b){if(b.disabled)return;if(!online()){toast('You are offline. Approve again once you are back online.');return}b.disabled=true;b.setAttribute('data-busy','');busy++;var body=new URLSearchParams();body.set('csrf',csrf.value);body.set('project',b.getAttribute('data-project'));body.set('iid',b.getAttribute('data-iid'));body.set('sha',b.getAttribute('data-sha'));
fetch(B+'/approve',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:body.toString()}).then(function(r){return r.json().catch(function(){return {status:'unknown',text:'The answer could not be read. Check the merge request in GitLab.'}})}).then(function(r){var ok=r.status==='approved'||r.status==='already';b.replaceWith(ok?pill('pill-ok','Approved',r.text):r.status==='unknown'?pill('pill-idle','Check GitLab',r.text):pill('pill-bad','Not approved',r.text));toast(r.text)}).catch(function(){b.replaceWith(pill('pill-idle','Check GitLab'));toast('The connection was lost. Nothing is repeated automatically: check the merge request in GitLab.')}).then(function(){busy--;setTimeout(refresh,1500)})}
function refresh(){if(document.hidden||busy)return;var rb=document.querySelector('[data-refresh]');if(rb)rb.classList.add('busy');fetch(B+'/data',{credentials:'same-origin',cache:'no-store'}).then(function(r){net(!r.headers.get('X-TL-From-Cache')&&r.status!==503);if(r.status===401){forget();var u=document.getElementById('dash-updated');if(u)u.textContent='Signed out';if(rb)rb.title='Signed out. Reload the page to sign in again.';return null}return r.ok?r.json():null}).then(function(x){if(!x||busy)return;var s=x.sections||{};for(var k in s){var e=document.querySelector('[data-sec-body="'+k+'"]');if(!e||e.innerHTML===s[k])continue;var old={};e.querySelectorAll('[data-key]').forEach(function(n){old[n.getAttribute('data-key')]=1});var had=Object.keys(old).length;e.innerHTML=s[k];if(had)e.querySelectorAll('[data-key]').forEach(function(n){if(!old[n.getAttribute('data-key')])n.classList.add('tl-new')})}var c=x.counts||{};for(var n in c){document.querySelectorAll('[data-count="'+n+'"]').forEach(function(el){el.textContent=c[n];el.hidden=!c[n]})}if(x.csrf){csrf.value=x.csrf;document.querySelectorAll('[data-csrf]').forEach(function(i){i.value=x.csrf})}var u=document.getElementById('dash-updated');if(u&&x.updated){u.textContent=x.updated;if(rb)rb.title='Updated '+x.updated+', refreshes every minute. Click to refresh now.'}mark()}).catch(function(){net(false)}).then(function(){if(rb)rb.classList.remove('busy')})}
var pal=document.querySelector('[data-palette]'),pin=pal&&pal.querySelector('[data-pal-in]'),plist=pal&&pal.querySelector('[data-pal-list]'),pall=[],pshow=[],psel=0,plast=null;
function palItems(){var it=[];[['overview','Overview'],['mrs','Merge requests'],['sprint','Sprint'],['alerts','Alerts'],['meetings','Meetings']].forEach(function(v){it.push({g:'Go to',i:v[0],t:v[1],run:function(){view(v[0])}})});
it.push({g:'Actions',i:'refresh',t:'Refresh now',run:function(){refresh()}});it.push({g:'Actions',i:'edit',t:editing()?'Finish customizing the layout':'Customize the layout',run:function(){setEdit(!editing())}});it.push({g:'Actions',i:'collapse',t:(d.classList.contains('collapsed')?'Expand':'Collapse')+' the sidebar',run:function(){collapse(!d.classList.contains('collapsed'))}});it.push({g:'Actions',i:'hide',t:(d.getAttribute('data-nodraft')==='1'?'Show':'Hide')+' draft merge requests',run:function(){nodraft(d.getAttribute('data-nodraft')!=='1')}});it.push({g:'Actions',i:'undo',t:'Reset the layout',run:function(){try{localStorage.removeItem(LK)}catch(x){}applyL(null);toast('Layout reset')}});
d.querySelectorAll('.mrrow[data-mr]').forEach(function(r){var t=r.querySelector('.tt');it.push({g:'Merge requests',i:'gitlab',t:t?t.textContent:'',s:r.getAttribute('data-mr'),run:function(){openDetail(r)}})});
d.querySelectorAll('.tk[data-issue]').forEach(function(r){var t=r.querySelector('.sum');it.push({g:'Sprint tickets',i:'jira',t:t?t.textContent:'',s:r.getAttribute('data-issue'),run:function(){openDetail(r)}})});
d.querySelectorAll('.al[data-alert]').forEach(function(r){var t=r.querySelector('b');it.push({g:'Alerts',i:'opsgenie',t:t?t.textContent:'',s:(r.querySelector('.prio')||{}).textContent||'',run:function(){openDetail(r)}})});return it}
function palRender(){var q=pin.value.toLowerCase().split(' ').filter(Boolean);pshow=pall.filter(function(i){var h=(i.t+' '+(i.s||'')+' '+i.g).toLowerCase();return q.every(function(w){return h.indexOf(w)>=0})}).slice(0,80);if(psel>=pshow.length)psel=Math.max(0,pshow.length-1);plist.textContent='';var g=null;if(!pshow.length){var n=document.createElement('li');n.className='none';n.textContent='Nothing matches.';plist.appendChild(n);return}pshow.forEach(function(i,k){if(i.g!==g){g=i.g;var h=document.createElement('li');h.className='grp';h.textContent=g;h.setAttribute('role','presentation');plist.appendChild(h)}var li=document.createElement('li');li.className='it';li.setAttribute('role','option');li.setAttribute('data-k',String(k));li.setAttribute('aria-selected',String(k===psel));var ic=i.i&&pal.querySelector('[data-pal-icons] [data-ico="'+i.i+'"]');if(ic){var c=ic.cloneNode(true);c.removeAttribute('data-ico');c.className='ico';li.appendChild(c)}var t=document.createElement('span');t.className='t';t.textContent=i.t;li.appendChild(t);if(i.s){var s2=document.createElement('span');s2.className='s';s2.textContent=i.s;li.appendChild(s2)}plist.appendChild(li)})}
function palMark(){plist.querySelectorAll('.it').forEach(function(li){var on=+li.getAttribute('data-k')===psel;li.setAttribute('aria-selected',String(on));if(on&&li.scrollIntoView)li.scrollIntoView({block:'nearest'})})}
function palOpen(){if(!pal)return;plast=document.activeElement;pall=palItems();psel=0;pin.value='';pal.hidden=false;palRender();pin.focus()}
function palClose(){if(!pal||pal.hidden)return;pal.hidden=true;if(plast&&plast.focus)plast.focus()}
function palRun(k){var i=pshow[k];if(!i)return;palClose();i.run()}
document.addEventListener('keydown',function(e){if((e.ctrlKey||e.metaKey)&&!e.altKey&&(e.key==='k'||e.key==='K')){e.preventDefault();if(pal&&pal.hidden)palOpen();else palClose()}});
if(pal){pin.addEventListener('input',function(){psel=0;palRender()});pin.addEventListener('keydown',function(e){if(e.key==='ArrowDown'){e.preventDefault();psel=Math.min(pshow.length-1,psel+1);palMark()}else if(e.key==='ArrowUp'){e.preventDefault();psel=Math.max(0,psel-1);palMark()}else if(e.key==='Enter'){e.preventDefault();palRun(psel)}else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();palClose()}});plist.addEventListener('click',function(e){var li=e.target.closest('.it');if(li)palRun(+li.getAttribute('data-k'))});plist.addEventListener('mousemove',function(e){var li=e.target.closest('.it');if(li&&+li.getAttribute('data-k')!==psel){psel=+li.getAttribute('data-k');palMark()}});pal.querySelector('[data-pal-close]').addEventListener('click',palClose)}
document.addEventListener('click',function(e){if(e.target.closest('[data-pal-open]')){e.preventDefault();palOpen()}});
var obar=d.querySelector('[data-offline-bar]');
function net(on){d.classList.toggle('is-offline',!on);if(obar)obar.hidden=on}
function online(){return navigator.onLine!==false}
window.addEventListener('online',function(){net(true);refresh()});window.addEventListener('offline',function(){net(false)});net(online());
if('serviceWorker' in navigator){try{navigator.serviceWorker.register(B+'/sw.js',{scope:B}).catch(function(){})}catch(e){}}
function forget(){try{if(navigator.serviceWorker&&navigator.serviceWorker.controller)navigator.serviceWorker.controller.postMessage('forget')}catch(e){}try{if(window.caches)caches.delete('tl-dashboard')}catch(e){}}
document.addEventListener('submit',function(e){if(e.target&&e.target.action&&e.target.action.indexOf('/signout')>=0)forget()});
setTimeout(refresh,1500);setInterval(refresh,60000);document.addEventListener('visibilitychange',function(){if(!document.hidden)refresh()})})();`;
}

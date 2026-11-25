import { approvalCountsOf } from './gitlab.mjs';

// Approval requests made with the visitor's short-lived, server-side OAuth token.
// Never retry a write or fall back to a service credential.
async function request(host, token, path, options = {}) {
  const response = await fetch(`https://${host}/api/v4/${path}`, {
    method: options.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const error = new Error(`GitLab returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/** Check the token's actual identity, MR head and the user's approval state. */
export async function userApprovalPreflight(host, record, session) {
  if (!session?.accessToken || !session?.user?.id) return { status: 'blocked', reason: 'Sign in with GitLab to approve.' };
  if (record.status !== 'open') return { status: 'blocked', reason: 'This approval link is no longer valid. Use the current card.' };
  const path = `projects/${encodeURIComponent(record.project)}/merge_requests/${encodeURIComponent(record.iid)}`;
  try {
    const [user, mr, approvals] = await Promise.all([
      request(host, session.accessToken, 'user'),
      request(host, session.accessToken, path),
      request(host, session.accessToken, `${path}/approvals`),
    ]);
    if (String(user.id) !== String(session.user.id)) return { status: 'blocked', reason: 'The signed-in GitLab account changed. Sign in again.' };
    const approvedBy = Array.isArray(approvals.approved_by) ? approvals.approved_by.map((a) => a.user?.name || a.user?.username || a.name || a.username).filter(Boolean) : [];
    const summary = { known: Array.isArray(approvals.approved_by), approved: approvals.approvals_required > 0 ? approvals.approved === true : approvedBy.length > 0, approvedBy, ...approvalCountsOf(approvals, approvedBy.length) };
    const context = { mr, user, approvals: summary };
    if (mr.state !== 'opened') return { status: 'blocked', ...context, reason: 'This merge request is no longer open.' };
    if (mr.draft || mr.work_in_progress || mr.detailed_merge_status === 'draft_status') return { status: 'blocked', ...context, reason: 'This merge request is a draft.' };
    if ((mr.sha || mr.diff_refs?.head_sha) !== record.sha) return { status: 'blocked', ...context, reason: 'The merge request changed. Review the updated card.' };
    if (!Array.isArray(approvals.approved_by)) return { status: 'blocked', ...context, reason: 'GitLab could not verify the approval state.' };
    const hasApproved = approvals.user_has_approved === true || approvals.approved_by.some((a) => String(a.user?.id ?? a.id) === String(user.id));
    if (hasApproved) return { status: 'already', ...context, tokenIndex: 'oauth' };
    if (approvals.user_can_approve === false) return { status: 'blocked', ...context, reason: 'GitLab does not allow you to approve this merge request.' };
    return { status: 'ready', ...context, tokenIndex: 'oauth' };
  } catch {
    return { status: 'blocked', reason: 'GitLab could not verify your identity and approval permissions. Sign in again or try later.' };
  }
}

/** Send exactly one approval pinned to the reviewed commit. */
export async function userApprovalWrite(host, record, session) {
  const path = `projects/${encodeURIComponent(record.project)}/merge_requests/${encodeURIComponent(record.iid)}/approve`;
  return request(host, session.accessToken, path, { method: 'POST', body: { sha: record.sha } });
}

/**
 * Whether the visitor may merge the merge request at exactly `record.sha` right now: `ready`, `already`
 * (merged at that head) or `blocked` with a reason. Only what GitLab reports as mergeable is offered.
 */
export async function userMergePreflight(host, record, session) {
  if (!session?.accessToken || !session?.user?.id) return { status: 'blocked', reason: 'Sign in with GitLab to merge.' };
  const path = `projects/${encodeURIComponent(record.project)}/merge_requests/${encodeURIComponent(record.iid)}`;
  try {
    const [user, mr] = await Promise.all([request(host, session.accessToken, 'user'), request(host, session.accessToken, path)]);
    if (String(user.id) !== String(session.user.id)) return { status: 'blocked', reason: 'The signed-in GitLab account changed. Sign in again.' };
    const head = mr.sha || mr.diff_refs?.head_sha;
    if (mr.state === 'merged') return head === record.sha ? { status: 'already', mr, user } : { status: 'blocked', mr, user, reason: 'It was merged at a different head commit.' };
    if (mr.state === 'locked') return { status: 'blocked', mr, user, reason: 'GitLab is merging it right now.' };
    if (mr.state !== 'opened') return { status: 'blocked', mr, user, reason: 'This merge request is no longer open.' };
    if (mr.draft || mr.work_in_progress || mr.detailed_merge_status === 'draft_status') return { status: 'blocked', mr, user, reason: 'This merge request is a draft.' };
    if (head !== record.sha) return { status: 'blocked', mr, user, reason: 'The merge request changed (new commits). Review it again.' };
    if (mr.user?.can_merge === false) return { status: 'blocked', mr, user, reason: 'GitLab does not allow you to merge this merge request.' };
    if (mr.detailed_merge_status !== 'mergeable') return { status: 'blocked', mr, user, reason: `GitLab does not report it as mergeable right now (${String(mr.detailed_merge_status || 'unknown').replace(/_/g, ' ')}).` };
    return { status: 'ready', mr, user };
  } catch {
    return { status: 'blocked', reason: 'GitLab could not verify your identity and the merge request. Sign in again or try later.' };
  }
}

/** Send exactly one merge, pinned to the reviewed head commit. Never retried. */
export async function userMergeWrite(host, record, session) {
  const path = `projects/${encodeURIComponent(record.project)}/merge_requests/${encodeURIComponent(record.iid)}/merge`;
  return request(host, session.accessToken, path, { method: 'PUT', body: { sha: record.sha } });
}

/** Reads the merge request back with the visitor's token (after a merge whose answer was unclear). */
export async function userMrRead(host, record, session) {
  return request(host, session.accessToken, `projects/${encodeURIComponent(record.project)}/merge_requests/${encodeURIComponent(record.iid)}`);
}

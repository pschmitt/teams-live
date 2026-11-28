// Open GitHub pull requests of the configured organizations and repositories, listed next to the GitLab merge
// requests (dashboard and `/mrs`). Read only, with one token of the bot's own, over the GraphQL API.
//
// A pull request is returned in the shape of the dashboard's merge requests (see normalizeMr in dashboard.mjs)
// with `provider: 'github'`; `toListMr` turns that into the shape `/mrs` reads from the GitLab REST API.

import { createLogger } from './logger.mjs';

const log = createLogger('github');

const TIMEOUT_MS = 20_000;
const CACHE_MS = 60_000;
const MAX_PAGES = 3;
// Repositories per search: GitHub limits the length of a search query.
const REPOS_PER_SEARCH = 5;

const QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title url isDraft updatedAt headRefName baseRefName headRefOid mergeable mergeStateStatus reviewDecision
        autoMergeRequest { enabledAt }
        repository { nameWithOwner }
        author { __typename login ... on User { name } }
        reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { members(first: 50) { nodes { login } } } } } }
        latestOpinionatedReviews(first: 20) { nodes { state author { login ... on User { name } } } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

const lower = (value) => String(value ?? '').toLowerCase();

// The check rollup of the head commit as a GitLab pipeline status, which the lists already draw.
const CI_STATES = { success: 'success', failure: 'failed', error: 'failed', pending: 'running', expected: 'pending' };

/** The search queries covering the organizations and repositories: one per organization, repositories in groups. */
export function searchQueries({ orgs = [], repos = [] } = {}) {
  const base = 'is:pr is:open archived:false sort:updated-desc';
  const queries = orgs.map((org) => `${base} org:${org}`);
  for (let i = 0; i < repos.length; i += REPOS_PER_SEARCH) {
    queries.push(`${base} ${repos.slice(i, i + REPOS_PER_SEARCH).map((r) => `repo:${r}`).join(' ')}`);
  }
  return queries;
}

/**
 * A GraphQL pull request in the shape of a dashboard merge request. `users` maps GitHub logins (lower case) to
 * GitLab usernames, so "Mine" and "Needs my review" work; an unmapped login becomes `<login>@github`, which
 * never matches a GitLab user of the same name.
 */
export function normalizePullRequest(n, users = new Map()) {
  const username = (login) => (login ? users.get(lower(login)) || `${lower(login)}@github` : '');
  const reviews = n.latestOpinionatedReviews?.nodes || [];
  const approvedBy = reviews
    .filter((r) => r?.state === 'APPROVED' && r.author?.login)
    .map((r) => ({ username: username(r.author.login), name: r.author.name || r.author.login }));
  const reviewers = (n.reviewRequests?.nodes || []).flatMap((r) => {
    const who = r?.requestedReviewer;
    return who?.login ? [who.login] : (who?.members?.nodes || []).map((m) => m?.login).filter(Boolean);
  });
  const author = n.author?.login || '';
  const approved = n.reviewDecision === 'APPROVED' || (!n.reviewDecision && approvedBy.length > 0);
  let mergeStatus = '';
  if (n.mergeable === 'CONFLICTING') mergeStatus = 'conflict';
  else if (n.isDraft) mergeStatus = 'draft_status';
  else if (n.mergeStateStatus === 'BEHIND') mergeStatus = 'need_rebase';
  else if (n.reviewDecision === 'REVIEW_REQUIRED' || n.reviewDecision === 'CHANGES_REQUESTED') mergeStatus = 'not_approved';
  else if (n.mergeStateStatus === 'CLEAN') mergeStatus = 'mergeable';
  return {
    provider: 'github',
    project: n.repository?.nameWithOwner || '',
    iid: Number(n.number),
    title: String(n.title || ''),
    url: n.url || '',
    draft: n.isDraft === true,
    updatedAt: n.updatedAt || '',
    source: n.headRefName || '',
    target: n.baseRefName || '',
    sha: n.headRefOid || '',
    mergeStatus,
    approved,
    // GitHub does not tell how many approvals a branch needs: only whether one is still required.
    required: n.reviewDecision === 'REVIEW_REQUIRED' ? approvedBy.length + 1 : null,
    left: null,
    author: {
      username: username(author),
      name: n.author?.name || author,
      bot: n.author?.__typename === 'Bot',
    },
    reviewers: [...new Set(reviewers.map(username))],
    approvedBy,
    pipeline: CI_STATES[lower(n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state)] || '',
    autoMerge: Boolean(n.autoMergeRequest),
    // Approving and merging happen on GitHub.
    canApprove: false,
    canMerge: false,
  };
}

/** A pull request as `/mrs` reads a GitLab merge request. */
export function toListMr(pr) {
  return {
    provider: 'github',
    iid: pr.iid,
    title: pr.title,
    web_url: pr.url,
    references: { full: `${pr.project}#${pr.iid}` },
    author: { ...pr.author },
    draft: pr.draft,
    state: 'opened',
    updated_at: pr.updatedAt,
    source_branch: pr.source,
    sha: pr.sha,
    detailed_merge_status: pr.mergeStatus,
    has_conflicts: pr.mergeStatus === 'conflict',
    head_pipeline: pr.pipeline ? { status: pr.pipeline } : null,
    auto_merge_enabled: pr.autoMerge,
    approval_summary: { known: true, approved: pr.approved, approvedBy: pr.approvedBy.map((u) => u.name) },
  };
}

export class GitHubClient {
  constructor({ token = null, orgs = [], repos = [], users = {}, api_url = 'https://api.github.com/graphql' } = {}) {
    this.token = token;
    this.orgs = orgs;
    this.repos = repos;
    this.users = new Map(Object.entries(users).map(([login, gitlab]) => [lower(login), lower(gitlab)]));
    this.apiUrl = api_url;
    this.cache = null;
    this.loading = null;
  }

  isConfigured() {
    return Boolean(this.token && (this.orgs.length || this.repos.length));
  }

  async search(q, after) {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'User-Agent': 'teams-live' },
      body: JSON.stringify({ query: QUERY, variables: { q, after } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
    const answer = await response.json();
    // Partial errors (a team the token may not read) still carry the pull requests.
    if (!answer?.data?.search) throw new Error(`GitHub could not list the pull requests: ${answer?.errors?.[0]?.message || 'no data'}`);
    return answer.data.search;
  }

  async fetchAll() {
    const found = new Map();
    for (const q of searchQueries({ orgs: this.orgs, repos: this.repos })) {
      let after = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await this.search(q, after);
        for (const node of result.nodes || []) {
          if (node?.url) found.set(node.url, normalizePullRequest(node, this.users));
        }
        if (!result.pageInfo?.hasNextPage) break;
        after = result.pageInfo.endCursor;
      }
    }
    return [...found.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  /**
   * `{items, error}`: the open pull requests, newest activity first. Never throws: when GitHub cannot be read,
   * the last list read (or none) is returned with `error` saying so.
   */
  async listPullRequests({ force = false, now = Date.now() } = {}) {
    if (!this.isConfigured()) return { items: [], error: null };
    if (!force && this.cache && now - this.cache.at < CACHE_MS) return { items: this.cache.items, error: null };
    this.loading ||= this.fetchAll()
      .then((items) => {
        this.cache = { items, at: now };
        return { items, error: null };
      })
      .catch((err) => {
        log.warn(`Could not read the pull requests: ${err.message}`);
        return { items: this.cache?.items || [], error: 'Could not read the GitHub pull requests right now.' };
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }
}

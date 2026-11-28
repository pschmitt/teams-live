import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, normalizePullRequest, searchQueries, toListMr } from '../src/github.mjs';
import { approveControl, mrFilters, mrsSection } from '../src/dashboard.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { isRichMessage, messageMarkdown, setRichMessages } from '../src/teams.mjs';
import { GITHUB_ICONS_SMALL } from '../src/github-icons-small.mjs';

beforeEach(() => setRichMessages(false));

const node = (extra = {}) => ({
  number: 7,
  title: 'docs: add translations',
  url: 'https://github.com/example-org/docs/pull/7',
  isDraft: false,
  updatedAt: '2026-01-02T00:00:00Z',
  headRefOid: 'abc',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BLOCKED',
  reviewDecision: 'REVIEW_REQUIRED',
  repository: { nameWithOwner: 'example-org/docs' },
  author: { __typename: 'User', login: 'Alice', name: 'Alice Example' },
  reviewRequests: { nodes: [{ requestedReviewer: { members: { nodes: [{ login: 'Bob' }] } } }] },
  latestOpinionatedReviews: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  ...extra,
});

test('searchQueries: one per organization, repositories in groups', () => {
  const repos = Array.from({ length: 6 }, (_, i) => `o/r${i}`);
  const queries = searchQueries({ orgs: ['a', 'b'], repos });
  assert.equal(queries.length, 4);
  assert.match(queries[0], /is:pr is:open .* org:a$/);
  assert.match(queries[3], /repo:o\/r5$/);
});

test('normalizePullRequest: mapped logins are GitLab users, others never match one', () => {
  const pr = normalizePullRequest(node(), new Map([['bob', 'bob.gitlab']]));
  assert.equal(pr.author.username, 'alice@github');
  assert.deepEqual(pr.reviewers, ['bob.gitlab']);
  assert.equal(pr.pipeline, 'success');
  assert.equal(pr.mergeStatus, 'not_approved');
  assert.ok(mrFilters(pr, 'bob.gitlab').includes('review'));
  assert.ok(!mrFilters(pr, 'alice').includes('mine'));
});

test('dashboard row: marked as GitHub, links out, no GitLab actions', () => {
  const html = mrsSection({ items: [normalizePullRequest(node())] }, { username: 'bob', host: 'gitlab.example.com', avatars: {}, now: Date.now(), merge: true });
  assert.match(html, /forge-github/);
  assert.match(html, /example-org\/docs<\/a>#7/);
  assert.match(html, /href="https:\/\/github\.com\/example-org\/docs\/pull\/7"/);
  assert.doesNotMatch(html, /data-mr=|data-sel=|data-approve|data-merge/);
});

test('listPullRequests: dedupes, keeps the last list when GitHub fails', async (t) => {
  let fail = false;
  t.mock.method(globalThis, 'fetch', async () => {
    if (fail) return new Response('', { status: 502 });
    return Response.json({ data: { search: { pageInfo: { hasNextPage: false }, nodes: [node()] } } });
  });
  const client = new GitHubClient({ token: 't', orgs: ['example-org'], repos: ['example-org/docs'] });
  assert.equal((await client.listPullRequests()).items.length, 1);
  fail = true;
  const stale = await client.listPullRequests({ force: true });
  assert.equal(stale.items.length, 1);
  assert.match(stale.error, /GitHub/);
});

test('listPullRequests: off without a token', async () => {
  assert.deepEqual(await new GitHubClient({ orgs: ['example-org'] }).listPullRequests(), { items: [], error: null });
});

test('/mrs lists pull requests as GitHub ones', async () => {
  const pulls = { items: [normalizePullRequest(node())], error: null };
  const watcher = new MergeRequestWatcher({
    config: { conversations: [], gitlab: { group: 'example-org', notify: {} }, teams: { rich_messages: true } },
    gitlab: { getGroupMrs: async () => [], findMrLinks: () => [], mrLink: () => '', pipelineLink: () => '', getMr: async () => null },
    github: { listPullRequests: async () => pulls },
    jira: null,
    opsgenie: null,
  });
  watcher.saveState = () => {};
  const data = await watcher.getOrFetchMrsData({ force: true });
  assert.deepEqual(data, [toListMr(pulls.items[0])]);
  const message = watcher.formatMrsMessage(data);
  assert.equal(isRichMessage(message), true);
  // The GitLab group prefix is not stripped from an equally named GitHub organization.
  assert.match(messageMarkdown(message), /🐙 \[example-org\/docs#7\]/);
  const card = JSON.stringify(message.card);
  assert.ok(card.includes(GITHUB_ICONS_SMALL['pull-request-open']));
  assert.ok(card.includes('GitHub · example-org/docs'));
  assert.doesNotMatch(card, /!7\b/);
});

test('rows that cannot be approved here get a greyed-out button and the reason', () => {
  const ctx = { username: 'bob', host: 'gitlab.example.com', avatars: {}, now: Date.now(), merge: true };
  const pr = normalizePullRequest(node());
  const github = mrsSection({ items: [pr] }, ctx);
  assert.match(github, /<button[^>]*disabled[^>]*>.*Approve<\/button>/);
  assert.match(github, /class="appr-why">⚠️ The dashboard has read-only access to GitHub/);
  const gitlab = { ...pr, provider: undefined, author: { username: 'alice', name: 'Alice Example' }, canApprove: false };
  assert.match(approveControl(gitlab, 'bob').warning, /GitLab does not allow you/);
  // Nothing to give: no button and no warning.
  for (const mr of [{ ...pr, draft: true }, { ...pr, approvedBy: [{ username: 'bob', name: 'Bob' }] }, { ...gitlab, author: { username: 'bob' } }]) {
    assert.equal(approveControl(mr, 'bob').warning, '');
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MergeRequestWatcher } from '../src/watcher.mjs';

test('formatMrStatusMessage includes auto-merge line when enabled and omits when false', () => {
  const watcher = new MergeRequestWatcher({
    config: {
      conversations: [],
      gitlab: { host: 'git.wiit.one', group: 'kubernetes' },
    },
    gitlab: {
      mrLink: (p, iid) => `https://git.wiit.one/${p}/-/merge_requests/${iid}`,
      pipelineLink: (p, id) => `https://git.wiit.one/${p}/-/pipelines/${id}`,
    },
  });

  const mr = { project: 'kubernetes/k8s', iid: '42', title: 'Add feature' };
  const pipeline = { id: 100, status: 'running', web_url: 'https://git.wiit.one/p/100' };

  // Case 1: autoMerge disabled
  const msgDisabled = watcher.formatMrStatusMessage(mr, pipeline, {
    approved: false,
    status: 'pending',
    autoMerge: false,
    autoMergeUser: null,
  });
  assert.match(msgDisabled, /🦊 \[!42 \(kubernetes\/k8s\)\]/);
  assert.match(msgDisabled, /⏳ \*\*Not approved yet\*\*/);
  assert.doesNotMatch(msgDisabled, /Auto-merge/);

  // Case 2: autoMerge enabled with user
  const msgEnabledUser = watcher.formatMrStatusMessage(mr, pipeline, {
    approved: true,
    approvedBy: ['Alice'],
    status: 'approved',
    autoMerge: true,
    autoMergeUser: 'Daniel Nagy',
  });
  assert.match(msgEnabledUser, /👍 \*\*Approved\*\* by Alice/);
  assert.match(msgEnabledUser, /🔀 \*\*Auto-merge enabled\*\* by Daniel Nagy/);

  // Case 3: autoMerge enabled without user
  const msgEnabledNoUser = watcher.formatMrStatusMessage(mr, pipeline, {
    approved: false,
    status: 'pending',
    autoMerge: true,
    autoMergeUser: null,
  });
  assert.match(msgEnabledNoUser, /🔀 \*\*Auto-merge enabled\*\*/);
  assert.doesNotMatch(msgEnabledNoUser, /by null/);
});

test('autoMerge status change detection in checkWatchedKey', async () => {
  const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-live-test-'));
  process.env.XDG_STATE_HOME = tmpStateDir;

  const mrState = {
    project: 'kubernetes/k8s',
    iid: '42',
    title: 'Auto merge test',
    status: 'pending',
    approved: false,
    approvedBy: [],
    needsRebase: false,
    autoMerge: false,
    autoMergeUser: null,
    pipeline: { id: 100, status: 'running', web_url: 'https://git.wiit.one/p/100' },
  };

  const gitlabMock = {
    findMrLinks: () => [{ project: 'kubernetes/k8s', iid: '42' }],
    findJobLinks: () => [],
    findPipelineLinks: () => [],
    getMrStatus: async () => ({ ...mrState }),
    mrLink: (p, iid) => `https://git.wiit.one/${p}/-/merge_requests/${iid}`,
    pipelineLink: (p, id) => `https://git.wiit.one/${p}/-/pipelines/${id}`,
  };

  const watcher = new MergeRequestWatcher({
    config: {
      conversations: [{ id: '19:test@thread.v2', name: 'test' }],
      gitlab: {
        host: 'git.wiit.one',
        group: 'kubernetes',
        notify: { ci: { enable: true, on_failure: true, on_success: true } },
      },
    },
    gitlab: gitlabMock,
    jira: null,
    opsgenie: null,
  });

  const convId = '19:test@thread.v2';
  const msgId = String(Date.now());
  const key = `${convId}/${msgId}`;

  // Track handleCiStatusComment calls
  const statusCommentCalls = [];
  watcher.handleCiStatusComment = async (entry, mr, pipe, details) => {
    statusCommentCalls.push({ entry, mr, pipe, details });
  };
  watcher.setCommandReaction = async () => {};

  // Setup watched entry with an existing comment ID (simulating already reported)
  watcher.watched.set(key, {
    conversationId: convId,
    messageId: msgId,
    createdAt: Date.now(),
    editedOriginal: false,
    isHistory: false,
    mrs: [
      {
        project: 'kubernetes/k8s',
        iid: '42',
        title: 'Auto merge test',
        ciMessageServerId: '2001',
        lastReportedPipelineId: 100,
        lastReportedPipelineStatus: 'running',
        lastReportedApprovalStatus: false,
        lastReportedApprovedBy: '',
        lastReportedNeedsRebase: false,
        lastReportedAutoMerge: false,
        lastReportedAutoMergeUser: null,
        lastReportedTitle: 'Auto merge test',
        lastReportedJiraKey: null,
      },
    ],
  });

  // Check 1: No change
  await watcher.checkWatchedKey(key);
  assert.equal(statusCommentCalls.length, 0, 'Should not update when nothing changed');

  // Check 2: autoMerge enabled!
  mrState.autoMerge = true;
  mrState.autoMergeUser = 'Philipp Schmitt';
  await watcher.checkWatchedKey(key);

  assert.equal(statusCommentCalls.length, 1, 'Should trigger status comment update on autoMerge change');
  assert.equal(statusCommentCalls[0].details.autoMerge, true);
  assert.equal(statusCommentCalls[0].details.autoMergeUser, 'Philipp Schmitt');
  assert.equal(statusCommentCalls[0].details.autoMergeChanged, true);

  const watchedMr = watcher.watched.get(key).mrs[0];
  assert.equal(watchedMr.lastReportedAutoMerge, true);
  assert.equal(watchedMr.lastReportedAutoMergeUser, 'Philipp Schmitt');

  // Check 3: autoMerge disabled / cancelled!
  mrState.autoMerge = false;
  mrState.autoMergeUser = null;
  await watcher.checkWatchedKey(key);

  assert.equal(statusCommentCalls.length, 2, 'Should trigger status comment update when autoMerge is cleared');
  assert.equal(statusCommentCalls[1].details.autoMerge, false);
  assert.equal(statusCommentCalls[1].details.autoMergeUser, null);
  assert.equal(statusCommentCalls[1].details.autoMergeChanged, true);
  assert.equal(watchedMr.lastReportedAutoMerge, false);
  assert.equal(watchedMr.lastReportedAutoMergeUser, null);

  // Clean up
  try {
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
  } catch {}
});

test('formatMrsText includes auto-merge badge when auto-merge is active', () => {
  const watcher = new MergeRequestWatcher({
    config: {
      conversations: [],
      gitlab: { host: 'git.wiit.one', group: 'kubernetes' },
    },
    gitlab: {},
  });

  const mrs = [
    {
      iid: 101,
      title: 'Normal MR',
      web_url: 'https://git.wiit.one/kubernetes/repo/-/merge_requests/101',
      author: { name: 'Alice' },
      detailed_merge_status: 'mergeable',
      merge_when_pipeline_succeeds: false,
    },
    {
      iid: 102,
      title: 'Auto-merging MR',
      web_url: 'https://git.wiit.one/kubernetes/repo/-/merge_requests/102',
      author: { name: 'Bob' },
      detailed_merge_status: 'ci_still_running',
      merge_when_pipeline_succeeds: true,
    },
  ];

  const formatted = watcher.formatMrsText(mrs);
  assert.match(formatted, /- ✅ \[!101\]\(https:\/\/git\.wiit\.one\/kubernetes\/repo\/-\/merge_requests\/101\): Normal MR/);
  assert.doesNotMatch(formatted, /Normal MR.*_auto-merge_/);

  assert.match(formatted, /- ⏳ \[!102\]\(https:\/\/git\.wiit\.one\/kubernetes\/repo\/-\/merge_requests\/102\): Auto-merging MR/);
  assert.match(formatted, /Auto-merging MR.*🔀 _auto-merge_/);
});

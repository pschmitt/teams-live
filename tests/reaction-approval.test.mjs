import test from 'node:test';
import assert from 'node:assert/strict';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { botSentMessageIds, recordBotMessageId } from '../src/teams.mjs';

const TEST_SELF_OID = 'f94ccd0d-d140-4d1d-9fee-b00e642b9c11';
const TEST_SELF_MRI = `8:orgid:${TEST_SELF_OID}`;

function createWatcher({
  selfOid = TEST_SELF_OID,
  selfMri = TEST_SELF_MRI,
  adminIds = [],
  messages = {},
  mrStates = {},
} = {}) {
  const approvedCalls = [];
  const repliedMessages = [];

  const gitlabMock = {
    findMrLinks: (text) => {
      if (!text) return [];
      const match = text.match(/https?:\/\/[^\s/]+\/([^/\s]+\/[^/\s]+)\/-\/merge_requests\/(\d+)/);
      if (match) return [{ project: match[1], iid: match[2] }];
      return [];
    },
    getMrStatus: async (project, iid) => {
      const key = `${project}!${iid}`;
      return mrStates[key] || { status: 'pending', approved: false, title: `MR !${iid}` };
    },
    approveMr: async (project, iid) => {
      approvedCalls.push({ project, iid });
      const key = `${project}!${iid}`;
      if (mrStates[key]) {
        mrStates[key].status = 'approved';
        mrStates[key].approved = true;
      }
      return { approved: true };
    },
    mrLink: (project, iid) => `https://git.wiit.one/${project}/-/merge_requests/${iid}`,
  };

  const getMessageMock = async (convId, msgId) => {
    const key = `${convId}/${msgId}`;
    const msg = messages[key] || messages[msgId];
    if (!msg) return { ok: false, error: { message: 'Not found' } };
    return { ok: true, value: msg };
  };

  const watcher = new MergeRequestWatcher({
    config: {
      conversations: [{ id: '19:k8s@thread.v2', name: 'k8s' }],
      gitlab: {},
      teams: {
        admin_ids: adminIds,
      },
    },
    gitlab: gitlabMock,
    jira: null,
    opsgenie: null,
    getMessage: getMessageMock,
  });

  watcher.setSelfMri(selfMri);

  return { watcher, approvedCalls, repliedMessages, selfMri, selfOid };
}

test('approves MR when self reacts with thumbs-up to bot status comment', async () => {
  const convId = '19:k8s@thread.v2';
  const botReplyId = '1770000000000';
  const originalMsgId = '1660000000000';

  const { watcher, approvedCalls } = createWatcher({
    messages: {
      [`${convId}/${botReplyId}`]: {
        id: botReplyId,
        content: '🦊 [!42 (kubernetes/k8s)](https://git.wiit.one/kubernetes/k8s/-/merge_requests/42)\n\n⏳ **Not approved yet**',
        reactions: [
          {
            key: 'like',
            user: { mri: TEST_SELF_MRI, displayName: 'Philipp Schmitt' },
          },
        ],
      },
    },
  });

  // Watch the conversation
  watcher.watched.set(`${convId}/${originalMsgId}`, {
    conversationId: convId,
    messageId: originalMsgId,
    editedOriginal: false,
    mrs: [
      {
        project: 'kubernetes/k8s',
        iid: '42',
        title: 'Fix networking',
        ciMessageServerId: botReplyId,
      },
    ],
  });
  recordBotMessageId(botReplyId);

  // Incoming MessageUpdate on the bot status comment
  await watcher.handleIncomingEvent({
    kind: 'MessageUpdate',
    conversationId: convId,
    messageId: botReplyId,
  });

  assert.equal(approvedCalls.length, 1);
  assert.deepEqual(approvedCalls[0], { project: 'kubernetes/k8s', iid: '42' });
});

test('approves MR when self reacts with 👍 emoji key on edited original bot message', async () => {
  const convId = '19:k8s@thread.v2';
  const msgId = '1770000001000';

  const { watcher, approvedCalls } = createWatcher({
    messages: {
      [`${convId}/${msgId}`]: {
        id: msgId,
        content: '🦊 [!100 (kubernetes/workload-clusters)](https://git.wiit.one/kubernetes/workload-clusters/-/merge_requests/100)',
        reactions: [
          {
            key: '👍',
            user: { mri: TEST_SELF_MRI, displayName: 'Philipp Schmitt' },
          },
        ],
      },
    },
  });

  watcher.watched.set(`${convId}/${msgId}`, {
    conversationId: convId,
    messageId: msgId,
    editedOriginal: true,
    mrs: [
      {
        project: 'kubernetes/workload-clusters',
        iid: '100',
        title: 'Bump core addons',
      },
    ],
  });

  await watcher.handleIncomingEvent({
    kind: 'MessageUpdate',
    conversationId: convId,
    messageId: msgId,
  });

  assert.equal(approvedCalls.length, 1);
  assert.deepEqual(approvedCalls[0], { project: 'kubernetes/workload-clusters', iid: '100' });
});

test('does NOT approve MR when non-self user reacts with thumbs-up', async () => {
  const convId = '19:k8s@thread.v2';
  const botReplyId = '1770000002000';

  const otherUserMri = '8:orgid:11111111-2222-3333-4444-555555555555';

  const { watcher, approvedCalls } = createWatcher({
    messages: {
      [`${convId}/${botReplyId}`]: {
        id: botReplyId,
        content: '🦊 [!55 (kubernetes/capi)](https://git.wiit.one/kubernetes/capi/-/merge_requests/55)',
        reactions: [
          {
            key: 'like',
            user: { mri: otherUserMri, displayName: 'Other Person' },
          },
        ],
      },
    },
  });

  recordBotMessageId(botReplyId);

  await watcher.handleIncomingEvent({
    kind: 'MessageUpdate',
    conversationId: convId,
    messageId: botReplyId,
  });

  assert.equal(approvedCalls.length, 0);
});

test('does NOT approve MR when reaction is not thumbs-up (e.g. laugh, heart)', async () => {
  const convId = '19:k8s@thread.v2';
  const botReplyId = '1770000003000';

  const { watcher, approvedCalls } = createWatcher({
    messages: {
      [`${convId}/${botReplyId}`]: {
        id: botReplyId,
        content: '🦊 [!55 (kubernetes/capi)](https://git.wiit.one/kubernetes/capi/-/merge_requests/55)',
        reactions: [
          {
            key: 'laugh',
            user: { mri: TEST_SELF_MRI, displayName: 'Philipp Schmitt' },
          },
        ],
      },
    },
  });

  recordBotMessageId(botReplyId);

  await watcher.handleIncomingEvent({
    kind: 'MessageUpdate',
    conversationId: convId,
    messageId: botReplyId,
  });

  assert.equal(approvedCalls.length, 0);
});

test('does NOT approve MR when message is not a bot message', async () => {
  const convId = '19:k8s@thread.v2';
  const userMsgId = '1770000004000';

  const { watcher, approvedCalls } = createWatcher({
    messages: {
      [`${convId}/${userMsgId}`]: {
        id: userMsgId,
        sender: { mri: '8:orgid:someone-else', displayName: 'Colleague' },
        content: 'Hey take a look at https://git.wiit.one/kubernetes/capi/-/merge_requests/55',
        reactions: [
          {
            key: 'like',
            user: { mri: TEST_SELF_MRI, displayName: 'Philipp Schmitt' },
          },
        ],
      },
    },
  });

  // Not in botSentMessageIds, not an own message, not watched bot reply
  await watcher.handleIncomingEvent({
    kind: 'MessageUpdate',
    conversationId: convId,
    messageId: userMsgId,
  });

  assert.equal(approvedCalls.length, 0);
});

test('does NOT approve MR when MR is already approved', async () => {
  const convId = '19:k8s@thread.v2';
  const botReplyId = '1770000005000';

  const { watcher, approvedCalls } = createWatcher({
    mrStates: {
      'kubernetes/capi!55': { status: 'approved', approved: true },
    },
    messages: {
      [`${convId}/${botReplyId}`]: {
        id: botReplyId,
        content: '🦊 [!55 (kubernetes/capi)](https://git.wiit.one/kubernetes/capi/-/merge_requests/55)',
        reactions: [
          {
            key: 'like',
            user: { mri: TEST_SELF_MRI, displayName: 'Philipp Schmitt' },
          },
        ],
      },
    },
  });

  recordBotMessageId(botReplyId);

  await watcher.handleIncomingEvent({
    kind: 'MessageUpdate',
    conversationId: convId,
    messageId: botReplyId,
  });

  assert.equal(approvedCalls.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { MergeRequestWatcher, teamsReactionToGitLabEmoji } from '../src/watcher.mjs';
import { recordBotMessageId } from '../src/teams.mjs';

const TEST_SELF_OID = 'f94ccd0d-d140-4d1d-9fee-b00e642b9c11';
const TEST_SELF_MRI = `8:orgid:${TEST_SELF_OID}`;

test('teamsReactionToGitLabEmoji maps reaction keys and reserves thumbs up', () => {
  // Thumbs up is reserved for approving and must return null
  assert.equal(teamsReactionToGitLabEmoji('like'), null);
  assert.equal(teamsReactionToGitLabEmoji('👍'), null);
  assert.equal(teamsReactionToGitLabEmoji('1f44d_thumbsup'), null);
  assert.equal(teamsReactionToGitLabEmoji('thumbs_up'), null);
  assert.equal(teamsReactionToGitLabEmoji('thumbsup'), null);

  // Standard reaction keys
  assert.equal(teamsReactionToGitLabEmoji('laugh'), 'laughing');
  assert.equal(teamsReactionToGitLabEmoji('heart'), 'hearts');
  assert.equal(teamsReactionToGitLabEmoji('surprised'), 'open_mouth');
  assert.equal(teamsReactionToGitLabEmoji('sad'), 'cry');
  assert.equal(teamsReactionToGitLabEmoji('angry'), 'angry');
  assert.equal(teamsReactionToGitLabEmoji('1f44e_thumbsdown'), 'thumbsdown');
  assert.equal(teamsReactionToGitLabEmoji('👎'), 'thumbsdown');

  // Translation table checks (Teams slug -> TanukiEmoji)
  assert.equal(teamsReactionToGitLabEmoji('loudlycrying'), 'sob');
  assert.equal(teamsReactionToGitLabEmoji('loudly_crying'), 'sob');
  assert.equal(teamsReactionToGitLabEmoji('😭'), 'sob');
  assert.equal(teamsReactionToGitLabEmoji('1f62d_loudly_crying_face'), 'sob');
  assert.equal(teamsReactionToGitLabEmoji('tears_of_joy'), 'joy');
  assert.equal(teamsReactionToGitLabEmoji('rofl'), 'rofl');
  assert.equal(teamsReactionToGitLabEmoji('check'), 'white_check_mark');
  assert.equal(teamsReactionToGitLabEmoji('checkmark'), 'white_check_mark');

  // Unicode emojis
  assert.equal(teamsReactionToGitLabEmoji('😆'), 'laughing');
  assert.equal(teamsReactionToGitLabEmoji('🎉'), 'tada');
  assert.equal(teamsReactionToGitLabEmoji('🚀'), 'rocket');
  assert.equal(teamsReactionToGitLabEmoji('🔥'), 'fire');
  assert.equal(teamsReactionToGitLabEmoji('🤔'), 'thinking');
  assert.equal(teamsReactionToGitLabEmoji('👀'), 'eyes');

  // Hex encoded keys
  assert.equal(teamsReactionToGitLabEmoji('1f389_party_popper'), 'tada');
  assert.equal(teamsReactionToGitLabEmoji('1f914_thinking_face'), 'thinking');
});

test('botPlacedLikeMessageIds prevents self-trigger loop on like reaction', async () => {
  const convId = '19:team@thread.v2';
  const botReplyId = '1780000000001';
  const originalMsgId = '1680000000001';
  let approveCalls = 0;

  const gitlabMock = {
    findMrLinks: () => [{ project: 'group/app', iid: '42' }],
    getMrStatus: async () => ({ status: 'pending', approved: false, title: 'MR !42' }),
    approveMr: async () => {
      approveCalls++;
      return { approved: true };
    },
    mrLink: (project, iid) => `https://gitlab.example.com/${project}/-/merge_requests/${iid}`,
  };

  const watcher = new MergeRequestWatcher({
    config: {
      conversations: [{ id: convId, name: 'team' }],
      gitlab: {},
      teams: {},
    },
    gitlab: gitlabMock,
    getMessage: async () => ({
      ok: true,
      value: {
        id: botReplyId,
        content: '🦊 [!42](...)',
        reactions: [{ key: 'like', user: { mri: TEST_SELF_MRI, displayName: 'Me' } }],
      },
    }),
  });
  watcher.setSelfMri(TEST_SELF_MRI);

  watcher.watched.set(`${convId}/${originalMsgId}`, {
    conversationId: convId,
    messageId: originalMsgId,
    status: 'approved',
    mrs: [{ project: 'group/app', iid: '42', ciMessageServerId: botReplyId }],
  });
  recordBotMessageId(botReplyId);

  // Mark that bot placed like on botReplyId
  watcher.botPlacedLikeMessageIds.add(botReplyId);

  await watcher.handleIncomingEvent({
    kind: 'MessageUpdate',
    conversationId: convId,
    messageId: botReplyId,
  });

  assert.equal(approveCalls, 0, 'Should not trigger approval when like was placed by bot');
});

test('mirrors user non-thumbsup reaction to GitLab award emoji and removes when removed', async () => {
  const convId = '19:team@thread.v2';
  const originalMsgId = '1690000000001';
  const botReplyId = '1790000000001';

  const awards = [
    { id: 10, name: 'thumbsup', user: { id: 1, username: 'pschmitt' } },
    { id: 11, name: 'rocket', user: { id: 2, username: 'otheruser' } },
  ];
  const awarded = [];
  const deleted = [];

  const gitlabMock = {
    findMrLinks: () => [{ project: 'group/app', iid: '42' }],
    getMrStatus: async () => ({ status: 'pending', approved: false }),
    getCurrentUser: async () => ({ id: 1, username: 'pschmitt' }),
    getAwardEmojis: async () => [...awards],
    awardEmoji: async (proj, iid, name) => {
      awarded.push({ proj, iid, name });
      const newAward = { id: awards.length + 1, name, user: { id: 1, username: 'pschmitt' } };
      awards.push(newAward);
      return newAward;
    },
    deleteAwardEmoji: async (proj, iid, awardId) => {
      deleted.push({ proj, iid, awardId });
      const idx = awards.findIndex((a) => a.id === awardId);
      if (idx !== -1) awards.splice(idx, 1);
      return {};
    },
  };

  let currentReactions = [
    { key: 'laugh', user: { mri: TEST_SELF_MRI, displayName: 'Me' } },
    { key: 'heart', user: { mri: '8:orgid:other', displayName: 'Other' } }, // Other's reaction
  ];

  const watcher = new MergeRequestWatcher({
    config: {
      conversations: [{ id: convId, name: 'team' }],
      gitlab: {},
      teams: {},
    },
    gitlab: gitlabMock,
    getMessage: async () => ({
      ok: true,
      value: {
        id: botReplyId,
        content: '🦊 [!42](...)',
        reactions: currentReactions,
      },
    }),
  });
  watcher.setSelfMri(TEST_SELF_MRI);

  watcher.watched.set(`${convId}/${originalMsgId}`, {
    conversationId: convId,
    messageId: originalMsgId,
    mrs: [{ project: 'group/app', iid: '42', ciMessageServerId: botReplyId }],
  });
  recordBotMessageId(botReplyId);

  // 1. User added laughing reaction
  await watcher.handleIncomingEvent({
    kind: 'MessageUpdate',
    conversationId: convId,
    messageId: botReplyId,
  });

  assert.equal(awarded.length, 1);
  assert.equal(awarded[0].name, 'laughing');
  assert.equal(deleted.length, 0);

  // 2. User removed laughing reaction in Teams
  currentReactions = [];
  await watcher.handleIncomingEvent({
    kind: 'MessageUpdate',
    conversationId: convId,
    messageId: botReplyId,
  });

  // Laughing award should be deleted, but thumbsup award (from approval) must stay untouched!
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].awardId, 3); // The laughing award id
  assert.ok(awards.some((a) => a.name === 'thumbsup'), 'thumbsup award should not be removed');
  assert.ok(awards.some((a) => a.name === 'rocket'), 'other user award should not be touched');

  // 3. Bot status reaction (1f440_eyes) placed on the message must NOT be mirrored as user award
  currentReactions = [
    { key: '1f440_eyes', user: { mri: TEST_SELF_MRI, displayName: 'Me' } },
  ];
  watcher.recordBotReaction(botReplyId, '1f440_eyes');
  await watcher.handleIncomingEvent({
    kind: 'MessageUpdate',
    conversationId: convId,
    messageId: botReplyId,
  });
  // No new award should have been added
  assert.equal(awarded.length, 1, 'Bot-placed status reaction should not be awarded on GitLab');
});

test('checkWatchedKey keeps closed MRs watched until merged and handles reopen', async () => {
  const convId = '19:team@thread.v2';
  const msgId = '1690000000002';
  const key = `${convId}/${msgId}`;

  let currentMrState = {
    status: 'closed',
    state: 'closed',
    approved: false,
    title: 'Test MR',
    pipeline: null,
  };

  const gitlabMock = {
    findMrLinks: () => [{ project: 'group/app', iid: '99' }],
    getMrStatus: async () => currentMrState,
    mrLink: (p, i) => `https://gitlab.example.com/${p}/-/merge_requests/${i}`,
  };

  const watcher = new MergeRequestWatcher({
    config: {
      conversations: [{ id: convId, name: 'team' }],
      gitlab: { notify: { ci: { enable: true } } },
      teams: {},
    },
    gitlab: gitlabMock,
    getMessage: async () => ({ ok: false }),
  });
  watcher.setSelfMri(TEST_SELF_MRI);

  let ciStatusCommentCalls = 0;
  watcher.handleCiStatusComment = async () => {
    ciStatusCommentCalls++;
  };
  watcher.handleClosedComment = async () => {};
  watcher.setReactionStatus = async () => {};

  watcher.watched.set(key, {
    conversationId: convId,
    messageId: msgId,
    createdAt: Date.now(),
    status: 'pending',
    mrs: [
      {
        project: 'group/app',
        iid: '99',
        status: 'pending',
        ciMessageServerId: '12345',
        lastReportedPipelineStatus: null,
        lastReportedApprovalStatus: false,
        lastReportedApprovedBy: '',
        lastReportedNeedsRebase: false,
        lastReportedAutoMerge: false,
        lastReportedAutoMergeUser: null,
        lastReportedTitle: 'Test MR',
        lastReportedDraft: false,
        lastReportedJiraKey: null,
      },
    ],
  });

  // 1. First check: MR is closed
  await watcher.checkWatchedKey(key);
  // Entry should NOT be deleted from watcher because it is closed, not merged!
  assert.ok(watcher.watched.has(key), 'Closed MR should remain watched');
  const watchedEntry = watcher.watched.get(key);
  assert.equal(watchedEntry.mrs[0].status, 'closed');

  // 2. Second check: MR is reopened!
  currentMrState = {
    status: 'pending',
    state: 'opened',
    approved: false,
    title: 'Test MR',
    pipeline: null,
  };

  await watcher.checkWatchedKey(key);
  assert.equal(ciStatusCommentCalls, 1, 'Reopening should trigger handleCiStatusComment');
  assert.equal(watchedEntry.mrs[0].status, 'pending');
  assert.ok(watcher.watched.has(key), 'Reopened MR should remain watched');

  // 3. Third check: MR is merged!
  currentMrState = {
    status: 'merged',
    state: 'merged',
    approved: true,
    title: 'Test MR',
    pipeline: null,
  };
  watcher.handleMergedComment = async () => {};

  await watcher.checkWatchedKey(key);
  assert.equal(watcher.watched.has(key), false, 'Merged MR should be unwatched');
  assert.ok(watcher.completedMessages.has(msgId));
});

test('setReactionStatus skips pending eyes reaction when editedOriginal is true', async () => {
  const convId = '19:team@thread.v2';
  const msgId = '1690000000003';

  const reactionsAdded = [];
  const reactionsRemoved = [];

  const watcher = new MergeRequestWatcher({
    config: {
      conversations: [{ id: convId, name: 'team' }],
      gitlab: {},
      teams: {},
    },
    gitlab: {},
  });

  // Mock addReaction and removeReaction
  // Note: setReactionStatus uses imported addReaction/removeReaction from teams.mjs,
  // but we can test watcher logic via mocking or inspecting botPlacedReactions & entry.status
  const entry = {
    conversationId: convId,
    messageId: msgId,
    editedOriginal: true,
    status: null,
  };

  await watcher.setReactionStatus(entry, 'pending');
  assert.equal(entry.status, 'pending');
  assert.equal(watcher.botPlacedReactions.has(msgId), false, 'Should not record bot pending reaction when editedOriginal is true');

  // If status is already pending and setReactionStatus runs with pending, it should remove it
  entry.status = 'pending';
  await watcher.setReactionStatus(entry, 'pending');
  assert.equal(entry.status, 'pending');
});


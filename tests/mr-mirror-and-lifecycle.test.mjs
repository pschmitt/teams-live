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

test('formatTokenExpiry formats validity and warning states', async () => {
  const { formatTokenExpiry } = await import('../src/gitlab.mjs');

  assert.equal(formatTokenExpiry(null), null);
  assert.equal(formatTokenExpiry({}), 'No expiration configured');
  assert.equal(formatTokenExpiry({ expires_at: null }), 'No expiration configured');

  // Past expiration
  const past = formatTokenExpiry({ expires_at: '2020-01-01' });
  assert.ok(past.startsWith('⚠️ Expired on 2020-01-01'), `Should indicate expired: ${past}`);

  // Far future expiration (e.g. 2035)
  const future = formatTokenExpiry({ expires_at: '2035-12-31' });
  assert.ok(future.startsWith('Expires in '), `Should indicate days: ${future}`);
  assert.ok(future.includes('2035-12-31'));
});

test('GitLabClient does not trigger onAuthError when action endpoint returns 401 but verifyAuth passes', async () => {
  const { GitLabClient } = await import('../src/gitlab.mjs');
  let authErrorFired = false;

  const client = new GitLabClient({
    host: 'git.example.com',
    token: 'glpat-test-token',
    onAuthError: () => {
      authErrorFired = true;
    },
  });

  // Mock verifyAuth to succeed (token is valid)
  client.verifyAuth = async () => true;

  // Simulate an approveMr call where GitLab rejects self-approval with 401 Unauthorized
  // Override global fetch temporarily or mock request makeFetch
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/user')) {
      return { ok: true, status: 200, json: async () => ({ id: 1, username: 'test' }) };
    }
    // Action endpoint returns 401 Unauthorized
    return {
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: '401 Unauthorized' }),
    };
  };

  try {
    await assert.rejects(
      async () => {
        await client.request('projects/123/merge_requests/456/approve', { method: 'POST' });
      },
      /GitLab error \(401\)/
    );
    assert.equal(authErrorFired, false, 'onAuthError should NOT fire when verifyAuth indicates token is valid');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GitLabClient triggers onAuthError when verifyAuth also fails or user endpoint returns 401', async () => {
  const { GitLabClient } = await import('../src/gitlab.mjs');
  let authErrors = [];

  const client = new GitLabClient({
    host: 'git.example.com',
    token: 'glpat-test-token',
    onAuthError: (err) => {
      authErrors.push(err);
    },
  });

  const originalFetch = globalThis.fetch;
  try {
    // 1. Direct call to user endpoint returns 401 -> must fire onAuthError immediately
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: '401 Unauthorized' }),
    });

    await assert.rejects(
      async () => {
        await client.request('user');
      },
      /GitLab error \(401\)/
    );
    assert.equal(authErrors.length, 1, 'onAuthError should fire immediately on user endpoint 401');

    // 2. Action endpoint returns 401 and verifyAuth also returns false -> must fire onAuthError
    client.verifyAuth = async () => false;
    await assert.rejects(
      async () => {
        await client.request('projects/123/merge_requests/456/approve', { method: 'POST' });
      },
      /GitLab error \(401\)/
    );
    assert.equal(authErrors.length, 2, 'onAuthError should fire when verifyAuth confirms token failure');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('isRecentMrMessage restricts comment and status card updates to the last 3 messages for an MR', async () => {
  const convId = '19:team@thread.v2';
  const watcher = new MergeRequestWatcher({
    config: {
      conversations: [{ id: convId, name: 'team' }],
      gitlab: { max_mr_messages_to_update: 3 },
      teams: {},
    },
    gitlab: {},
  });

  const mr = { project: 'group/app', iid: '10' };

  // Register 5 messages referencing the same MR in the same conversation
  const entries = [
    { conversationId: convId, messageId: 'msg1', createdAt: 1000, mrs: [{ ...mr }] },
    { conversationId: convId, messageId: 'msg2', createdAt: 2000, mrs: [{ ...mr }] },
    { conversationId: convId, messageId: 'msg3', createdAt: 3000, mrs: [{ ...mr }] },
    { conversationId: convId, messageId: 'msg4', createdAt: 4000, mrs: [{ ...mr }] },
    { conversationId: convId, messageId: 'msg5', createdAt: 5000, mrs: [{ ...mr }] },
  ];

  for (const e of entries) {
    watcher.watched.set(`${convId}/${e.messageId}`, e);
  }

  // The 3 most recent are msg5, msg4, msg3
  assert.equal(watcher.isRecentMrMessage(entries[4], mr), true, 'msg5 (newest) should be updated');
  assert.equal(watcher.isRecentMrMessage(entries[3], mr), true, 'msg4 (2nd newest) should be updated');
  assert.equal(watcher.isRecentMrMessage(entries[2], mr), true, 'msg3 (3rd newest) should be updated');

  // The older 2 messages must NOT be updated
  assert.equal(watcher.isRecentMrMessage(entries[1], mr), false, 'msg2 (older) should be skipped');
  assert.equal(watcher.isRecentMrMessage(entries[0], mr), false, 'msg1 (oldest) should be skipped');
});

test('loadConfig loads GitLab token from override file when present', async () => {
  const { loadConfig } = await import('../src/config.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');

  const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-live-override-test-'));
  const overrideDir = path.join(tmpStateDir, 'overrides');
  fs.mkdirSync(overrideDir, { recursive: true });
  const overrideFile = path.join(overrideDir, 'gitlab-token');
  fs.writeFileSync(overrideFile, 'mock-override-token-value\n', 'utf8');

  const oldEnv = process.env.XDG_STATE_HOME;
  try {
    process.env.XDG_STATE_HOME = tmpStateDir;
    const config = loadConfig();
    assert.equal(config.gitlab.token, 'mock-override-token-value');
    assert.equal(config.gitlab.is_token_override, true);
    assert.equal(config.gitlab.override_token_path, overrideFile);
  } finally {
    if (oldEnv !== undefined) {
      process.env.XDG_STATE_HOME = oldEnv;
    } else {
      delete process.env.XDG_STATE_HOME;
    }
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
  }
});

test('renewGitLabToken falls back to override file when configured secret is read-only', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');

  const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-live-renew-test-'));
  const readOnlyFile = '/run/secrets/teams-live/gitlab-token-non-writable';

  const rotatedTokenValue = 'mock-newly-rotated-token-12345';
  let rotateCalled = false;

  const mockGitLab = {
    token: 'mock-old-token',
    rotateToken: async () => {
      rotateCalled = true;
      return {
        token: rotatedTokenValue,
        expires_at: '2027-01-01',
      };
    },
  };

  const watcher = new MergeRequestWatcher({
    config: {
      conversations: [{ id: '48:notes', name: 'Notes' }],
      gitlab: {
        token_file: readOnlyFile,
        state_dir: tmpStateDir,
      },
      teams: {},
    },
    gitlab: mockGitLab,
  });

  try {
    const result = await watcher.renewGitLabToken({ reason: 'unit_test' });
    assert.equal(rotateCalled, true);
    assert.equal(result.isReadOnlySecret, true);
    assert.equal(result.savedPath, path.join(tmpStateDir, 'overrides', 'gitlab-token'));
    assert.equal(watcher.config.gitlab.is_token_override, true);
    assert.equal(watcher.config.gitlab.token, rotatedTokenValue);
    assert.equal(mockGitLab.token, rotatedTokenValue);

    const savedContent = fs.readFileSync(result.savedPath, 'utf8');
    assert.equal(savedContent, rotatedTokenValue);
  } finally {
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
  }
});

test('checkGitLabTokenExpiryAndAutoRenew auto-renews when token expires in <= 3 days', async () => {
  let renewCalled = false;

  const twoDaysAhead = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const mockGitLab = {
    token: 'mock-test-expiring',
    getTokenInfo: async () => ({
      expires_at: twoDaysAhead,
    }),
  };

  const watcher = new MergeRequestWatcher({
    config: {
      conversations: [{ id: '48:notes', name: 'Notes' }],
      gitlab: {},
      teams: {},
    },
    gitlab: mockGitLab,
  });

  watcher.renewGitLabToken = async ({ reason }) => {
    renewCalled = true;
    return {
      rotated: { token: 'mock-auto-renewed-token', expires_at: '2027-01-01' },
      savedPath: '/tmp/test/overrides/gitlab-token',
      isReadOnlySecret: true,
    };
  };

  await watcher.checkGitLabTokenExpiryAndAutoRenew();
  assert.equal(renewCalled, true, 'Auto-renewal should be triggered when expiry <= 3 days');
});

test('checkGitLabTokenExpiryAndAutoRenew alerts admin and tracks message ID when expires in <= 10 days', async () => {
  const sevenDaysAhead = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const mockGitLab = {
    token: 'mock-test-expiring-soon',
    getTokenInfo: async () => ({
      expires_at: sevenDaysAhead,
    }),
  };

  const watcher = new MergeRequestWatcher({
    config: {
      conversations: [{ id: '48:notes', name: 'Notes' }],
      gitlab: {},
      teams: {},
    },
    gitlab: mockGitLab,
  });

  // Since sendDirectMessage interacts with Teams API, we can observe that
  // pendingTokenRenewalMessageIds records message IDs and lastGitLabExpiryWarningAt is updated
  await watcher.checkGitLabTokenExpiryAndAutoRenew();
  assert.ok(watcher.lastGitLabExpiryWarningAt > 0, 'Warning timestamp should be recorded');
});

test('handleTokenRenewalReaction executes token rotation when admin reacts with thumbs up', async () => {
  const alertMsgId = '1987654321';
  let renewReason = null;

  const watcher = new MergeRequestWatcher({
    config: {
      conversations: [{ id: '48:notes', name: 'Notes' }],
      gitlab: {},
      teams: {},
    },
    gitlab: { token: 'mock-test-token' },
  });

  watcher.pendingTokenRenewalMessageIds.add(alertMsgId);
  watcher.selfOid = TEST_SELF_OID;
  watcher.renewGitLabToken = async ({ reason }) => {
    renewReason = reason;
    return {
      rotated: { token: 'mock-rotated-via-reaction', expires_at: '2027-01-01' },
      savedPath: '/tmp/test/overrides/gitlab-token',
      isReadOnlySecret: true,
    };
  };

  watcher.getMessage = async () => ({
    ok: true,
    value: {
      id: alertMsgId,
      reactions: [
        {
          key: 'like',
          user: { mri: TEST_SELF_MRI, displayName: 'Philipp Schmitt' },
        },
      ],
    },
  });

  const event = {
    kind: 'MessageUpdate',
    conversationId: '48:notes',
    messageId: alertMsgId,
  };

  await watcher.handleMessageUpdate(event);
  assert.equal(renewReason, 'reaction', 'Token rotation should be triggered by admin thumbs-up reaction');
  assert.equal(watcher.pendingTokenRenewalMessageIds.has(alertMsgId), false, 'Message ID should be removed from pending');
});



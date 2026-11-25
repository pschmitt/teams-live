import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeRichMessage, richMessageWireBytes, setRichMessages, transport } from '../src/teams.mjs';
import { MAX_CARD_BYTES } from '../src/cards.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { AvatarService } from '../src/avatars.mjs';
import { PLACEHOLDER_AVATAR } from '../src/placeholder-avatar.mjs';
import { fallbackAvatar } from '../src/card-user-row.mjs';

// A picture a person without a photo gets: their initials (or the silhouette for a name that cannot be drawn).
const isFallback = (image) => image.url === PLACEHOLDER_AVATAR || image.url === fallbackAvatar(image.altText);

// Watcher wiring of profile pictures. All people, images and URLs are generic fakes.

beforeEach(() => setRichMessages(false));

const ALICE = '8:orgid:00000000-0000-4000-8000-00000000000a';
const BOB = '8:orgid:00000000-0000-4000-8000-00000000000b';
const CONV = '19:example@thread.v2';

function fakeJpeg(extra = 0) {
  const head = [
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 32, 0, 32, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9,
  ];
  return Uint8Array.from([...head, ...new Array(8 + extra).fill(7)]);
}

const directory = {
  users: new Map([
    [ALICE, { displayName: 'Alice Example', mri: ALICE }],
    [BOB, { displayName: 'Bob Example', mri: BOB }],
  ]),
};

function richWatcher(teams = { rich_messages: true }, { extra = 0, fetched = [] } = {}) {
  const watcher = new MergeRequestWatcher({
    config: { conversations: [], gitlab: {}, teams },
    gitlab: {
      findMrLinks: () => [],
      mrLink: (project, iid) => `https://gitlab.example.com/${project}/-/merge_requests/${iid}`,
    },
    jira: null,
    opsgenie: null,
  });
  watcher.saveState = () => {};
  if (watcher.avatarService) {
    watcher.avatarService = new AvatarService({
      directory,
      fetchPhoto: async (mri) => (fetched.push(mri), { kind: 'photo', bytes: fakeJpeg(extra) }),
    });
  }
  return watcher;
}

const allPersonImages = (card) => {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Image' && node.style === 'Person') found.push(node);
    Object.values(node).forEach(walk);
  };
  walk(card);
  return found;
};
// Real photos only; the neutral placeholder of people without a photo is counted apart.
const personImages = (card) => allPersonImages(card).filter((i) => !isFallback(i));
const placeholderImages = (card) => allPersonImages(card).filter((i) => isFallback(i));

const jiraIssue = {
  key: 'EX-1',
  summary: 'Something is broken',
  url: 'https://jira.example.com/browse/EX-1',
  issueType: 'Bug',
  status: 'Open',
  statusCategory: 'new',
  priority: 'High',
  assignee: 'Alice Example',
};

function recordTransport() {
  const calls = [];
  const original = { ...transport };
  transport.sendMessage = (...args) => {
    calls.push(args);
    return Promise.resolve({ ok: true, value: { messageId: '1700000000001', timestamp: '1700000000001' } });
  };
  return { calls, restore: () => Object.assign(transport, original) };
}

const sentCard = (call) => JSON.parse(call[2].properties.cards)[0].content;

test('regular mode creates no avatar service and makes no photo request', async () => {
  const fetched = [];
  const watcher = richWatcher({}, { fetched });
  assert.equal(watcher.avatarService, null);
  await watcher.prefetchAvatars(jiraIssue);
  assert.deepEqual(watcher.cardAvatars(jiraIssue), {});
  assert.deepEqual(fetched, []);
});

test('Jira handler embeds the assignee picture in rich mode, fetching it once', async () => {
  const fetched = [];
  const watcher = richWatcher(undefined, { fetched });
  const entry = { conversationId: CONV, messageId: '1700000000000', from: 'Bob Example', previewText: 'x' };
  const rec = recordTransport();
  try {
    await watcher.handleJiraIssueComment(entry, { key: 'EX-1' }, jiraIssue);
    await watcher.handleJiraIssueComment(entry, { key: 'EX-1' }, jiraIssue);
  } finally {
    rec.restore();
  }
  assert.deepEqual(fetched, [ALICE], 'second card is served from the cache');
  for (const call of rec.calls) {
    const images = personImages(sentCard(call));
    assert.equal(images.length, 1);
    assert.equal(images[0].altText, 'Alice Example');
    assert.match(images[0].url, /^data:image\/jpeg;base64,/);
  }
});

test('an unknown or failing lookup leaves the card with names only', async () => {
  const watcher = richWatcher();
  watcher.avatarService = new AvatarService({
    directory,
    fetchPhoto: async () => {
      throw new Error('status 403');
    },
  });
  const entry = { conversationId: CONV, messageId: '1700000000000', from: 'Bob Example', previewText: 'x' };
  const rec = recordTransport();
  try {
    await watcher.handleJiraIssueComment(entry, { key: 'EX-1' }, jiraIssue);
    await watcher.handleJiraIssueComment(entry, { key: 'EX-2' }, { ...jiraIssue, assignee: 'Zed Unknown' });
  } finally {
    rec.restore();
  }
  assert.equal(rec.calls.length, 2);
  for (const call of rec.calls) {
    assert.equal(personImages(sentCard(call)).length, 0, 'no real photo');
    assert.equal(placeholderImages(sentCard(call)).length, 1, 'the neutral placeholder stands in');
  }
});

test('MR cards show the pictures of the approvers once they are prefetched', async () => {
  const fetched = [];
  const watcher = richWatcher(undefined, { fetched });
  const mr = { project: 'group/app', iid: 7, title: 'Example' };
  const details = { title: 'Example', approved: true, approvedBy: ['Alice Example', 'Bob Example'] };
  const before = watcher.buildMrCard(mr, details);
  assert.equal(allPersonImages(before).length, 2, 'a picture each before the prefetch');
  assert.equal(personImages(before).length, 0, 'initials, no photos yet');
  assert.deepEqual(fetched, []);
  await watcher.prefetchAvatars(watcher.mrCardPeopleData(mr, details));
  assert.deepEqual(fetched.sort(), [ALICE, BOB]);
  const names = personImages(watcher.buildMrCard(mr, details)).map((i) => i.altText);
  assert.deepEqual(names, ['Alice Example', 'Bob Example']);
});

test('a late approver photo refreshes the existing MR card once on the next poll', async () => {
  const watcher = richWatcher();
  watcher.config.gitlab.notify = { ci: { enable: true, on_success: true, on_failure: true } };
  watcher.isRecentMrMessage = () => true;
  watcher.refreshBotNames = async () => {};
  watcher.setCommandReaction = async () => {};
  let finishPhoto;
  watcher.avatarService = new AvatarService({
    directory,
    deadlineMs: 10,
    fetchPhoto: () => new Promise((resolve) => { finishPhoto = resolve; }),
  });
  const state = {
    title: 'Example', state: 'opened', status: 'approved', approved: true, approvalKnown: true,
    approvedBy: ['Alice Example'], needsRebase: false, autoMerge: false,
    pipeline: { id: 7, status: 'running' },
  };
  watcher.gitlab.getMrStatus = async () => ({ ...state });
  watcher.gitlab.pipelineLink = (project, id) => `https://gitlab.example.com/${project}/-/pipelines/${id}`;
  const messageId = String(Date.now());
  const mr = { project: 'group/app', iid: 7, title: 'Example', status: 'approved' };
  const entry = { conversationId: CONV, messageId, createdAt: Date.now(), from: 'Bob Example', mrs: [mr] };
  const key = `${CONV}/${messageId}`;
  watcher.watched.set(key, entry);
  const original = { ...transport };
  const calls = [];
  let rejectEdit = true;
  transport.sendMessage = async (...args) => {
    calls.push({ kind: 'send', args });
    return { ok: true, value: { timestamp: '1700000000001' } };
  };
  transport.editMessage = async (...args) => {
    calls.push({ kind: 'edit', args });
    if (rejectEdit) return { ok: false, error: new Error('temporary failure') };
    return { ok: true, value: {} };
  };
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await watcher.checkWatchedKey(key);
    assert.equal(calls.length, 1);
    assert.equal(personImages(sentCard(calls[0].args)).length, 0);
    await watcher.checkWatchedKey(key);
    assert.equal(calls.length, 1, 'no repeated edit while lookup is pending');
    finishPhoto({ kind: 'photo', bytes: fakeJpeg() });
    await new Promise((resolve) => setImmediate(resolve));
    await watcher.checkWatchedKey(key);
    assert.deepEqual(calls.map((call) => call.kind), ['send', 'edit']);
    rejectEdit = false;
    await watcher.checkWatchedKey(key);
    assert.deepEqual(calls.map((call) => call.kind), ['send', 'edit', 'edit'], 'a failed edit is retried');
    const editedCard = JSON.parse(calls[2].args[4].properties.cards)[0].content;
    assert.deepEqual(personImages(editedCard).map((image) => image.altText), ['Alice Example']);
    await watcher.checkWatchedKey(key);
    assert.equal(calls.length, 3, 'the same photo does not trigger further edits');
  } finally {
    clearTimeout(keepAlive);
    Object.assign(transport, original);
  }
});

test('MR merged and closed cards fall back to the last reported approvers', async () => {
  const watcher = richWatcher();
  const mr = { project: 'group/app', iid: 7, title: 'Example', lastReportedApprovalStatus: true, lastReportedApprovedBy: 'Alice Example' };
  await watcher.prefetchAvatars(watcher.mrCardPeopleData(mr, {}));
  const card = watcher.buildMrCard(mr, { title: 'Example' }, { state: 'merged' });
  assert.deepEqual(personImages(card).map((i) => i.altText), ['Alice Example']);
});

test('a card that would outgrow the wire budget with pictures is rebuilt without them', async () => {
  const watcher = richWatcher(undefined, { extra: 5000 });
  await watcher.prefetchAvatars(jiraIssue);
  const markdown = 'Example';
  const build = (pad) => () => {
    const avatars = watcher.cardAvatars(jiraIssue);
    const body = [{ type: 'TextBlock', text: 'x'.repeat(pad) }];
    for (const [name, url] of Object.entries(avatars)) body.push({ type: 'Image', url, altText: name, style: 'Person' });
    return { type: 'AdaptiveCard', version: '1.4', body };
  };
  const plainCard = (pad) => ({ type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text: 'x'.repeat(pad) }] });
  const base = richMessageWireBytes(makeRichMessage(markdown, plainCard(0)));
  // Without the picture it fits with a little room to spare; with it it does not.
  const pad = MAX_CARD_BYTES - base - 200;
  const withoutPicture = richMessageWireBytes(makeRichMessage(markdown, plainCard(pad)));
  assert.ok(withoutPicture <= MAX_CARD_BYTES);
  assert.ok(richMessageWireBytes(makeRichMessage(markdown, build(pad)())) > MAX_CARD_BYTES, 'precondition: picture overflows');

  const message = watcher.richMessage(markdown, build(pad));
  assert.notEqual(message, markdown, 'still a card, not the plain markdown');
  assert.ok(richMessageWireBytes(message) <= MAX_CARD_BYTES);
  assert.ok(!JSON.stringify(message).includes('data:image'), 'no picture in the fallback card');
  assert.equal(watcher.suppressAvatars, false, 'the switch is reset');
  assert.equal(Object.keys(watcher.cardAvatars(jiraIssue)).length, 1, 'later cards get their pictures again');
});

const authorOf = (card) => card.body[0].items.find((i) => i.type === 'ColumnSet' && i.columns[0].items[0].text === 'Author');
// A picture-less author: a text row (the state badge row turns the facts into aligned rows).
const plainAuthor = (card) => authorOf(card)?.columns.slice(1).flatMap((c) => c.items.map((i) => i.text))[0];

test('MR card prefetches and shows the author with the picture, fetching it once', async () => {
  const fetched = [];
  const watcher = richWatcher(undefined, { fetched });
  const mr = { project: 'group/app', iid: 7, title: 'Example' };
  const details = { title: 'Example', author: 'Alice Example' };
  assert.deepEqual(watcher.mrCardPeopleData(mr, details).author, 'Alice Example');
  assert.equal(personImages(watcher.buildMrCard(mr, details)).length, 0, 'building never fetches');
  await watcher.prefetchAvatars(watcher.mrCardPeopleData(mr, details));
  await watcher.prefetchAvatars(watcher.mrCardPeopleData(mr, details));
  assert.deepEqual(fetched, [ALICE]);
  const row = authorOf(watcher.buildMrCard(mr, details));
  assert.equal(row.columns[0].items[0].text, 'Author');
  assert.equal(row.columns[1].width, 'stretch', 'one stretch value column');
  const [line, ...more] = row.columns[1].items;
  assert.equal(more.length, 0, 'one person, one line');
  assert.deepEqual(line.columns.map((c) => c.items[0].text ?? c.items[0].altText).filter((t) => t !== ''), ['Alice Example', 'Alice Example']);
  assert.match(line.columns[0].items[0].url, /^data:image\/jpeg;base64,/);
});

test('MR card author: list entry object, then the last seen one when a refresh has none', async () => {
  const watcher = richWatcher();
  const mr = { project: 'group/app', iid: 7, title: 'Example', author: { username: 'alice', name: 'Alice Example' } };
  assert.equal(watcher.mrCardAuthor(mr, {}), 'Alice Example');
  assert.equal(watcher.mrCardAuthor({ author: { username: 'bob' } }, {}), 'bob', 'username when there is no name');
  const tracked = { project: 'group/app', iid: 8, title: 'Other' };
  assert.equal(watcher.mrCardAuthor(tracked, { author: 'Bob Example' }), 'Bob Example');
  assert.equal(watcher.mrCardAuthor(tracked, {}), 'Bob Example', 'a failed lookup keeps the author');
  assert.equal(watcher.mrCardAuthor(null, null), '');
  const card = watcher.buildMrCard({ project: 'group/app', iid: 9, title: 'Third' }, { title: 'Third' });
  assert.equal(plainAuthor(card), undefined, 'no author, no row');
});

test('MR card author without a picture (unknown person, regular mode) is a plain Author fact', async () => {
  const watcher = richWatcher();
  const mr = { project: 'group/app', iid: 7, title: 'Example' };
  const details = { title: 'Example', author: 'Zed Nobody' };
  await watcher.prefetchAvatars(watcher.mrCardPeopleData(mr, details));
  const card = watcher.buildMrCard(mr, details);
  assert.equal(personImages(card).length, 0);
  assert.equal(placeholderImages(card).length, 1, 'an unresolved author gets the placeholder, never a looked-up photo');
  assert.deepEqual(authorOf(card).columns[1].items.flatMap((l) => l.columns.map((c) => c.items[0].text ?? c.items[0].altText).filter((t) => t !== '')), ['Zed Nobody', 'Zed Nobody']);

  const fetched = [];
  const regular = richWatcher({}, { fetched });
  await regular.prefetchAvatars(regular.mrCardPeopleData(mr, { author: 'Alice Example' }));
  assert.deepEqual(fetched, [], 'regular mode makes no request');
});

test('an MR card with the author picture that would outgrow the wire budget keeps the author name, drops the photo', async () => {
  const watcher = richWatcher(undefined, { extra: 3500 });
  const mr = { project: 'group/app', iid: 7, title: 'Example' };
  const details = { title: 'Example', author: 'Alice Example' };
  await watcher.prefetchAvatars(watcher.mrCardPeopleData(mr, details));
  const build = () => watcher.buildMrCard(mr, details);
  const size = (markdown) => richMessageWireBytes(makeRichMessage(markdown, build()));
  const withPhoto = size('x');
  const withoutPhoto = (() => {
    watcher.suppressAvatars = true;
    try {
      return size('x');
    } finally {
      watcher.suppressAvatars = false;
    }
  })();
  assert.ok(withPhoto - withoutPhoto > 3000, 'the photo is what the size is made of');
  // Pad the plain fallback text so that only the photo-less card fits.
  const markdown = 'x'.repeat(MAX_CARD_BYTES - withoutPhoto - 100);
  assert.ok(size(markdown) > MAX_CARD_BYTES, 'precondition: overflows with the photo');
  const message = watcher.richMessage(markdown, build);
  assert.notEqual(message, markdown, 'still a card');
  assert.ok(richMessageWireBytes(message) <= MAX_CARD_BYTES);
  const sent = message.card;
  assert.equal(personImages(sent).length, 0, 'the photo is gone (the service logos stay)');
  assert.equal(plainAuthor(sent), 'Alice Example');
});

test('a merged MR (approvals not fetched again) still loads the pictures of the last reported approvers', () => {
  const w = new MergeRequestWatcher({
    config: { conversations: [], gitlab: { group: 'example-group', notify: {} }, teams: { rich_messages: true } },
    gitlab: { findMrLinks: () => [], mrLink: () => '', pipelineLink: () => '', getMr: async () => null },
    jira: null,
    opsgenie: null,
  });
  const mr = { project: 'g/a', iid: 1, lastReportedApprovedBy: 'MS Teams bot, Alice Example' };
  // GitLab's answer for a merged MR carries an empty approver list.
  const people = w.mrCardPeopleData(mr, { approvedBy: [] });
  assert.deepEqual(people.approvedBy, ['MS Teams bot', 'Alice Example']);
  const fresh = w.mrCardPeopleData(mr, { approvedBy: ['Bob Example'] });
  assert.deepEqual(fresh.approvedBy, ['Bob Example', 'MS Teams bot', 'Alice Example']);
});

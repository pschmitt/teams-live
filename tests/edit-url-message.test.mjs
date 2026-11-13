import test from 'node:test';
import assert from 'node:assert/strict';
import { MergeRequestWatcher, isMessageOnlyUrl, isSameUrl } from '../src/watcher.mjs';

test('isSameUrl normalizes protocol, trailing slash, and case', () => {
  assert.equal(
    isSameUrl('https://gitlab.example.com/foo/bar', 'https://gitlab.example.com/foo/bar/'),
    true
  );
  assert.equal(
    isSameUrl('HTTPS://GITLAB.EXAMPLE.COM/foo/bar', 'https://gitlab.example.com/foo/bar'),
    true
  );
  assert.equal(
    isSameUrl('https://gitlab.example.com/foo/bar?view=diff', 'https://gitlab.example.com/foo/bar?view=diff'),
    true
  );
  assert.equal(
    isSameUrl('https://gitlab.example.com/foo/bar?a=1', 'https://gitlab.example.com/foo/bar?b=2'),
    false
  );
  assert.equal(
    isSameUrl('https://gitlab.example.com/foo/bar', 'https://gitlab.example.com/foo/baz'),
    false
  );
});

test('isMessageOnlyUrl accurately detects single-URL messages', () => {
  const url = 'https://gitlab.example.com/group/infrastructure/-/merge_requests/42';

  // Plain URL text
  assert.equal(isMessageOnlyUrl(url), true);
  assert.equal(isMessageOnlyUrl(`  ${url}\n\n  `), true);

  // Teams auto-linked HTML
  const htmlSingle = `<p><a href="${url}">${url}</a></p>`;
  assert.equal(isMessageOnlyUrl(url, htmlSingle), true);

  const htmlWithNbsp = `<div><p><a href="${url}">${url}</a>&nbsp;</p></div>`;
  assert.equal(isMessageOnlyUrl(url, htmlWithNbsp), true);

  // Message with extra commentary MUST return false
  assert.equal(isMessageOnlyUrl(`Please review ${url}`), false);
  assert.equal(isMessageOnlyUrl(`${url} - looks good`), false);

  const htmlWithComment = `<p>Hey team <a href="${url}">${url}</a></p>`;
  assert.equal(isMessageOnlyUrl(htmlWithComment, htmlWithComment), false);

  // Multiple URLs MUST return false
  assert.equal(isMessageOnlyUrl(`${url} https://jira.example.com/browse/DOCS-123`), false);

  // No URL
  assert.equal(isMessageOnlyUrl('Hello world'), false);
  assert.equal(isMessageOnlyUrl(''), false);
  assert.equal(isMessageOnlyUrl(null), false);
});

test('shouldEditOriginalMessage behavior under config toggle', () => {
  const selfOid = 'f94ccd0d-d140-4d1d-9fee-b00e642b9c11';
  const selfMri = `8:orgid:${selfOid}`;
  const targetUrl = 'https://gitlab.example.com/group/infrastructure/-/merge_requests/42';

  // 1. When edit_own_url_messages is FALSE (default)
  const watcherDisabled = new MergeRequestWatcher({
    config: {
      conversations: [],
      gitlab: {},
      teams: { edit_own_url_messages: false },
    },
    gitlab: { findMrLinks: () => [] },
    jira: null,
    opsgenie: null,
  });
  watcherDisabled.setSelfMri(selfMri);

  const selfUrlEntry = {
    isSelf: true,
    isOnlyUrl: true,
    targetUrl,
  };
  assert.equal(watcherDisabled.shouldEditOriginalMessage(selfUrlEntry, targetUrl), false);

  // 2. When edit_own_url_messages is TRUE
  const watcherEnabled = new MergeRequestWatcher({
    config: {
      conversations: [],
      gitlab: {},
      teams: { edit_own_url_messages: true },
    },
    gitlab: { findMrLinks: () => [] },
    jira: null,
    opsgenie: null,
  });
  watcherEnabled.setSelfMri(selfMri);

  // Self + only URL -> true
  assert.equal(watcherEnabled.shouldEditOriginalMessage(selfUrlEntry, targetUrl), true);
  // Matching trailing slash differences -> true
  assert.equal(watcherEnabled.shouldEditOriginalMessage(selfUrlEntry, `${targetUrl}/`), true);

  // Not self (from colleague) -> false
  const colleagueEntry = {
    isSelf: false,
    isOnlyUrl: true,
    targetUrl,
  };
  assert.equal(watcherEnabled.shouldEditOriginalMessage(colleagueEntry, targetUrl), false);

  // Self, but message contained extra text -> false
  const textAndUrlEntry = {
    isSelf: true,
    isOnlyUrl: false,
    targetUrl,
  };
  assert.equal(watcherEnabled.shouldEditOriginalMessage(textAndUrlEntry, targetUrl), false);

  // Different URL target -> false
  assert.equal(watcherEnabled.shouldEditOriginalMessage(selfUrlEntry, 'https://other.url/123'), false);
});

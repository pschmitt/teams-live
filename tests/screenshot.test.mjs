import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ScreenshotClient } from '../src/screenshot.mjs';
import { extractCandidateUrls, MergeRequestWatcher } from '../src/watcher.mjs';
import { BOT_WATERMARK } from '../src/teams.mjs';

test('ScreenshotClient isConfigured and getSecret', () => {
  const unconf = new ScreenshotClient({});
  assert.equal(unconf.isConfigured(), false);
  assert.equal(unconf.getSecret(), null);

  const direct = new ScreenshotClient({
    url: 'https://browser.example.com',
    cluster_secret: 'secret-123',
  });
  assert.equal(direct.isConfigured(), true);
  assert.equal(direct.getSecret(), 'secret-123');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-live-ss-'));
  const secretFile = path.join(tmpDir, 'cluster-secret');
  fs.writeFileSync(secretFile, 'file-secret-456\n', 'utf8');

  const fromFile = new ScreenshotClient({
    url: 'https://browser.example.com',
    secret_file: secretFile,
  });
  assert.equal(fromFile.isConfigured(), true);
  assert.equal(fromFile.getSecret(), 'file-secret-456');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('ScreenshotClient capture sends POST /api/run with secret and returns base64 image', async () => {
  let receivedHeaders = null;
  let receivedBody = null;

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/run') {
      receivedHeaders = req.headers;
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        receivedBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: 'base64-image-data-xyz' }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const client = new ScreenshotClient({
      url: `http://127.0.0.1:${port}`,
      cluster_secret: 'my-cluster-secret',
    });

    const result = await client.capture('https://example.com/some/page');
    assert.equal(result, 'base64-image-data-xyz');
    assert.equal(receivedHeaders['x-browser-cluster-secret'], 'my-cluster-secret');
    assert.equal(receivedBody.url, 'https://example.com/some/page');
    assert.ok(receivedBody.script.includes('page.screenshot'));
  } finally {
    server.close();
  }
});

test('ScreenshotClient capture handles error or non-ok result', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/run') {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'navigation error' }));
      return;
    }
    res.writeHead(500);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const client = new ScreenshotClient({
      url: `http://127.0.0.1:${port}`,
      cluster_secret: 'sec',
    });

    const result = await client.capture('https://bad.example.com');
    assert.equal(result, null);
  } finally {
    server.close();
  }
});

test('extractCandidateUrls extracts valid HTTP/HTTPS URLs and filters out noise', () => {
  const text = 'Check out https://news.ycombinator.com/item?id=123. Also visit http://example.com/foo!';
  const urls = extractCandidateUrls(text);
  assert.deepEqual(urls, [
    'https://news.ycombinator.com/item?id=123',
    'http://example.com/foo',
  ]);

  // Filters out localhost, private IPs, teams URLs, and direct media files
  const filtered = extractCandidateUrls(
    'Links: http://localhost:8080/test, https://192.168.1.1/admin, https://teams.microsoft.com/l/message/123, https://example.com/image.png, https://github.com/torvalds/linux'
  );
  assert.deepEqual(filtered, ['https://github.com/torvalds/linux']);

  // Ignores blockquotes and reply divs
  const quoted = extractCandidateUrls(
    'Outside link: https://outside.com',
    '<blockquote>Quoted <a href="https://quoted.com">quoted</a></blockquote><div itemtype="http://schema.skype.com/Reply"><a href="https://reply.com">reply</a></div><p><a href="https://real.com">real</a></p>'
  );
  assert.deepEqual(quoted, ['https://real.com/', 'https://outside.com/']);
});

test('findUnrecognizedLinks separates recognized links from arbitrary web links', () => {
  const fakeGitlab = {
    findMrLinks: (t) => (t.includes('merge_requests') ? [{ project: 'p', iid: 1 }] : []),
    findJobLinks: (t) => (t.includes('/-/jobs/') ? [{ project: 'p', jobId: 2 }] : []),
    findPipelineLinks: (t) => (t.includes('/-/pipelines/') ? [{ project: 'p', pipelineId: 3 }] : []),
  };
  const fakeJira = {
    findIssueLinks: (t) => (t.includes('/browse/') ? [{ issueKey: 'CKS-123' }] : []),
  };
  const fakeConfluence = {
    findPageLinks: (t) => (t.includes('/pages/') ? [{ target: 'doc' }] : []),
  };
  const fakeOpsgenie = {
    findAlertLinks: (t) => (t.includes('/alert/') ? [{ alertId: 'a1' }] : []),
  };

  const watcher = new MergeRequestWatcher({
    config: { conversations: [{ id: 'c1' }], gitlab: {} },
    gitlab: fakeGitlab,
    jira: fakeJira,
    confluence: fakeConfluence,
    opsgenie: fakeOpsgenie,
  });

  const text = [
    'GitLab MR: https://git.wiit.one/k8s/app/-/merge_requests/42',
    'Jira: https://jira.wiit.one/browse/CKS-999',
    'Confluence: https://wiki.wiit.one/pages/viewpage.action?pageId=555',
    'OpsGenie: https://app.opsgenie.com/alert/detail/xyz/details',
    'Arbitrary 1: https://news.ycombinator.com',
    'Arbitrary 2: https://github.com/nodejs/node',
  ].join('\n');

  const unrecognized = watcher.findUnrecognizedLinks(text);
  assert.deepEqual(unrecognized, [
    'https://news.ycombinator.com/',
    'https://github.com/nodejs/node',
  ]);
});

test('maybeAttachLinkThumbnail attaches thumbnail only for self messages with unrecognized links', async () => {
  let capturedUrl = null;
  const fakeScreenshot = {
    isConfigured: () => true,
    capture: async (url) => {
      capturedUrl = url;
      return 'fake-b64-jpeg';
    },
  };

  const watcher = new MergeRequestWatcher({
    config: { conversations: [{ id: 'c1' }], gitlab: {} },
    gitlab: { findMrLinks: () => [], findJobLinks: () => [], findPipelineLinks: () => [] },
    jira: { findIssueLinks: () => [] },
    confluence: { findPageLinks: () => [] },
    opsgenie: { findAlertLinks: () => [] },
    screenshot: fakeScreenshot,
  });

  watcher.setSelfMri('8:orgid:f94ccd0d-d140-4d1d-9fee-b00e642b9c11');

  // 1. Non-self message -> ignored
  const otherEvent = {
    conversationId: 'c1',
    messageId: '1001',
    from: 'Alice Other',
    fromMri: '8:orgid:other-user-guid',
    content: 'Check https://xkcd.com/327/',
  };
  assert.equal(watcher.isSenderSelf(otherEvent), false);
  await watcher.maybeAttachLinkThumbnail(otherEvent);
  assert.equal(capturedUrl, null);

  // 2. Self message with recognized link -> ignored
  const recognizedEvent = {
    conversationId: 'c1',
    messageId: '1002',
    from: 'Philipp Schmitt',
    fromMri: '8:orgid:f94ccd0d-d140-4d1d-9fee-b00e642b9c11',
    content: 'MR is here',
  };
  watcher.isRecognizedUrl = () => true;
  assert.equal(watcher.isSenderSelf(recognizedEvent), true);
  await watcher.maybeAttachLinkThumbnail(recognizedEvent);
  assert.equal(capturedUrl, null);

  // 3. Self message with watermark -> ignored
  watcher.isRecognizedUrl = () => false;
  const watermarkedEvent = {
    conversationId: 'c1',
    messageId: '1003',
    from: 'Philipp Schmitt',
    fromMri: '8:orgid:f94ccd0d-d140-4d1d-9fee-b00e642b9c11',
    content: `Already edited ${BOT_WATERMARK} https://xkcd.com/327/`,
  };
  await watcher.maybeAttachLinkThumbnail(watermarkedEvent);
  assert.equal(capturedUrl, null);

  // 4. Valid self message with unrecognized link
  const validEvent = {
    conversationId: 'c1',
    messageId: '1004',
    from: 'Philipp Schmitt',
    fromMri: '8:orgid:f94ccd0d-d140-4d1d-9fee-b00e642b9c11',
    content: 'Cool comic: https://xkcd.com/327/',
    rawHtml: '<p>Cool comic: <a href="https://xkcd.com/327/">https://xkcd.com/327/</a></p>',
  };

  // We mock the teams edit function by monkey-patching appendThumbnailToMessage in teams.mjs or verifying capture
  await watcher.maybeAttachLinkThumbnail(validEvent);
  assert.equal(capturedUrl, 'https://xkcd.com/327/');
  assert.ok(watcher.thumbnailEditedMessageIds.has('1004'));

  // 5. Subsequent call for same message ID -> ignored
  capturedUrl = null;
  await watcher.maybeAttachLinkThumbnail(validEvent);
  assert.equal(capturedUrl, null);
});

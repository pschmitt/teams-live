import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfluenceClient } from '../src/confluence.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';

test('ConfluenceClient.findPageLinks extracts various Confluence URL formats', () => {
  const client = new ConfluenceClient({ url: 'https://wiki.example.com', token: 'dummy-token' });

  const text = `
    Check out this doc: https://wiki.example.com/display/DOCS/Cluster+Architecture
    Also this one: https://wiki.example.com/pages/viewpage.action?pageId=12345
    And spaces link: https://wiki.example.com/spaces/IS/pages/753793/Example+Handbook
    Tiny link: https://wiki.example.com/x/gYAL
    Unrelated link: https://google.com/search?q=confluence
  `;

  const links = client.findPageLinks(text);
  assert.equal(links.length, 4);

  assert.equal(links[0].spaceKey, 'DOCS');
  assert.equal(links[0].title, 'Cluster Architecture');

  assert.equal(links[1].id, '12345');

  assert.equal(links[2].id, '753793');

  assert.equal(links[3].tinyId, 'gYAL');
});

test('ConfluenceClient.findPageLinks ignores quotes and replies by default', () => {
  const client = new ConfluenceClient({ url: 'https://wiki.example.com', token: 'dummy-token' });

  const text = `
    <blockquote>https://wiki.example.com/display/DOCS/Quoted+Page</blockquote>
    <div itemtype="http://schema.skype.com/Reply">https://wiki.example.com/display/DOCS/Reply+Page</div>
    Direct link: https://wiki.example.com/display/DOCS/Direct+Page
  `;

  const links = client.findPageLinks(text);
  assert.equal(links.length, 1);
  assert.equal(links[0].title, 'Direct Page');

  const linksWithQuotes = client.findPageLinks(text, { allowQuotes: true });
  assert.equal(linksWithQuotes.length, 3);
});

test('ConfluenceClient.getPage retrieves page by ID or space+title', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/rest/api/content/12345')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: '12345',
            title: 'Sample Page Title',
            space: { key: 'DOCS', name: 'Documentation Space' },
            version: { number: 3, by: { displayName: 'Max Mustermann' } },
            _links: { webui: '/display/DOCS/Sample+Page+Title' },
          }),
        };
      }
      if (urlStr.includes('/rest/api/content?') && urlStr.includes('spaceKey=DOCS')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                id: '67890',
                title: 'Space Title Doc',
                space: { key: 'DOCS', name: 'Documentation Space' },
                version: { number: 1, by: { displayName: 'Erika Mustermann' } },
                _links: { webui: '/display/DOCS/Space+Title+Doc' },
              },
            ],
          }),
        };
      }
      return { ok: false, status: 404, text: async () => 'Not found' };
    };

    const client = new ConfluenceClient({ url: 'https://wiki.example.com', token: 'dummy-token' });

    // By ID
    const pageById = await client.getPage('12345');
    assert.equal(pageById.id, '12345');
    assert.equal(pageById.title, 'Sample Page Title');
    assert.equal(pageById.spaceKey, 'DOCS');
    assert.equal(pageById.spaceName, 'Documentation Space');
    assert.equal(pageById.author, 'Max Mustermann');
    assert.equal(pageById.url, 'https://wiki.example.com/display/DOCS/Sample+Page+Title');

    // By URL with pageId
    const pageByUrl = await client.getPage('https://wiki.example.com/pages/viewpage.action?pageId=12345');
    assert.equal(pageByUrl.title, 'Sample Page Title');

    // By space + title object
    const pageBySpaceTitle = await client.getPage({ spaceKey: 'DOCS', title: 'Space Title Doc' });
    assert.equal(pageBySpaceTitle.id, '67890');
    assert.equal(pageBySpaceTitle.title, 'Space Title Doc');
    assert.equal(pageBySpaceTitle.author, 'Erika Mustermann');

    // By display URL
    const pageByDisplayUrl = await client.getPage('https://wiki.example.com/display/DOCS/Space+Title+Doc');
    assert.equal(pageByDisplayUrl.id, '67890');
    assert.equal(pageByDisplayUrl.title, 'Space Title Doc');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ConfluenceClient reports auth errors on 401', async () => {
  const originalFetch = globalThis.fetch;
  let authErrorReported = null;
  try {
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    const client = new ConfluenceClient({
      url: 'https://wiki.example.com',
      token: 'bad-token',
      onAuthError: (err) => {
        authErrorReported = err;
      },
    });

    await assert.rejects(() => client.getPage('12345'), /HTTP 401/);
    assert.match(authErrorReported, /Confluence HTTP 401/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('MergeRequestWatcher formats Confluence message and watches Confluence links', () => {
  const watcher = new MergeRequestWatcher({
    config: { gitlab: {}, conversations: [] },
    gitlab: { findMrLinks: () => [], findJobLinks: () => [], findPipelineLinks: () => [] },
    jira: { findIssueLinks: () => [] },
    confluence: new ConfluenceClient({ url: 'https://wiki.example.com', token: 'test' }),
    opsgenie: { findAlertLinks: () => [] },
    authManager: null,
  });

  const page = {
    id: '12345',
    title: 'Cluster Networking Guide',
    spaceKey: 'DOCS',
    spaceName: 'Documentation Space',
    author: 'Alice Example',
    url: 'https://wiki.example.com/display/DOCS/Cluster+Networking+Guide',
  };

  const formatted = watcher.formatConfluencePageMessage(page);
  assert.match(formatted, /📄 \*\*Cluster Networking Guide\*\*/);
  assert.match(formatted, /🔗 \[Cluster Networking Guide\]\(https:\/\/wiki\.example\.com\/display\/DOCS\/Cluster\+Networking\+Guide\)/);
  assert.match(formatted, /Documentation Space \(DOCS\)/);
  assert.match(formatted, /👤 Last edited by: Alice Example/);

  // Watch call
  const text = 'Here is the documentation: https://wiki.example.com/display/DOCS/Cluster+Networking+Guide';
  watcher.watch('19:channel@thread.v2', '1234567890', text);

  const entry = watcher.watched.get('19:channel@thread.v2/1234567890');
  assert.ok(entry);
  assert.equal(entry.confluencePages.length, 1);
  assert.equal(entry.confluencePages[0].key, 'doc:DOCS:Cluster Networking Guide');
});

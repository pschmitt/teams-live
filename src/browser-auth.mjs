import { writeSessionState, clearTokenCache } from 'msteams-mcp/dist/auth/session-store.js';
import { extractMessageAuth } from 'msteams-mcp/dist/auth/token-extractor.js';

const log = (...args) => console.error(new Date().toISOString(), '[browser-auth]', ...args);

export async function acquireFromBrowserDaemon(bdConfig) {
  if (!bdConfig?.url) return null;

  const url = bdConfig.url.replace(/\/+$/, '');
  const profileName = bdConfig.profile || 'work';
  const secret = bdConfig.cluster_secret || '';

  const headers = {};
  if (secret) {
    headers['X-Browser-Cluster-Secret'] = secret;
  }

  // 1. Fetch overview
  const ovRes = await fetch(`${url}/api/mesh/overview`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!ovRes.ok) {
    throw new Error(`Overview request failed: HTTP ${ovRes.status}`);
  }
  const ov = await ovRes.json();
  const localNode = ov.local_node?.name;

  const prof = (ov.profiles || []).find(p => p.name === profileName);
  if (!prof) {
    throw new Error(`Profile "${profileName}" not found in browser-daemon`);
  }

  const prefix = prof.node_name && prof.node_name !== localNode ? `/api/peers/${encodeURIComponent(prof.node_name)}` : '';

  // 2. Locate active Teams tab in the profile's session
  let target = (ov.targets || []).find(
    t => (prof.session_id ? t.sessionId === prof.session_id : true) &&
         t.url &&
         (t.url.includes('teams.cloud.microsoft') || t.url.includes('teams.microsoft.com'))
  );

  let openedTabId = null;
  let targetId = target?.id;

  if (!targetId) {
    log(`No active Teams tab found in session ${prof.session_id}, opening tab...`);
    const openRes = await fetch(`${url}${prefix}/json/new?https://teams.cloud.microsoft/`, {
      method: 'PUT',
      headers,
      signal: AbortSignal.timeout(20000),
    });
    if (!openRes.ok) {
      throw new Error(`Failed to open Teams tab: HTTP ${openRes.status}`);
    }
    const newPage = await openRes.json();
    targetId = newPage.id;
    openedTabId = targetId;
    await new Promise(r => setTimeout(r, 5000));
  }

  // 3. Export auth
  try {
    const authUrl = `${url}${prefix}/api/pages/${encodeURIComponent(targetId)}/auth`;
    const authRes = await fetch(authUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: prof.session_id,
        storage: true,
        urls: [
          'https://teams.microsoft.com',
          'https://teams.cloud.microsoft',
          'https://asm.skype.com',
          'https://login.microsoftonline.com',
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!authRes.ok) {
      const errText = await authRes.text().catch(() => '');
      throw new Error(`Auth export failed (HTTP ${authRes.status}): ${errText.slice(0, 200)}`);
    }

    const authData = await authRes.json();
    const storage = authData.local_storage || {};

    // 4. Find Spaces token
    let spacesToken = null;
    for (const [k, v] of Object.entries(storage)) {
      if (k.includes('spaces.skype.com')) {
        try {
          const parsed = JSON.parse(v);
          if (parsed.secret && typeof parsed.secret === 'string' && parsed.secret.startsWith('ey')) {
            spacesToken = parsed.secret;
            break;
          }
        } catch {}
      }
    }

    if (!spacesToken) {
      throw new Error('No valid Skype Spaces token found in Teams page storage');
    }

    // 5. Exchange Spaces token for skypeToken via authsvc
    const authzRes = await fetch('https://authsvc.teams.microsoft.com/v1.0/authz', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${spacesToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(15000),
    });

    if (!authzRes.ok) {
      const errText = await authzRes.text().catch(() => '');
      throw new Error(`Skype token exchange failed (HTTP ${authzRes.status}): ${errText.slice(0, 200)}`);
    }

    const authzData = await authzRes.json();
    const skypeToken = authzData.tokens?.skypeToken;
    const expiresIn = authzData.tokens?.expiresIn || 86400;

    if (!skypeToken) {
      throw new Error('authsvc returned no skypeToken');
    }

    // 6. Assemble cookies and origins for session-state
    const sameSite = { strict: 'Strict', lax: 'Lax', none: 'None' };
    const nowSec = Math.floor(Date.now() / 1000);
    const cookies = (authData.cookies || []).map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      expires: typeof cookie.expires === 'number' && cookie.expires > 0 ? cookie.expires : -1,
      httpOnly: cookie.http_only ?? false,
      secure: cookie.secure ?? true,
      sameSite: sameSite[(cookie.same_site || '').toLowerCase()] || 'Lax',
    }));

    for (const domain of ['.asyncgw.teams.microsoft.com', '.asm.skype.com', 'teams.microsoft.com', 'teams.cloud.microsoft']) {
      cookies.push({
        name: 'skypetoken_asm',
        value: skypeToken,
        domain,
        path: '/',
        expires: nowSec + expiresIn,
        httpOnly: true,
        secure: true,
        sameSite: 'None',
      });
    }

    cookies.push({
      name: 'authtoken',
      value: `Bearer%3D${encodeURIComponent(spacesToken)}`,
      domain: 'teams.microsoft.com',
      path: '/',
      expires: nowSec + expiresIn,
      httpOnly: false,
      secure: true,
      sameSite: 'None',
    });

    const sessionState = {
      cookies,
      origins: [
        {
          origin: new URL(authData.url || 'https://teams.cloud.microsoft').origin,
          localStorage: Object.entries(storage).map(([name, value]) => ({ name, value })),
        },
      ],
    };

    // 7. Write session state and clear token cache
    writeSessionState(sessionState);
    clearTokenCache();

    const auth = extractMessageAuth(sessionState);
    if (!auth) {
      throw new Error('Failed to extract message auth from assembled session state');
    }

    log(`Successfully acquired credentials from browser-daemon for ${auth.userMri}`);
    return auth;
  } finally {
    if (openedTabId) {
      fetch(`${url}${prefix}/json/close/${encodeURIComponent(openedTabId)}`, {
        headers,
      }).catch(() => {});
    }
  }
}

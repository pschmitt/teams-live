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

  let sessionId = prof.session_id;
  if (!sessionId) {
    log(`Profile "${profileName}" has no active session, creating session...`);
    const sessRes = await fetch(`${url}${prefix}/api/sessions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile: profileName,
        persistent: true,
        engine: 'chromium',
        default_tabs: false,
        idle_timeout_minutes: 30,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!sessRes.ok) {
      throw new Error(`Failed to create browser session: HTTP ${sessRes.status}`);
    }
    const sessData = await sessRes.json();
    sessionId = sessData.id;
  }

  const isTeamsUrl = (u) => {
    try {
      const parsed = new URL(u);
      return ['teams.cloud.microsoft', 'teams.microsoft.com'].includes(parsed.hostname.toLowerCase());
    } catch {
      return false;
    }
  };

  // 2. Locate active Teams page tab in the profile's session
  const targets = ov.targets || [];
  let target = targets.find(
    t => t.type === 'page' &&
         (sessionId ? (t.sessionId === sessionId || t.session_id === sessionId) : true) &&
         isTeamsUrl(t.url)
  );

  let openedTabId = null;
  let targetId = target?.id;

  if (!targetId) {
    log(`No active Teams page tab found in session ${sessionId}, opening tab...`);
    const query = new URLSearchParams({ url: 'https://teams.cloud.microsoft/', session_id: sessionId });
    const openRes = await fetch(`${url}${prefix}/json/new?${query}`, {
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
    await new Promise(r => setTimeout(r, 6000));
  }

  // 3. Export auth and find Spaces token
  try {
    let spacesToken = null;
    let refreshToken = null;
    let authData = null;
    let storage = {};

    const authUrl = `${url}${prefix}/api/pages/${encodeURIComponent(targetId)}/auth`;
    const maxAttempts = 5;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const authRes = await fetch(authUrl, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
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

      authData = await authRes.json();
      storage = authData.local_storage || {};

      for (const [k, v] of Object.entries(storage)) {
        try {
          const parsed = JSON.parse(v);
          if (parsed.credentialType === 'RefreshToken' && parsed.secret && typeof parsed.secret === 'string' && parsed.secret.startsWith('1.')) {
            refreshToken = parsed.secret;
          }
          const targetScope = parsed.target || '';
          if ((k.includes('spaces.skype.com') || targetScope.includes('spaces.skype.com')) &&
              parsed.secret && typeof parsed.secret === 'string' && parsed.secret.startsWith('ey')) {
            spacesToken = parsed.secret;
          }
        } catch {}
      }

      if (spacesToken) {
        break;
      }

      if (attempt < maxAttempts) {
        log(`Waiting for Skype Spaces token in localStorage (attempt ${attempt}/${maxAttempts})...`);
        await new Promise(r => setTimeout(r, 3000));
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
          origin: new URL(authData?.url || 'https://teams.cloud.microsoft').origin,
          localStorage: Object.entries(storage).map(([name, value]) => ({ name, value })),
        },
      ],
      ...(refreshToken ? { refreshToken } : {}),
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
      try {
        const sessionRes = await fetch(`${url}${prefix}/api/sessions/${encodeURIComponent(sessionId)}`, {
          headers,
          signal: AbortSignal.timeout(10000),
        });
        if (!sessionRes.ok) throw new Error('Could not inspect browser session');
        const { session } = await sessionRes.json();
        if (!Number.isInteger(session?.tabs_count)) throw new Error('Missing browser tab count');
        if (session.tabs_count <= 1) {
          // Chromium exits when its last tab closes, leaving a stale daemon session.
          const query = new URLSearchParams({ url: 'about:blank', session_id: sessionId });
          const blankRes = await fetch(`${url}${prefix}/json/new?${query}`, {
            method: 'PUT',
            headers,
            signal: AbortSignal.timeout(10000),
          });
          if (!blankRes.ok) throw new Error('Could not keep browser session open');
        }
        const closeRes = await fetch(`${url}${prefix}/json/close/${encodeURIComponent(openedTabId)}`, {
          method: 'PUT',
          headers,
          signal: AbortSignal.timeout(10000),
        });
        if (!closeRes.ok) throw new Error('Could not close authentication tab');
      } catch {
        log('Could not safely close the temporary authentication tab');
      }
    }
  }
}

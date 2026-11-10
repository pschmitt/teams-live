import {
  sendMessage,
  getThreadMessages,
  getMessage as mcpGetMessage,
  editMessage,
  parseContentWithMentionsAndLinks,
} from 'msteams-mcp/dist/api/chatsvc-messaging.js';
import { addReaction as mcpAddReaction, removeReaction as mcpRemoveReaction } from 'msteams-mcp/dist/api/chatsvc-reactions.js';
import { getCalendarView as mcpGetCalendarView } from 'msteams-mcp/dist/api/calendar-api.js';
import { requireSkypeSpacesAuth, requireMessageAuthWithConfig } from 'msteams-mcp/dist/utils/auth-guards.js';
import { httpRequest } from 'msteams-mcp/dist/utils/http.js';
import { markdownToTeamsHtml } from 'msteams-mcp/dist/utils/parsers-markdown.js';
import { refreshTokensViaHttp } from 'msteams-mcp/dist/auth/token-refresh-http.js';
import { searchPeople as mcpSearchPeople } from 'msteams-mcp/dist/api/substrate-api.js';
import { resolveProfiles as mcpResolveProfiles } from 'msteams-mcp/dist/api/profile-api.js';

export {
  sendMessage,
  getThreadMessages,
  editMessage,
  markdownToTeamsHtml,
  parseContentWithMentionsAndLinks,
};

export async function getMessage(conversationId, messageId) {
  let res = await mcpGetMessage(conversationId, messageId);
  if (!res.ok && (await attemptTokenRefreshOnAuthError(res))) {
    res = await mcpGetMessage(conversationId, messageId);
  }
  return res;
}

async function attemptTokenRefreshOnAuthError(res) {
  if (!res || res.ok) return false;
  const errText = (res.error?.message || '').toLowerCase();
  const isAuth =
    errText.includes('auth') ||
    errText.includes('unauthorized') ||
    errText.includes('401') ||
    res.error?.code === 'AUTH_EXPIRED' ||
    res.error?.code === 'AUTH_REQUIRED';
  if (!isAuth) return false;

  console.warn(new Date().toISOString(), `[teams] Auth error detected (${res.error?.message}), attempting token refresh...`);
  try {
    const refreshed = await refreshTokensViaHttp();
    if (refreshed.ok) {
      console.log(new Date().toISOString(), '[teams] Token refresh succeeded, retrying operation...');
      return true;
    }
  } catch (err) {
    console.error(new Date().toISOString(), '[teams] Token refresh threw:', err.message);
  }
  return false;
}

export async function addReaction(conversationId, messageId, emojiKey) {
  let res = await mcpAddReaction(conversationId, messageId, emojiKey);
  if (!res.ok && (await attemptTokenRefreshOnAuthError(res))) {
    res = await mcpAddReaction(conversationId, messageId, emojiKey);
  }
  return res;
}

export async function removeReaction(conversationId, messageId, emojiKey) {
  let res = await mcpRemoveReaction(conversationId, messageId, emojiKey);
  if (!res.ok && (await attemptTokenRefreshOnAuthError(res))) {
    res = await mcpRemoveReaction(conversationId, messageId, emojiKey);
  }
  return res;
}

function isRetryableNetworkError(res) {
  if (!res || res.ok) return false;
  const msg = (res.error?.message || String(res.error || '')).toLowerCase();
  return (
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('eai_again') ||
    msg.includes('enotfound') ||
    msg.includes('timeout') ||
    msg.includes('socket hang up')
  );
}

async function retrySendWithRecovery(sendFn) {
  let result = await sendFn();
  if (result.ok) return result;

  // 1. If auth error, refresh tokens and retry
  if (await attemptTokenRefreshOnAuthError(result)) {
    result = await sendFn();
    if (result.ok) return result;
  }

  // 2. If transient network error / fetch failed, retry with backoff
  const maxRetries = 3;
  let attempt = 0;
  while (!result.ok && isRetryableNetworkError(result) && attempt < maxRetries) {
    attempt++;
    const delayMs = attempt * 1500;
    console.warn(
      new Date().toISOString(),
      `[teams] Transient network error (${result.error?.message || result.error}), retry ${attempt}/${maxRetries} in ${delayMs / 1000}s...`
    );
    await new Promise((r) => setTimeout(r, delayMs));
    result = await sendFn();
  }

  return result;
}

export async function searchPeople(query, limit = 10) {
  let res = await mcpSearchPeople(query, limit);
  if (!res.ok && (await attemptTokenRefreshOnAuthError(res))) {
    res = await mcpSearchPeople(query, limit);
  }
  return res;
}

export async function resolveProfiles(mris) {
  let res = await mcpResolveProfiles(mris);
  if (!res.ok && (await attemptTokenRefreshOnAuthError(res))) {
    res = await mcpResolveProfiles(mris);
  }
  return res;
}

export async function getCalendarView(options = {}) {
  const mcpRes = await mcpGetCalendarView(options);
  if (mcpRes.ok) return mcpRes;

  // Fallback: direct MiddleTier call for EMEA
  const authRes = requireSkypeSpacesAuth();
  if (!authRes.ok) return mcpRes;

  const { skypeToken, spacesToken } = authRes.value;
  const now = new Date();
  const defaultEnd = new Date(now);
  defaultEnd.setDate(defaultEnd.getDate() + 7);
  const startDate = options.startDate || now.toISOString();
  const endDate = options.endDate || defaultEnd.toISOString();
  const limit = options.limit ?? 50;

  const params = new URLSearchParams({
    startDate,
    endDate,
    $top: limit.toString(),
    $count: 'true',
    $skip: '0',
    $orderby: 'startTime asc',
    $filter: 'isAppointment eq false and isAllDayEvent eq false and isCancelled eq false',
  });

  const url = `https://teams.microsoft.com/api/mt/emea/v2.1/me/calendars/calendarView?${params.toString()}`;
  const response = await httpRequest(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authentication: `skypetoken=${skypeToken}`,
      Authorization: `Bearer ${spacesToken}`,
      'x-ms-client-version': '49/25113001312',
    },
  });

  if (!response.ok) return mcpRes;

  const rawMeetings = response.value?.data?.value || [];
  const meetings = rawMeetings.map((raw) => {
    const rawResponse = raw.myResponseType;
    let myResponse = 'None';
    if (rawResponse === 'Accepted' || rawResponse === 'Organizer') myResponse = 'Accepted';
    else if (rawResponse === 'Tentative' || rawResponse === 'TentativelyAccepted') myResponse = 'Tentative';
    else if (rawResponse === 'Declined') myResponse = 'Declined';

    return {
      id: raw.objectId,
      subject: raw.subject || '(No subject)',
      startTime: raw.startTime,
      endTime: raw.endTime,
      organizer: {
        name: raw.organizerName || 'Unknown',
        email: raw.organizerAddress || '',
      },
      location: raw.location,
      isOnlineMeeting: raw.isOnlineMeeting === true,
      joinUrl: raw.skypeTeamsMeetingUrl,
      myResponse,
    };
  });

  return { ok: true, value: { count: meetings.length, meetings } };
}

export async function getUserPresence(mris) {
  const authRes = requireSkypeSpacesAuth();
  if (!authRes.ok) {
    if (await attemptTokenRefreshOnAuthError(authRes)) {
      return getUserPresence(mris);
    }
    return authRes;
  }

  const { skypeToken, spacesToken } = authRes.value;
  const mriList = Array.isArray(mris) ? mris : [mris];
  const payload = mriList.map((m) => (typeof m === 'string' ? { mri: m } : m));

  const url = 'https://presence.teams.microsoft.com/v1/presence/getpresence/';
  const response = await httpRequest(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${spacesToken}`,
      Authentication: `skypetoken=${skypeToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-ms-client-version': '1415/26101515217',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok && (await attemptTokenRefreshOnAuthError(response))) {
    return getUserPresence(mris);
  }

  return response;
}

export const botSentMessageIds = new Set();
export const BOT_WATERMARK = '\u200B\u200C\u200B';

export function recordBotMessageId(id) {
  if (id) {
    const s = String(id);
    botSentMessageIds.add(s);
    if (/^\d{12,14}$/.test(s)) {
      const num = Number(s);
      try {
        botSentMessageIds.add(new Date(num).toISOString());
      } catch {}
    } else {
      const parsed = Date.parse(s);
      if (!isNaN(parsed)) {
        botSentMessageIds.add(String(parsed));
      }
    }
    if (botSentMessageIds.size > 2000) {
      const iter = botSentMessageIds.values();
      botSentMessageIds.delete(iter.next().value);
    }
  }
}

export const STATUS_REACTIONS = {
  pending: '1f440_eyes', // 👀 needs approval
  approved: 'like', // 👍 approved, not merged
  merged: '2705_whiteheavycheckmark', // ✅
  failed: '274c_crossmark', // ❌ CI failed
  closed: '274c_crossmark', // ❌ closed unmerged
};

export const COMMAND_REACTIONS = {
  pending: '1f440_eyes', // 👀
  success: '2705_whiteheavycheckmark', // ✅
  failure: '274c_crossmark', // ❌
  warning: '26a0_warning', // ⚠️
  running: '23f3_hourglass', // ⏳
  ban: '26d4_noentry', // ⛔
};

export const BAN_REACTION = '26d4_noentry'; // ⛔

export const STATUS_BY_REACTION = new Map(
  Object.entries(STATUS_REACTIONS).map(([status, key]) => [key, status])
);

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildMentionsProperty(mentions) {
  const mentionObjects = mentions.map((mention, index) => ({
    '@type': 'http://schema.skype.com/Mention',
    'itemid': mention.itemid !== undefined ? mention.itemid : index,
    'mri': String(mention.mri).split('/contacts/').pop(),
    'mentionType': mention.mentionType || (String(mention.mri).includes('tag:') ? 'tag' : 'person'),
    'displayName': mention.displayName,
  }));
  return JSON.stringify(mentionObjects);
}

export function renderReplyContent(replyMarkdown) {
  const cleanMarkdown = String(replyMarkdown || '').trim();
  const parsed = parseContentWithMentionsAndLinks(cleanMarkdown);
  const mentions = parsed.mentions || [];
  let html = (parsed.html || '').trim();

  for (let i = 0; i < mentions.length; i++) {
    const mention = mentions[i];
    if (typeof mention.mri === 'string' && mention.mri.endsWith('#contact')) {
      mention.mri = mention.mri.replace(/#contact$/, '');
      mention.mentionType = 'share-contact';
      html = html.replace(
        new RegExp(`<span itemtype="http://schema\\.skype\\.com/Mention" itemscope itemid="${i}">`),
        `<span itemtype="http://schema.skype.com/Mention" itemscope="Share_Contact_Card" itemid="${i}">`
      );
    }
  }

  // Remove trailing paragraph margin to avoid extra blank space in cards
  html = html.replace(/(<p)(?![\s\S]*<p)([^>]*>[\s\S]*?<\/p>)$/i, (_m, open, rest) => {
    if (open.includes('style="')) {
      return open.replace(/style="([^"]*)"/, 'style="$1;margin-bottom:0;"') + rest;
    }
    return `${open} style="margin-bottom:0;"${rest}`;
  });

  return {
    html: `${html}<span style="display:none">${BOT_WATERMARK}</span>`,
    mentions,
  };
}

export function cleanPreviewText(text) {
  if (!text) return '';
  return String(text)
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
    .replace(/<div[^>]*itemtype="http:\/\/schema\.skype\.com\/Reply"[\s\S]*?<\/div>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<\/li>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
}

/**
 * Builds a Teams blockquote quoting an existing message.
 * This is how Teams client renders threaded replies in chats and meetings.
 */
export function buildQuotedReplyHtml({ messageId, from, fromMri, previewText, replyMarkdown }) {
  const cleanPreview = cleanPreviewText(previewText);
  const cleanMri = fromMri ? String(fromMri).split('/contacts/').pop() : '';
  const quote =
    `<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="${escapeHtml(messageId)}">` +
    `<strong itemprop="mri" itemid="${escapeHtml(cleanMri)}">${escapeHtml(from || '')}</strong>` +
    `<span itemprop="time" itemid="${escapeHtml(messageId)}"></span>` +
    `<p itemprop="preview">${escapeHtml(cleanPreview)}</p>` +
    '</blockquote>';

  const { html, mentions } = renderReplyContent(replyMarkdown);
  return {
    html: quote + html,
    mentions,
  };
}

/**
 * Sends a direct (non-reply) message to a conversation.
 */
export async function sendDirectMessage(conversationId, markdown) {
  const { html, mentions } = renderReplyContent(markdown);
  const options = {
    contentType: 'html',
    properties: {
      formatVariant: 'TEAMS',
      mentions: mentions.length > 0 ? buildMentionsProperty(mentions) : '[]',
      cards: '[]',
      links: '[]',
      files: '[]',
    },
  };
  const result = await retrySendWithRecovery(() => sendMessage(conversationId, html, options));
  if (!result.ok) {
    console.error(new Date().toISOString(), `[teams] sendDirectMessage failed in ${conversationId}:`, result.error?.message || result.error);
  } else if (result.value) {
    recordBotMessageId(result.value.timestamp);
    recordBotMessageId(result.value.messageId);
  }
  return result;
}

/**
 * Sends a reply to a message in a conversation.
 * Handles both channel threads (@thread.tacv2) and chat/meeting quote-replies.
 */
export async function sendReply(conversationId, originalMessage, replyMarkdown, opts = {}) {
  const updateId = opts.updateMessageId || originalMessage?.replyMessageIdToUpdate;
  if (updateId) {
    if (originalMessage) originalMessage.replyMessageIdToUpdate = null;
    const updateResult = await updateReply(conversationId, updateId, originalMessage, replyMarkdown);
    if (updateResult.ok) {
      return updateResult;
    }
    console.warn(new Date().toISOString(), `[teams] updateReply failed for ${updateId}, falling back to sendMessage:`, updateResult.error?.message || updateResult.error);
  }

  const isChannel = conversationId.endsWith('@thread.tacv2');
  const messageId = originalMessage.messageId || originalMessage.id;
  const from = originalMessage.from || originalMessage.sender?.displayName || '';
  const fromMri = originalMessage.fromMri || originalMessage.sender?.mri || '';
  const previewText = originalMessage.previewText || originalMessage.content || originalMessage.text || '';

  const { html, mentions } = buildQuotedReplyHtml({
    messageId,
    from,
    fromMri,
    previewText,
    replyMarkdown,
  });

  const cleanMri = fromMri ? String(fromMri).split('/contacts/').pop() : '';

  const properties = {
    formatVariant: 'TEAMS',
    mentions: mentions.length > 0 ? buildMentionsProperty(mentions) : '[]',
    cards: '[]',
    links: '[]',
    files: '[]',
  };

  if (messageId) {
    properties.hasValidMsgReferences = true;
    properties.qtdMsgs = JSON.stringify([
      {
        messageId: Number(messageId) || messageId,
        sender: cleanMri,
        time: Number(messageId) || Date.now(),
        message: null,
        validationResult: 'Valid',
        sharedRefId: null,
        replyChainId: null,
      },
    ]);
  }

  const options = {
    contentType: 'html',
    properties,
  };

  if (isChannel && messageId) {
    options.replyToMessageId = messageId;
  }

  const result = await retrySendWithRecovery(() => sendMessage(conversationId, html, options));
  if (!result.ok) {
    console.error(new Date().toISOString(), `[teams] sendReply failed in ${conversationId}:`, result.error?.message || result.error);
  } else if (result.value) {
    recordBotMessageId(result.value.timestamp);
    recordBotMessageId(result.value.messageId);
  }
  return result;
}

/**
 * Updates an existing reply message in-place.
 */
export async function updateReply(conversationId, serverMessageId, originalMessage, replyMarkdown) {
  recordBotMessageId(serverMessageId);
  const messageId = originalMessage.messageId || originalMessage.id;
  const from = originalMessage.from || originalMessage.sender?.displayName || '';
  const fromMri = originalMessage.fromMri || originalMessage.sender?.mri || '';
  const previewText = originalMessage.previewText || originalMessage.content || originalMessage.text || '';

  const { html, mentions } = buildQuotedReplyHtml({
    messageId,
    from,
    fromMri,
    previewText,
    replyMarkdown,
  });

  const cleanMri = fromMri ? String(fromMri).split('/contacts/').pop() : '';

  const properties = {
    mentions: mentions.length > 0 ? buildMentionsProperty(mentions) : '[]',
  };

  if (messageId) {
    properties.hasValidMsgReferences = true;
    properties.qtdMsgs = JSON.stringify([
      {
        messageId: Number(messageId) || messageId,
        sender: cleanMri,
        time: Number(messageId) || Date.now(),
        message: null,
        validationResult: 'Valid',
        sharedRefId: null,
        replyChainId: null,
      },
    ]);
  }

  const options = {
    properties,
  };

  const result = await retrySendWithRecovery(() => editMessage(conversationId, String(serverMessageId), html, 'html', options));
  if (!result.ok) {
    console.error(new Date().toISOString(), `[teams] updateReply failed for ${serverMessageId} in ${conversationId}:`, result.error?.message || result.error);
  }
  return result;
}

/**
 * Uploads an image Buffer or Base64 string to Skype/Teams AMS (Attachment Management Service).
 * Returns { ok: true, objectId, url } or { ok: false, error }
 */
export async function uploadImageToAms(imageBufferOrB64, conversationId) {
  try {
    const authRes = requireMessageAuthWithConfig();
    if (!authRes.ok) {
      return { ok: false, error: authRes.error || new Error('No messaging auth available') };
    }
    const { auth } = authRes.value;
    const { skypeToken, userMri } = auth;
    if (!skypeToken) {
      return { ok: false, error: new Error('No skypeToken available for AMS upload') };
    }

    const imgBuf = Buffer.isBuffer(imageBufferOrB64)
      ? imageBufferOrB64
      : Buffer.from(imageBufferOrB64, 'base64');

    const permissions = {};
    if (conversationId) permissions[conversationId] = ['read'];
    if (userMri) permissions[userMri] = ['read'];

    const createRes = await fetch('https://api.asm.skype.com/v1/objects', {
      method: 'POST',
      headers: {
        Authorization: `skype_token ${skypeToken}`,
        'User-Agent': '1415/1.0.0.2025010401',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'pish/image',
        permissions,
        filename: 'preview.jpg',
      }),
    });

    if (!createRes.ok) {
      const errBody = await createRes.text().catch(() => '');
      return {
        ok: false,
        error: new Error(`AMS object creation failed (${createRes.status}): ${errBody.slice(0, 200)}`),
      };
    }

    const { id: objectId } = await createRes.json();
    if (!objectId) {
      return { ok: false, error: new Error('AMS returned no object ID') };
    }

    const uploadRes = await fetch(`https://api.asm.skype.com/v1/objects/${objectId}/content/imgpsh`, {
      method: 'PUT',
      headers: {
        Authorization: `skype_token ${skypeToken}`,
        'User-Agent': '1415/1.0.0.2025010401',
        'Content-Type': 'image/jpeg',
      },
      body: imgBuf,
    });

    if (!uploadRes.ok) {
      const errBody = await uploadRes.text().catch(() => '');
      return {
        ok: false,
        error: new Error(`AMS content upload failed (${uploadRes.status}): ${errBody.slice(0, 200)}`),
      };
    }

    const url = `https://eu-api.asm.skype.com/v1/objects/${objectId}/views/imgo`;
    return { ok: true, objectId, url };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/**
 * Appends a thumbnail screenshot to a user message by editing it.
 * Keeps original content and adds the thumbnail image link.
 */
export async function appendThumbnailToMessage(
  conversationId,
  serverMessageId,
  originalContent,
  originalRawHtml,
  url,
  thumbnailData
) {
  recordBotMessageId(serverMessageId);

  let baseHtml = (originalRawHtml || '').trim();
  if (!baseHtml) {
    baseHtml = `<p>${escapeHtml((originalContent || '').trim())}</p>`;
  }

  const b64 = typeof thumbnailData === 'string' ? thumbnailData : thumbnailData?.b64;
  if (!b64) {
    return { ok: false, error: new Error('No base64 thumbnail provided') };
  }

  const cleanUrl = escapeHtml((url || '').trim());

  let thumbnailBlock;
  const amsRes = await retrySendWithRecovery(() => uploadImageToAms(b64, conversationId));
  if (amsRes.ok && amsRes.objectId && amsRes.url) {
    thumbnailBlock = `<p style="margin-top:6px;margin-bottom:0;"><a href="${cleanUrl}"><img src="${amsRes.url}" itemscope="" itemtype="http://schema.skype.com/AMSImage" itemid="${amsRes.objectId}" alt="Preview" style="display:block;border-radius:6px;border:1px solid #d1d1d1;max-width:320px;" /></a></p><span style="display:none">${BOT_WATERMARK}</span>`;
  } else {
    console.warn(
      new Date().toISOString(),
      `[teams] AMS upload failed (${amsRes.error?.message || amsRes.error}), falling back to data URI:`,
      amsRes.error
    );
    thumbnailBlock = `<p style="margin-top:6px;margin-bottom:0;"><a href="${cleanUrl}"><img src="data:image/jpeg;base64,${b64}" width="280" alt="Preview" style="display:block;border-radius:6px;border:1px solid #d1d1d1;max-width:320px;" /></a></p><span style="display:none">${BOT_WATERMARK}</span>`;
  }

  const newHtml = `${baseHtml}${thumbnailBlock}`;

  const options = {
    properties: {
      cards: '[]',
      links: '[]',
      files: '[]',
    },
  };

  const result = await retrySendWithRecovery(() =>
    editMessage(conversationId, String(serverMessageId), newHtml, 'html', options)
  );
  if (!result.ok) {
    console.error(
      new Date().toISOString(),
      `[teams] appendThumbnailToMessage failed for ${serverMessageId} in ${conversationId}:`,
      result.error?.message || result.error
    );
  }
  return result;
}

/**
 * Edits the original message sent by self to include the card markdown.
 * Preserves the original URL link and appends the rendered card HTML.
 */
export async function editOriginalMessage(conversationId, messageId, originalUrl, cardMarkdown) {
  recordBotMessageId(messageId);
  const cleanUrl = String(originalUrl || '').trim();
  const cleanMarkdown = String(cardMarkdown || '').trim();
  const { html: cardHtml, mentions } = renderReplyContent(cleanMarkdown);
  const baseHtml = cleanUrl ? `<p><a href="${escapeHtml(cleanUrl)}">${escapeHtml(cleanUrl)}</a></p>` : '';
  const fullHtml = `${baseHtml}<div style="margin-top:6px;">${cardHtml}</div>`;

  const properties = {
    mentions: mentions.length > 0 ? buildMentionsProperty(mentions) : '[]',
    cards: '[]',
    links: '[]',
    files: '[]',
  };

  const result = await retrySendWithRecovery(() =>
    editMessage(conversationId, String(messageId), fullHtml, 'html', { properties })
  );
  if (!result.ok) {
    console.error(
      new Date().toISOString(),
      `[teams] editOriginalMessage failed for ${messageId} in ${conversationId}:`,
      result.error?.message || result.error
    );
  }
  return result;
}

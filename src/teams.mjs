import {
  sendMessage,
  getThreadMessages,
  getMessage,
  editMessage,
  parseContentWithMentionsAndLinks,
} from 'msteams-mcp/dist/api/chatsvc-messaging.js';
import { addReaction, removeReaction } from 'msteams-mcp/dist/api/chatsvc-reactions.js';
import { getCalendarView as mcpGetCalendarView } from 'msteams-mcp/dist/api/calendar-api.js';
import { requireSkypeSpacesAuth } from 'msteams-mcp/dist/utils/auth-guards.js';
import { httpRequest } from 'msteams-mcp/dist/utils/http.js';
import { markdownToTeamsHtml } from 'msteams-mcp/dist/utils/parsers-markdown.js';
import { refreshTokensViaHttp } from 'msteams-mcp/dist/auth/token-refresh-http.js';
import { searchPeople as mcpSearchPeople } from 'msteams-mcp/dist/api/substrate-api.js';
import { resolveProfiles as mcpResolveProfiles } from 'msteams-mcp/dist/api/profile-api.js';

export {
  sendMessage,
  getThreadMessages,
  getMessage,
  editMessage,
  addReaction,
  removeReaction,
  markdownToTeamsHtml,
  parseContentWithMentionsAndLinks,
};

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
  const parsed = parseContentWithMentionsAndLinks(replyMarkdown);
  const mentions = parsed.mentions || [];
  let html = parsed.html;

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

  return {
    html: html + `<span style="display:none">${BOT_WATERMARK}</span>${BOT_WATERMARK}`,
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

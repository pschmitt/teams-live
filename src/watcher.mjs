import './test-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  STATUS_REACTIONS,
  STATUS_BY_REACTION,
  COMMAND_REACTIONS,
  BAN_REACTION,
  BOT_WATERMARK,
  botSentMessageIds,
  recordBotMessageId,
  addReaction,
  removeReaction,
  sendReply,
  sendDirectMessage,
  updateReply,
  editOriginalMessage,
  appendThumbnailToMessage,
  getThreadMessages,
  getMessage,
  getCalendarView,
  getUserPresence,
  searchPeople,
  resolveProfiles,
  escapeHtml,
  makeRichMessage,
  makeRichMessageSequence,
  isRichMessage,
  richMessageWireBytes,
  setRichMessages,
  transport,
} from './teams.mjs';
import {
  buildMessageSearchText,
  collectCandidateUrlStrings,
  isOnlyUrlMessage,
  stripTruncatedUrlText,
  teamsMessageLink,
} from './message-links.mjs';
import { buildApprovalNote, teamsUserLink } from './approval-note.mjs';
import {
  buildMergeRequestCard,
  buildJobCard,
  buildPipelineCard,
  buildJiraIssueCard,
  buildOnCallCard,
  buildOpsGenieAlertCard,
  buildConfluencePageCard,
  buildCodePreviewCard,
  formatCodePreviewMarkdown,
  buildMarkdownCard,
  mrListState,
  MAX_CARD_BYTES,
  opsGeniePriorityBadge,
  ciStatusEmoji as getCiStatusEmoji,
} from './cards.mjs';
import { buildHelpCard, helpEntries, splitHelpCategories } from './card-help.mjs';
import { buildMultiMrCard } from './card-multi-mr.mjs';
import { DICE_USAGE, buildDiceCard, formatDiceMarkdown, parseDiceArgs, pickOption, rollDice } from './card-dice.mjs';
import { LEADERBOARD_MAX_ENTRIES, PODIUM_SIZE, buildLeaderboardCard, rankLeaderboard } from './card-leaderboard.mjs';
import { buildLifecycleCard, chatList, gitlabHooksUrl, jiraProjectList, lifecycleMarkdown, linkedText } from './lifecycle-card.mjs';
import {
  UserDirectory,
  normalizeName,
  extractUserOid,
  formatContactCard,
  formatSearchResultsList,
  formatWhereisCard,
} from './users.mjs';
import { SnakeGame } from './snake.mjs';
import {
  TV_CONTROL_ACTIONS,
  TV_USAGE,
  TvProgrammeService,
  TvSwitch,
  normalizeTvConfig,
  parseTvArgs,
} from './tv.mjs';
import { TV_CHANNEL_LABELS, buildTvProgrammeCard, formatProgrammeText, tvControlReply } from './tv-cards.mjs';
import { AvatarService, loadAvatarOverrides } from './avatars.mjs';
import { BUILTIN_AVATAR_OVERRIDES } from './bot-avatars.mjs';
import { createAvatarFallbacks } from './avatar-sources.mjs';
import { PLACEHOLDER_AVATAR } from './placeholder-avatar.mjs';
import { collectCardPeople, fallbackAvatar, isImageDataUri } from './card-user-row.mjs';
import { formatOnDuty, humanizeRecipient } from './opsgenie.mjs';
import { getMessageAuthStatus } from 'msteams-mcp/dist/auth/token-extractor.js';
import { fallbackTokenPendingPath, persistFallbackToken, persistGitLabToken } from './config.mjs';
import { formatTokenExpiry } from './gitlab.mjs';
import { ServiceAlertTracker, formatServiceAlert, serviceAlertOptionsFromConfig } from './service-alerts.mjs';
import { createLogger } from './logger.mjs';

const log = createLogger('watcher');

// How many "the bot approved for X" records are kept (the newest).
const TEAMS_APPROVALS_KEEP = 500;

// Longest wait before a watched Jira issue we cannot read (403/404) is checked again.
const JIRA_ISSUE_DENIED_MAX_DELAY_MS = 6 * 60 * 60 * 1000;
const HEADSUP_PREFIX = 'headsup: ';
const CI_PREFIX = 'CI pipeline';
const CI_JOB_PREFIX = 'CI job ';
// Teams rejects more than 3 edits per 5 seconds, so stay just below that rate.
const SNAKE_FRAMES = 40;
const SNAKE_FRAME_DELAY_MS = 1800;
const REBASE_PREFIX = '**Rebase';
// Author pictures on the /mrs list card: all lookups share one deadline (a list has many
// rows, so not 1.5 s each), and every picture costs its data URI plus the column markup.
// They use the smaller 24px server-side resize (shown at 18px): a list has little wire room.
const MRS_LIST_AVATAR_SIZE = 'HR24x24';
// The leaderboard podium (top three) shows larger pictures than the rows below it.
const leaderboardAvatarSize = (index) => (index < PODIUM_SIZE ? 'HR32x32' : 'HR24x24');
const MRS_LIST_AVATAR_DEADLINE_MS = 2800;
// A /mrs list needs at most this many cards (the same bound as a generic reply split into cards).
const MRS_LIST_MAX_CARDS = 10;

const GITLAB_EMOJI_TRANSLATIONS = {
  // Common Teams reaction names / slugs
  laugh: 'laughing',
  heart: 'hearts',
  hearts: 'hearts',
  red_heart: 'hearts',
  surprised: 'open_mouth',
  sad: 'cry',
  angry: 'angry',
  dislike: 'thumbsdown',
  thumbsdown: 'thumbsdown',
  thumbs_down: 'thumbsdown',
  '1f44e_thumbsdown': 'thumbsdown',

  // Crying & emotion
  loudlycrying: 'sob',
  loudly_crying: 'sob',
  loudly_crying_face: 'sob',
  sob: 'sob',
  cry: 'cry',
  crying: 'cry',
  crying_face: 'cry',
  joy: 'joy',
  tears_of_joy: 'joy',
  face_with_tears_of_joy: 'joy',
  rofl: 'rofl',
  rolling_on_the_floor_laughing: 'rofl',
  sweat_smile: 'sweat_smile',
  grinning_face_with_sweat: 'sweat_smile',
  smile: 'smile',
  smiling_face: 'smile',
  smiley: 'smiley',
  grinning: 'grinning',
  grinning_face: 'grinning',
  grin: 'grin',
  beaming_face_with_smiling_eyes: 'grin',
  wink: 'wink',
  winking_face: 'wink',
  blush: 'blush',
  smiling_face_with_smiling_eyes: 'blush',
  heart_eyes: 'heart_eyes',
  smiling_face_with_heart_eyes: 'heart_eyes',
  kissing_heart: 'kissing_heart',
  face_blowing_a_kiss: 'kissing_heart',
  sunglasses: 'sunglasses',
  smiling_face_with_sunglasses: 'sunglasses',
  smirk: 'smirk',
  smirking_face: 'smirk',
  unamused: 'unamused',
  unamused_face: 'unamused',
  grimacing: 'grimacing',
  grimacing_face: 'grimacing',
  pleading: 'pleading_face',
  pleading_face: 'pleading_face',
  face_with_raised_eyebrow: 'face_with_raised_eyebrow',
  raised_eyebrow: 'face_with_raised_eyebrow',
  thinking: 'thinking',
  thinking_face: 'thinking',
  exploding_head: 'exploding_head',
  shocked_face_with_exploding_head: 'exploding_head',
  scream: 'scream',
  screaming: 'scream',
  face_screaming_in_fear: 'scream',
  rage: 'rage',
  pouting_face: 'rage',
  saluting_face: 'saluting_face',
  salute: 'saluting_face',
  melting_face: 'melting_face',
  melting: 'melting_face',
  partying_face: 'partying_face',
  partying: 'partying_face',
  hot_face: 'hot_face',
  hot: 'hot_face',
  cold_face: 'cold_face',
  cold: 'cold_face',
  face_with_rolling_eyes: 'face_with_rolling_eyes',
  rolling_eyes: 'rolling_eyes',
  face_with_monocle: 'face_with_monocle',
  monocle: 'face_with_monocle',
  zipper_mouth_face: 'zipper_mouth_face',
  zipper_mouth: 'zipper_mouth_face',
  clown_face: 'clown_face',
  clown: 'clown_face',
  skull: 'skull',
  poop: 'poop',
  pile_of_poo: 'poop',
  shit: 'poop',
  robot: 'robot',
  robot_face: 'robot',
  ghost: 'ghost',
  alien: 'alien',

  // Gestures & symbols
  eyes: 'eyes',
  tada: 'tada',
  party_popper: 'tada',
  party: 'tada',
  celebrate: 'tada',
  rocket: 'rocket',
  fire: 'fire',
  flame: 'fire',
  '100': '100',
  hundred_points: '100',
  clap: 'clap',
  clapping_hands: 'clap',
  applause: 'clap',
  raised_hands: 'raised_hands',
  raising_hands: 'raised_hands',
  praise: 'raised_hands',
  pray: 'pray',
  folded_hands: 'pray',
  handshake: 'handshake',
  muscle: 'muscle',
  flexed_biceps: 'muscle',
  biceps: 'muscle',
  wave: 'wave',
  waving_hand: 'wave',
  sparkles: 'sparkles',
  sparkling_heart: 'sparkling_heart',
  broken_heart: 'broken_heart',
  white_check_mark: 'white_check_mark',
  heavy_check_mark: 'heavy_check_mark',
  check: 'white_check_mark',
  checkmark: 'white_check_mark',
  x: 'x',
  cross_mark: 'x',
  warning: 'warning',
  bulb: 'bulb',
  light_bulb: 'bulb',
  coffee: 'coffee',
  hot_beverage: 'coffee',
  beer: 'beer',
  beer_mug: 'beer',
  beers: 'beers',
  clinking_beer_mugs: 'beers',
  cheers: 'beers',
};

const UNICODE_EMOJI_TO_GITLAB = {
  '❤️': 'hearts',
  '♥️': 'hearts',
  '💖': 'sparkling_heart',
  '💔': 'broken_heart',
  '😆': 'laughing',
  '😂': 'joy',
  '🤣': 'rofl',
  '😀': 'grinning',
  '😃': 'smiley',
  '😄': 'smile',
  '😁': 'grin',
  '😅': 'sweat_smile',
  '😉': 'wink',
  '😊': 'blush',
  '😍': 'heart_eyes',
  '😘': 'kissing_heart',
  '😎': 'sunglasses',
  '😏': 'smirk',
  '😒': 'unamused',
  '😮': 'open_mouth',
  '😲': 'astonished',
  '😢': 'cry',
  '😭': 'sob',
  '😡': 'angry',
  '🤬': 'rage',
  '🤯': 'exploding_head',
  '😱': 'scream',
  '😬': 'grimacing',
  '🥺': 'pleading_face',
  '🫡': 'saluting_face',
  '🫠': 'melting_face',
  '🥳': 'partying_face',
  '🥵': 'hot_face',
  '🥶': 'cold_face',
  '🙄': 'rolling_eyes',
  '🤨': 'face_with_raised_eyebrow',
  '🧐': 'face_with_monocle',
  '🤐': 'zipper_mouth_face',
  '🤡': 'clown_face',
  '💀': 'skull',
  '💩': 'poop',
  '👻': 'ghost',
  '🤖': 'robot',
  '🎉': 'tada',
  '🚀': 'rocket',
  '🔥': 'fire',
  '🤔': 'thinking',
  '👀': 'eyes',
  '👏': 'clap',
  '🙌': 'raised_hands',
  '🙏': 'pray',
  '🤝': 'handshake',
  '💪': 'muscle',
  '👋': 'wave',
  '💯': '100',
  '✨': 'sparkles',
  '👎': 'thumbsdown',
  '✅': 'white_check_mark',
  '❌': 'x',
  '⚠️': 'warning',
  '💡': 'bulb',
  '☕': 'coffee',
  '🍺': 'beer',
  '🍻': 'beers',
};

export function teamsReactionToGitLabEmoji(reactionKey) {
  if (!reactionKey) return null;
  const raw = String(reactionKey).trim();
  const lower = raw.toLowerCase();

  // Thumbs up is reserved for approving, not mirrored
  if (
    lower === 'like' ||
    lower === '👍' ||
    lower === '1f44d_thumbsup' ||
    lower.includes('thumbup') ||
    lower.includes('thumbs_up') ||
    lower.includes('thumbsup')
  ) {
    return null;
  }

  // 1. Direct Unicode match
  if (UNICODE_EMOJI_TO_GITLAB[raw]) {
    return UNICODE_EMOJI_TO_GITLAB[raw];
  }

  // 2. Check translation table directly
  if (GITLAB_EMOJI_TRANSLATIONS[lower]) {
    return GITLAB_EMOJI_TRANSLATIONS[lower];
  }

  // 3. Hex-prefixed keys like 1f62d_loudly_crying_face or 1f389_party_popper
  const hexMatch = lower.match(/^[0-9a-f]+_(.+)$/);
  if (hexMatch) {
    const slug = hexMatch[1].replace(/-/g, '_');
    if (GITLAB_EMOJI_TRANSLATIONS[slug]) {
      return GITLAB_EMOJI_TRANSLATIONS[slug];
    }
  }

  // 4. Normalized slug check (remove non-alphanumeric except underscores)
  const normalized = lower.replace(/[^a-z0-9_]/g, '');
  if (GITLAB_EMOJI_TRANSLATIONS[normalized]) {
    return GITLAB_EMOJI_TRANSLATIONS[normalized];
  }

  return null;
}

export function extractCandidateUrls(text, rawHtml = '', links = []) {
  const urls = collectCandidateUrlStrings(text, rawHtml, links);

  const valid = [];
  for (const rawUrl of urls) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;

      const host = parsed.hostname.toLowerCase();
      if (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host === '0.0.0.0' ||
        host.endsWith('.local') ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
      ) {
        continue;
      }

      if (host === 'teams.microsoft.com' || host === 'teams.cloud.microsoft') {
        continue;
      }

      const pathname = parsed.pathname.toLowerCase();
      if (/\.(mp4|webm|avi|mov|mp3|wav|ogg|flac|pdf|zip|tar|gz|tgz|bz2|xz|7z|rar|iso|dmg|exe|bin|apk|deb|rpm)$/i.test(pathname)) {
        continue;
      }

      valid.push(parsed.toString());
    } catch {}
  }

  return [...new Set(valid)];
}

export function isSameUrl(url1, url2) {
  if (!url1 || !url2) return false;
  if (url1 === url2) return true;
  try {
    const u1 = new URL(url1);
    const u2 = new URL(url2);
    const path1 = u1.pathname.replace(/\/$/, '');
    const path2 = u2.pathname.replace(/\/$/, '');
    return u1.origin.toLowerCase() === u2.origin.toLowerCase() && path1 === path2 && u1.search === u2.search;
  } catch {
    return String(url1).replace(/\/$/, '') === String(url2).replace(/\/$/, '');
  }
}

export function isMessageOnlyUrl(text, rawHtml = '', links = []) {
  if (!text && !rawHtml) return false;

  const urls = extractCandidateUrls(text, rawHtml, links);
  if (urls.length !== 1) return false;

  return isOnlyUrlMessage(urls[0], { text, rawHtml, links });
}

export const COMMAND_CATEGORIES = [
  {
    id: 'gitlab',
    title: '🦊 **GitLab**',
    aliases: ['gitlab', 'mr', 'mrs', 'ci', 'pipeline'],
    commands: [
      '- `/approve [link|all]`: Approves target MR (or `/approve all` for all eligible human MRs with green/no pipeline).',
      '- `/unapprove [link]` (or `/revoke`, `/disapprove`): Withdraws the bot\'s approval of the target MR (approvals of other people stay).',
      '- `/ci` (or `/pipeline`) [link]: Detailed CI pipeline status, stages, and failed jobs.',
      '- `/close [link]`: Closes the target MR.',
      '- `/merge [link]` (or `/accept`): Merges the target MR (or sets auto-merge if CI is currently running).',
      '- `/mrs [all|bots|me|mine|<user>]`: Lists open merge requests (default hides extra bot MRs; filter by user or view all/bots).',
      '- `/rebase [link]`: Triggers a GitLab rebase for the target MR (if conflict-free).',
      '- `/reopen [link]`: Reopens a closed target MR.',
      '- `/retry [link]`: Retries failed jobs on the latest GitLab pipeline for the target MR.',
      '- `/status [link]`: Checks CI, approvals, and rebase state for the target MR.',
    ],
    footer: '_Target an MR by replying to its message or sending the command immediately after._',
  },
  {
    id: 'jira',
    title: '🎫 **Jira & Planning**',
    aliases: ['jira', 'planning', 'tickets', 'ticket', 'issue', 'issues', 'sprint', 'confluence', 'wiki', 'doc', 'docs'],
    commands: [
      '- `/issue` (or `/ticket`) [KEY]: Fetches details and status for a Jira issue.',
      '- `/doc` (or `/wiki`, `/confluence`) [link|id]: Displays Confluence document details.',
      '- `/sprint` (or `/jira`): Summary of active sprint tasks (To Do, In Progress, In Review).',
      '- `/standup` (or `/today`): Summarizes your assigned Jira tasks and open GitLab MRs.',
    ],
  },
  {
    id: 'ops',
    title: '🚨 **Operations & On-Call**',
    aliases: ['ops', 'operations', 'opsgenie', 'alerts', 'oncall', 'whoisoncall'],
    commands: [
      '- `/alerts` (or `/opsgenie`) [oncall|support]: Open alerts in the CKS OpsGenie queues.',
      '- `/oncall` (or `/whoisoncall`): Lists currently active on-call engineers (Platform & Support).',
    ],
  },
  {
    id: 'tools',
    title: '📅 **Productivity & Tools**',
    aliases: ['tools', 'tool', 'productivity', 'util', 'utils', 'utilities', 'whois', 'whereis', 'where', 'directory'],
    commands: [
      '- `/meetings` (or `/cal`, `/calendar`): Summary of meetings for the rest of the current week.',
      '- `/poll "Question" "Opt1" "Opt2"`: Creates an interactive reaction poll.',
      '- `/tv program` (or `/tv programme`): Shows what is on now and next on ARD and ZDF.',
      '- `/tv ard`, `/tv zdf`, `/tv tagesschau`, `/tv off`: Switches the stream input, or to the "brb" scene (owner only).',
      '- `/tv next`, `/tv prev`: Cycles ARD, ZDF, Tagesschau (owner only; from off: next is ARD, prev is Tagesschau).',
      '- `/tv mute`, `/tv unmute`, `/tv vol up`, `/tv vol down`: Mutes or unmutes the TV, or steps its volume; `vol up` also unmutes (owner only).',
      '- `/weather [location]`: Shows current weather for location (default: Berlin).',
      '- `/whereis [search]` (or `/where`): Checks if a person is available, in a meeting (with join link), or away.',
      '- `/whois <search>` (or `/who`): Looks up a person in the Teams directory and shows contact details.',
    ],
  },
  {
    id: 'fun',
    title: '🎲 **Fun & Games**',
    aliases: ['fun', 'games', 'game', 'leaderboard'],
    commands: [
      '- `/flip`: Flips a coin (Heads or Tails).',
      '- `/leaderboard`: Shows top users by bot interactions and command usage.',
      '- `/random`: Outputs a random fact.',
      '- `/dice` (or `/roll`) [expr]: Rolls dice or picks one option (e.g. `/dice 2d6+3`, `/dice d20 adv`, `/dice pizza | sushi`).',
      '- `/snake`: Plays a round of snake by editing one message.',
    ],
  },
  {
    id: 'admin',
    title: '⚙️ **General & Admin**',
    aliases: ['admin', 'general', 'system', 'sudo'],
    commands: [
      '- `/about`: Bot info, GitHub repository link, and developer support.',
      '- `/exec <cmd>`: Executes a command [admin only].',
      '- `/help` (or `/usage`) [category]: Lists supported slash commands (or filter by category).',
      '- `/marco`: Diagnostic round-trip latency and echo probe.',
      '- `/sudo [cmd]` (or `/admin`): Administrative controls (restart, reauth, status, kick, ban, unban, bans) [admin only].',
    ],
  },
];

/** The note lines under the full help (also the footer of one domain). */
const HELP_NOTES = [
  '_Target an MR by replying to its message or sending the command immediately after._',
  '_Tip: Use `/help <category>` (e.g. `/help gitlab`, `/help jira`, `/help fun`) to filter._',
];

/** The domain a /help argument asks for: a category, null for "everything", or undefined when unknown. */
function findHelpCategory(category) {
  const q = String(category ?? '').toLowerCase().trim();
  if (!q || q === 'all') return null;
  return COMMAND_CATEGORIES.find((c) => c.id === q || c.aliases.includes(q));
}

/** The domains with their available commands only (a command that `requires` a missing feature is left out). */
function availableHelpCategories(categories, has) {
  return categories.map((c) => ({ ...c, commands: helpEntries(c, has) })).filter((c) => c.commands.length > 0);
}

/** The plain markdown of these domains (all of them, or the cards of a split help), with the notes when asked. */
function helpMarkdown(categories, { notes = false } = {}) {
  const sections = ['🤖 **teams-live slash commands**:'];
  for (const cat of categories) sections.push(`${cat.title}:\n${cat.commands.join('\n')}`);
  if (notes) sections.push(HELP_NOTES.join('\n\n'));
  return sections.join('\n\n');
}

export function buildHelpText(category = null, has = () => true) {
  const match = findHelpCategory(category);
  if (match === undefined) {
    const available = COMMAND_CATEGORIES.map((c) => `\`${c.id}\``).join(', ');
    return `❓ Unknown category \`${category}\`. Available categories: ${available}, or use \`/help\` for all.`;
  }
  if (match) {
    const [shown] = availableHelpCategories([match], has);
    const lines = [`🤖 **teams-live slash commands** — ${match.title}:\n`];
    lines.push(...(shown ? shown.commands : []));
    if (match.footer) {
      lines.push(`\n${match.footer}`);
    }
    return lines.join('\n');
  }

  return helpMarkdown(availableHelpCategories(COMMAND_CATEGORIES, has), { notes: true });
}

const HELP_TEXT = buildHelpText();

const ABOUT_TEXT =
  '🧢 **teams-live** — Microsoft Teams integration daemon for GitLab, Jira, and OpsGenie.\n\n' +
  '- 📂 **Source Code**: [github.com/pschmitt/teams-live](https://github.com/pschmitt/teams-live)\n' +
  '- 💖 **Support Development**: [github.com/sponsors/pschmitt](https://github.com/sponsors/pschmitt)\n\n' +
  '_Maintained by @Philipp Schmitt._';

const KNOWN_COMMANDS = [
  '/about',
  '/accept',
  '/admin',
  '/alerts',
  '/approve',
  '/ban',
  '/bans',
  '/cal',
  '/calendar',
  '/ci',
  '/close',
  '/confluence',
  '/dice',
  '/disapprove',
  '/doc',
  '/exec',
  '/flip',
  '/help',
  '/issue',
  '/jira',
  '/kick',
  '/leaderboard',
  '/marco',
  '/meetings',
  '/merge',
  '/mrs',
  '/oncall',
  '/opsgenie',
  '/pipeline',
  '/poll',
  '/random',
  '/reauth',
  '/rebase',
  '/renew',
  '/reopen',
  '/restart',
  '/retry',
  '/revoke',
  '/roll',
  '/snake',
  '/sprint',
  '/standup',
  '/status',
  '/sudo',
  '/ticket',
  '/today',
  '/tv',
  '/unapprove',
  '/unban',
  '/usage',
  '/weather',
  '/where',
  '/whereis',
  '/who',
  '/whois',
  '/whoisoncall',
  '/wiki',
];

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function toMockingCase(str) {
  return str
    .split('')
    .map((c, i) => (i % 2 === 0 ? c.toLowerCase() : c.toUpperCase()))
    .join('');
}

function getMrStatusEmoji(mr) {
  if (typeof mr === 'string') {
    switch (mr) {
      case 'mergeable':
        return '✅';
      case 'not_approved':
        return '👀';
      case 'need_rebase':
        return '⚠️';
      case 'ci_still_running':
        return '⏳';
      case 'ci_must_pass':
        return '❌';
      case 'conflict':
        return '💥';
      case 'checking':
        return '🔄';
      case 'draft_status':
        return '📝';
      default:
        return '🔹';
    }
  }

  if (mr.draft || mr.work_in_progress) return '📝';
  if (mr.has_conflicts || mr.detailed_merge_status === 'conflict') return '💥';

  const pipelineStatus = mr.head_pipeline?.status || mr.pipeline_status || mr.pipeline?.status;
  if (pipelineStatus === 'failed' || mr.detailed_merge_status === 'ci_must_pass') return '❌';
  if (
    pipelineStatus === 'running' ||
    pipelineStatus === 'pending' ||
    pipelineStatus === 'waiting_for_resource' ||
    pipelineStatus === 'preparing' ||
    mr.detailed_merge_status === 'ci_still_running'
  ) {
    return '⏳';
  }

  if (mr.detailed_merge_status === 'mergeable') return '✅';
  if (mr.detailed_merge_status === 'need_rebase') return '⚠️';
  if (mr.detailed_merge_status === 'not_approved') return '👀';
  if (mr.detailed_merge_status === 'checking') return '🔄';

  switch (mr.detailed_merge_status) {
    case 'mergeable':
      return '✅';
    case 'not_approved':
      return '👀';
    case 'need_rebase':
      return '⚠️';
    case 'ci_still_running':
      return '⏳';
    case 'ci_must_pass':
      return '❌';
    case 'conflict':
      return '💥';
    case 'checking':
      return '🔄';
    case 'draft_status':
      return '📝';
    default:
      if (pipelineStatus === 'success') {
        return mr.merge_status === 'can_be_merged' ? '✅' : '👀';
      }
      return '🔹';
  }
}

function isBotMr(mr) {
  const username = (mr.author?.username || '').toLowerCase();
  const name = (mr.author?.name || '').toLowerCase();
  const title = (mr.title || '').toLowerCase();
  return (
    Boolean(mr.author?.bot) ||
    username.includes('renovate') ||
    username.includes('bot') ||
    username.startsWith('sa_') ||
    username.includes('service') ||
    name.includes('renovate') ||
    name.includes('bot') ||
    name.includes('service') ||
    title.startsWith('chore(deps') ||
    title.startsWith('update dependency') ||
    title.startsWith('update module') ||
    title.startsWith('pin dependency') ||
    title.startsWith('lock file maintenance')
  );
}

function deduplicateMrs(mrs) {
  const seen = new Set();
  const unique = [];
  for (const mr of mrs) {
    const key = `${mr.project}!${mr.iid}`.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(mr);
    }
  }
  return unique;
}

function isReadyToMerge(mr) {
  if (mr.draft || mr.work_in_progress) return false;
  if (mr.has_conflicts || mr.detailed_merge_status === 'conflict') return false;
  if (
    mr.detailed_merge_status === 'need_rebase' ||
    (typeof mr.diverged_commits_count === 'number' && mr.diverged_commits_count > 0) ||
    mr.should_be_rebased === true
  ) {
    return false;
  }
  const pipeStatus = mr.head_pipeline?.status || mr.pipeline_status || mr.pipeline?.status;
  if (pipeStatus === 'failed' || pipeStatus === 'running' || pipeStatus === 'pending') return false;
  if (mr.detailed_merge_status === 'mergeable') return true;
  if (
    mr.merge_status === 'can_be_merged' &&
    mr.detailed_merge_status !== 'not_approved' &&
    mr.detailed_merge_status !== 'ci_must_pass' &&
    mr.detailed_merge_status !== 'ci_still_running' &&
    mr.detailed_merge_status !== 'need_rebase' &&
    mr.detailed_merge_status !== 'conflict'
  ) {
    return true;
  }
  return false;
}

function sortMrs(list) {
  return [...list].sort((a, b) => {
    const aReady = isReadyToMerge(a) ? 1 : 0;
    const bReady = isReadyToMerge(b) ? 1 : 0;
    if (aReady !== bReady) return bReady - aReady;
    const aTime = new Date(a.updated_at || 0).getTime();
    const bTime = new Date(b.updated_at || 0).getTime();
    return bTime - aTime;
  });
}

export function parseMrsArgs(args = [], event = null, userDirectory = null) {
  const first = (args[0] || '').toLowerCase().replace(/^-+/, '');
  if (first === 'all' || first === 'a') {
    return { mode: 'all', userFilter: null, userFilterLabel: null };
  }
  if (
    first === 'renovate' ||
    first === 'renovates' ||
    first === 'bots' ||
    first === 'bot' ||
    first === 'r' ||
    first === 'b'
  ) {
    return { mode: 'bots', userFilter: null, userFilterLabel: null };
  }
  if (first === 'me' || first === 'mine') {
    const sender =
      (userDirectory && (userDirectory.findUser(event?.fromMri) || userDirectory.findUser(event?.from))) ||
      (event ? { displayName: event.from || 'Me', mri: event.fromMri || '', gitlabUsernames: [] } : null);
    const label = sender && userDirectory ? userDirectory.formatMention(sender) : (event?.from || 'You');
    return {
      mode: 'user',
      userFilter: sender,
      userFilterLabel: label,
    };
  }
  if (args.length > 0) {
    const query = args.join(' ').replace(/^@+/, '').trim();
    if (query) {
      const resolved = userDirectory ? userDirectory.findUser(query) : null;
      const label = resolved && userDirectory ? userDirectory.formatMention(resolved) : `@${query}`;
      return {
        mode: 'user',
        userFilter: resolved || query,
        userFilterLabel: label,
      };
    }
  }
  return { mode: 'default', userFilter: null, userFilterLabel: null };
}

function getMrsMode(args = []) {
  return parseMrsArgs(args).mode;
}

const ALERT_PRIORITY_ORDER = { P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 };

function sortAlerts(alerts) {
  return [...alerts].sort((a, b) => {
    const aPrio = ALERT_PRIORITY_ORDER[a.priority] || 99;
    const bPrio = ALERT_PRIORITY_ORDER[b.priority] || 99;
    if (aPrio !== bPrio) return aPrio - bPrio;

    const aTime = new Date(a.createdAt || a.lastOccurredAt || 0).getTime();
    const bTime = new Date(b.createdAt || b.lastOccurredAt || 0).getTime();
    return bTime - aTime;
  });
}

function getAlertPriorityBadge(priority, { rich = false } = {}) {
  if (rich) {
    // OpsGenie colours: P1 red, P2 orange, P3 amber, P4 green, P5 subdued.
    const badge = opsGeniePriorityBadge(priority || 'P?');
    return badge.text.replace(/^(\S+) (.*)$/, '$1 **$2**');
  }
  switch (priority) {
    case 'P1':
      return '🚨 **P1**';
    case 'P2':
      return '🟠 **P2**';
    case 'P3':
      return '🟡 **P3**';
    case 'P4':
      return '🔵 **P4**';
    case 'P5':
      return '⚪ **P5**';
    default:
      return `🔹 **${priority || 'P?'}**`;
  }
}

function formatTimeAgo(dateStr) {
  if (!dateStr) return '';
  const diffMs = Date.now() - new Date(dateStr).getTime();
  if (diffMs < 0) return 'just now';
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0s';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function isTerminalCiStatus(status) {
  return ['success', 'passed', 'failed', 'canceled', 'skipped'].includes(status);
}

function parsePollArgs(args) {
  const fullText = args.join(' ').trim();
  if (!fullText) return null;

  // 1. Quoted options: e.g. "Question" "Option 1" "Option 2"
  const quoted = [...fullText.matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] || m[2]);
  if (quoted.length >= 2) {
    return {
      question: quoted[0],
      options: quoted.slice(1),
    };
  }

  // 2. Pipe-separated: Question | Opt1 | Opt2
  if (fullText.includes('|')) {
    const parts = fullText.split('|').map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return {
        question: parts[0],
        options: parts.slice(1),
      };
    }
  }

  // 3. Question with quoted question and trailing options
  if (quoted.length === 1) {
    const question = quoted[0];
    const rest = fullText.replace(/"[^"]+"|'[^']+'/g, '').trim();
    const options = rest.split(/[,/]/).map((s) => s.trim()).filter(Boolean);
    if (options.length >= 2) {
      return { question, options };
    }
    return { question, options: ['Yes', 'No'] };
  }

  // 4. Standalone question: default to Yes / No
  return {
    question: fullText,
    options: ['Yes', 'No'],
  };
}

function formatAlertLine(alert, { rich = false } = {}) {
  const pBadge = getAlertPriorityBadge(alert.priority, { rich });
  const linkRef = alert.tinyId ? `#${alert.tinyId}` : (alert.id ? alert.id.slice(0, 8) : 'alert');
  const link = `[${linkRef}](${alert.url})`;
  const ackBadge = alert.acknowledged ? ' `✔️ ACK\'ED`' : '';
  const snoozeBadge = alert.snoozed ? ' _(💤 snoozed)_' : '';
  const countStr = alert.count > 1 ? ` (🔄 ${alert.count}x)` : '';
  const timeStr = alert.createdAt ? ` — _${formatTimeAgo(alert.createdAt)}_` : '';
  return `- ${pBadge} ${link}: ${alert.message}${ackBadge}${snoozeBadge}${countStr}${timeStr}`;
}

function formatAlertsText(data, mode = 'all', { rich = false } = {}) {
  if (!data) return '❌ Failed to fetch OpsGenie alerts.';

  const {
    onCallAlerts = [],
    supportAlerts = [],
    onCallDuty = [],
    supportDuty = [],
    onCallError,
    supportError,
  } = data;
  const sortedOnCall = sortAlerts(onCallAlerts);
  const sortedSupport = sortAlerts(supportAlerts);
  const totalCount = sortedOnCall.length + sortedSupport.length;

  const onCallPerson = formatOnDuty(onCallDuty);
  const supportPerson = formatOnDuty(supportDuty);

  const showOnCall = mode === 'all' || mode === 'oncall';
  const showSupport = mode === 'all' || mode === 'support';

  if (totalCount === 0 && !onCallError && !supportError) {
    if (mode === 'oncall') {
      return `🎉 **CKS OpsGenie On-Call queue is clear!** (0 open alerts)\n\n👤 **On-Duty**: **${onCallPerson}**`;
    }
    if (mode === 'support') {
      return `🎉 **CKS OpsGenie Support queue is clear!** (0 open alerts)\n\n👤 **On-Duty**: **${supportPerson}**`;
    }
    return `🎉 **All CKS OpsGenie queues are clear!** (0 open alerts)\n\n👤 **On-Duty**: 📞 On-Call: **${onCallPerson}** · 💼 Support: **${supportPerson}**`;
  }

  const sections = [];

  if (showOnCall) {
    const dutyTag = ` (👤 **${onCallPerson}**)`;
    if (onCallError) {
      sections.push(`📞 **On-Call Queue**${dutyTag}:\n\n⚠️ *Failed to fetch on-call alerts: ${onCallError}*`);
    } else if (sortedOnCall.length === 0) {
      sections.push(`📞 **On-Call Queue**${dutyTag}: 🎉 _No open alerts_`);
    } else {
      const lines = sortedOnCall.map((a) => formatAlertLine(a, { rich })).join('\n');
      sections.push(`📞 **On-Call Queue**${dutyTag} (${sortedOnCall.length} open):\n\n${lines}`);
    }
  }

  if (showSupport) {
    const dutyTag = ` (👤 **${supportPerson}**)`;
    if (supportError) {
      sections.push(`💼 **Support Queue**${dutyTag}:\n\n⚠️ *Failed to fetch support alerts: ${supportError}*`);
    } else if (sortedSupport.length === 0) {
      sections.push(`💼 **Support Queue**${dutyTag}: 🎉 _No open alerts_`);
    } else {
      const lines = sortedSupport.map((a) => formatAlertLine(a, { rich })).join('\n');
      sections.push(`💼 **Support Queue**${dutyTag} (${sortedSupport.length} open):\n\n${lines}`);
    }
  }

  let title;
  if (mode === 'oncall') {
    title = `🚨 **CKS OpsGenie Alerts** (${sortedOnCall.length} on-call)\n👤 **On-Duty**: 📞 On-Call: **${onCallPerson}**`;
  } else if (mode === 'support') {
    title = `🚨 **CKS OpsGenie Alerts** (${sortedSupport.length} support)\n👤 **On-Duty**: 💼 Support: **${supportPerson}**`;
  } else {
    title = `🚨 **CKS OpsGenie Alerts** (${totalCount} open: ${sortedOnCall.length} on-call, ${sortedSupport.length} support)\n👤 **On-Duty**: 📞 On-Call: **${onCallPerson}** · 💼 Support: **${supportPerson}**`;
  }

  return `${title}\n\n${sections.join('\n\n')}`;
}

export class MergeRequestWatcher {
  constructor({
    config,
    gitlab,
    jira,
    confluence = null,
    opsgenie,
    hrworks = null,
    screenshot = null,
    authManager,
    health = null,
    getMessage: customGetMessage = null,
    webhookServer = null,
  }) {
    this.config = config;
    this.gitlab = gitlab;
    this.jira = jira;
    this.confluence = confluence;
    this.opsgenie = opsgenie;
    this.hrworks = hrworks;
    this.screenshot = screenshot;
    this.authManager = authManager;
    this.health = health;
    this.webhookServer = webhookServer;
    this.getMessage = customGetMessage || getMessage;
    this.approvingMrs = new Set();
    this.botPlacedReactions = new Map();
    this.syncingAwardEmojis = new Set();
    this.pollIntervalMs = (config.gitlab.poll_interval_seconds || 60) * 1000;
    // Watched Jira issues we cannot read (HTTP 403/404): `${mr key}|${issue key}` -> retry state.
    this.jiraIssueDenials = new Map();
    this.historyLimit = config.gitlab.history_limit || 50;
    this.historyMaxAgeMinutes = config.gitlab?.history_max_age_minutes ?? 10;
    this.maxWatchDurationMs = (config.gitlab?.max_watch_duration_seconds ?? 7200) * 1000;

    this.watchedConversations = new Set();
    this.conversationMeta = new Map();
    for (const c of config.conversations) {
      this.watchedConversations.add(c.id);
      this.conversationMeta.set(c.id, c);
      try {
        const decoded = decodeURIComponent(c.id);
        this.watchedConversations.add(decoded);
        this.conversationMeta.set(decoded, c);
      } catch {}
    }

    this.watched = new Map();
    this.snakeRunning = false;
    this.pollTimer = null;
    this.precomputeTimer = null;
    this.selfMri = null;
    this.selfOid = null;
    this.processedPersonalReactions = new Set();
    this.editOwnUrlMessages = Boolean(config.teams?.edit_own_url_messages ?? false);
    this.richMessages = config.teams?.rich_messages === true;
    const tvConfig = normalizeTvConfig(config.tv);
    this.tv = new TvProgrammeService(tvConfig);
    this.tvSwitch = new TvSwitch(tvConfig.switch);
    // Rich mode covers every outward message, not only the ones built with richMessage() (see prepareRichMessages).
    setRichMessages(this.richMessages);
    this.approveFlow = null;
    this.adminOids = new Set(
      (config.teams?.admin_ids || []).map(extractUserOid).filter(Boolean)
    );

    this.cacheTtlMs = 15 * 60 * 1000; // 15 minutes
    this.precomputeIntervalMs = 10 * 60 * 1000; // 10 minutes
    this.mrsCache = { data: null, timestamp: 0, loading: null };
    this.alertsCache = { data: null, timestamp: 0, loading: null };
    this.sprintCache = { text: null, timestamp: 0, loading: null };
    this.meetingsCache = { text: null, timestamp: 0, loading: null };

    const stateDir = process.env.XDG_STATE_HOME || path.join(process.cwd(), 'state');
    if (!fs.existsSync(stateDir)) {
      try {
        fs.mkdirSync(stateDir, { recursive: true });
      } catch {
        // ignore
      }
    }
    this.stateFile = path.join(stateDir, 'watcher-state.json');
    // Admin alerts about connector credentials; see src/service-alerts.mjs
    this.serviceAlerts = new ServiceAlertTracker({
      notify: (event) => this.sendServiceAlert(event),
      file: path.join(stateDir, 'service-alerts.json'),
      options: serviceAlertOptionsFromConfig(config.teams?.service_alerts),
      log,
    });
    this.completedMessages = new Set();
    // Message ids already taken up by push or a history scan in this process, so
    // the history poll and trouter never handle the same message twice.
    this.seenMessageIds = new Set();
    this.historyPollTimer = null;
    this.historyPollRunning = false;
    this.savedEntries = new Map();
    this.userInteractions = new Map();
    this.bannedUsers = new Map();
    this.userDirectory = new UserDirectory({
      searchFn: searchPeople,
      resolveProfilesFn: resolveProfiles,
    });
    // Profile pictures for the people on cards: only in rich mode, never in regular messages.
    this.suppressAvatars = false;
    this.avatarService = this.richMessages
      ? new AvatarService({
          directory: this.userDirectory,
          getSelfProfile: () => this.authManager?.getUserProfile?.(),
          // Where Teams has no picture: Jira, then Confluence, then a configured picture for accounts
          // that exist in no directory (a bot).
          fallbacks: createAvatarFallbacks({
            jira: this.jira,
            confluence: this.confluence,
            sources: config.avatars?.fallback_sources,
          }),
          // Built-in pictures of well-known bots (Renovate) first: a configured picture for a name wins.
          overrides: [...BUILTIN_AVATAR_OVERRIDES, ...loadAvatarOverrides(config.avatars?.overrides)],
          // The limit comes from the service: a full page means "maybe more", which fails closed.
          searchFn: async (name, limit) => {
            const res = await searchPeople(name, limit);
            if (!res?.ok) throw new Error('directory search failed');
            return res.value?.results || [];
          },
        })
      : null;
    this.pendingSuggestions = new Map();
    this.typoMessageToSuggestion = new Map();
    this.thumbnailEditedMessageIds = new Set();
    this.pendingTokenRenewalMessageIds = new Set();
    // Rotated fallback tokens (index -> rotation response) that could not be saved yet. The old
    // token is already revoked, so these only live in memory until a retry reaches the disk.
    this.unsavedFallbackTokens = new Map();
    // Same for the primary token: the rotation response, held until it is saved.
    this.unsavedPrimaryToken = null;
    this.primaryRenewalInFlight = null;
    this.lastGitLabExpiryWarningAt = 0;
    this.tokenExpiryCheckTimer = null;
    this.webhookSetupStatus = null;
    this.lastWebhookEvent = null;
    // Who the bot approved for (an approval from Teams is made by the bot's GitLab account): `project!iid` -> {name, mri, at}.
    this.teamsApprovals = new Map();
    // Display names and usernames of the bot's GitLab accounts, lowercase (filled by refreshBotNames).
    this.botNames = new Set();
    this.loadState();
  }

  loadState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const raw = fs.readFileSync(this.stateFile, 'utf8');
        const data = JSON.parse(raw);
        if (data.teamsApprovals && typeof data.teamsApprovals === 'object') {
          for (const [k, v] of Object.entries(data.teamsApprovals)) {
            if (v?.name) this.teamsApprovals.set(k, { name: String(v.name), mri: String(v.mri || ''), at: Number(v.at) || 0 });
          }
        }
        if (Array.isArray(data.completedMessages)) {
          this.completedMessages = new Set(data.completedMessages);
        }
        if (Array.isArray(data.botMessageIds)) {
          for (const id of data.botMessageIds) {
            recordBotMessageId(id);
          }
        }
        if (data.entries && typeof data.entries === 'object') {
          this.savedEntries = new Map(Object.entries(data.entries));
          for (const [key, saved] of Object.entries(data.entries)) {
            if (this.completedMessages.has(key)) continue;
            const createdAt = saved.createdAt || 0;
            if (Date.now() - createdAt > this.maxWatchDurationMs) continue;
            const slashIndex = key.lastIndexOf('/');
            if (slashIndex === -1) continue;
            const conversationId = saved.conversationId || key.slice(0, slashIndex);
            const messageId = saved.messageId || key.slice(slashIndex + 1);
            if (this.completedMessages.has(String(messageId))) continue;
            // Rich mode never places state reactions, so a saved status says nothing
            // about a thumbs up: it may be the user's own. The other state reactions
            // stay tracked so a leftover of an earlier plain run is still retired.
            if (saved.status && STATUS_REACTIONS[saved.status] && !(this.richMessages && STATUS_REACTIONS[saved.status] === 'like')) {
              this.recordBotReaction(messageId, STATUS_REACTIONS[saved.status]);
            }
            this.watched.set(key, {
              conversationId,
              messageId,
              from: saved.from ?? null,
              fromMri: saved.fromMri ?? null,
              content: saved.content ?? '',
              createdAt,
              status: saved.status ?? null,
              isSelf: saved.isSelf ?? (this.isSenderSelf({ from: saved.from, fromMri: saved.fromMri })),
              isOnlyUrl: saved.isOnlyUrl ?? isMessageOnlyUrl(saved.content ?? ''),
              targetUrl: saved.targetUrl ?? null,
              editedOriginal: saved.editedOriginal ?? false,
              multiMrMessageServerId: saved.multiMrMessageServerId ?? null,
              mrs: (saved.mrs ?? []).map((m) => ({
                project: m.project,
                iid: m.iid,
                title: m.title ?? null,
                lastReportedTitle: m.lastReportedTitle ?? m.title ?? null,
                lastReportedDraft: m.lastReportedDraft ?? null,
                lastReportedJiraKey: m.lastReportedJiraKey ?? null,
                status: m.status ?? null,
                lastReportedClosed: m.lastReportedClosed ?? false,
                ciMessageServerId: m.ciMessageServerId ?? null,
                lastReportedPipelineId: m.lastReportedPipelineId ?? null,
                lastReportedPipelineStatus: m.lastReportedPipelineStatus ?? null,
                lastReportedApprovalStatus: m.lastReportedApprovalStatus ?? false,
                lastReportedApprovedBy: m.lastReportedApprovedBy ?? null,
                rebaseMessageServerId: m.rebaseMessageServerId ?? null,
                lastReportedNeedsRebase: m.lastReportedNeedsRebase ?? null,
                lastReportedAutoMerge: m.lastReportedAutoMerge ?? null,
                lastReportedAutoMergeUser: m.lastReportedAutoMergeUser ?? null,
              })),
              jobs: (saved.jobs ?? []).map((j) => ({
                project: j.project,
                jobId: j.jobId,
                status: j.status ?? null,
                duration: j.duration ?? null,
                ciMessageServerId: j.ciMessageServerId ?? null,
                lastReportedStatus: j.lastReportedStatus ?? null,
                mr: j.mr ?? null,
              })),
              pipelines: (saved.pipelines ?? []).map((p) => ({
                project: p.project,
                pipelineId: p.pipelineId,
                status: p.status ?? null,
                duration: p.duration ?? null,
                ciMessageServerId: p.ciMessageServerId ?? null,
                lastReportedStatus: p.lastReportedStatus ?? null,
                mr: p.mr ?? null,
              })),
              isHistory: false,
            });
          }
        }
        if (data.userInteractions && typeof data.userInteractions === 'object') {
          this.userInteractions = new Map(Object.entries(data.userInteractions));
          this.userDirectory.loadInteractions(this.userInteractions);
        }
        if (data.bannedUsers && typeof data.bannedUsers === 'object') {
          this.bannedUsers = new Map(Object.entries(data.bannedUsers));
        }
        if (Array.isArray(data.pendingTokenRenewalMessageIds)) {
          this.pendingTokenRenewalMessageIds = new Set(data.pendingTokenRenewalMessageIds.map(String));
        }
        if (typeof data.lastGitLabExpiryWarningAt === 'number') {
          this.lastGitLabExpiryWarningAt = data.lastGitLabExpiryWarningAt;
        }
        if (data.lastWebhookEvent && typeof data.lastWebhookEvent === 'object') {
          this.lastWebhookEvent = data.lastWebhookEvent;
        }
        if (data.webhookSetupStatus && typeof data.webhookSetupStatus === 'object') {
          this.webhookSetupStatus = data.webhookSetupStatus;
        }
        this.userDirectory.loadConfig(this.config);
        log(
          `Loaded state from ${this.stateFile}: ${this.completedMessages.size} completed messages, ${this.savedEntries.size} saved active entries, ${this.userInteractions.size} tracked users, ${this.bannedUsers.size} banned users`
        );
      }
    } catch (err) {
      log(`Error loading state from ${this.stateFile}: ${err.message}`);
    }
  }

  saveState() {
    try {
      const entriesObj = {};
      for (const [k, v] of this.watched.entries()) {
        entriesObj[k] = {
          conversationId: v.conversationId,
          messageId: v.messageId,
          from: v.from,
          fromMri: v.fromMri,
          content: v.content,
          status: v.status,
          createdAt: v.createdAt,
          isSelf: v.isSelf ?? false,
          isOnlyUrl: v.isOnlyUrl ?? false,
          targetUrl: v.targetUrl ?? null,
          editedOriginal: v.editedOriginal ?? false,
          multiMrMessageServerId: v.multiMrMessageServerId ?? null,
          mrs: (v.mrs || []).map((m) => ({
            project: m.project,
            iid: m.iid,
            title: m.title ?? null,
            lastReportedTitle: m.lastReportedTitle ?? m.title ?? null,
            lastReportedDraft: m.lastReportedDraft ?? null,
            lastReportedJiraKey: m.lastReportedJiraKey ?? null,
            status: m.status,
            ciMessageServerId: m.ciMessageServerId,
            lastReportedPipelineId: m.lastReportedPipelineId,
            lastReportedPipelineStatus: m.lastReportedPipelineStatus,
            lastReportedApprovalStatus: m.lastReportedApprovalStatus,
            lastReportedApprovedBy: m.lastReportedApprovedBy,
            rebaseMessageServerId: m.rebaseMessageServerId,
            lastReportedNeedsRebase: m.lastReportedNeedsRebase,
            lastReportedAutoMerge: m.lastReportedAutoMerge ?? null,
            lastReportedAutoMergeUser: m.lastReportedAutoMergeUser ?? null,
          })),
          jobs: (v.jobs || []).map((j) => ({
            project: j.project,
            jobId: j.jobId,
            status: j.status,
            duration: j.duration,
            ciMessageServerId: j.ciMessageServerId,
            lastReportedStatus: j.lastReportedStatus,
            mr: j.mr ?? null,
          })),
          pipelines: (v.pipelines || []).map((p) => ({
            project: p.project,
            pipelineId: p.pipelineId,
            status: p.status,
            duration: p.duration,
            ciMessageServerId: p.ciMessageServerId,
            lastReportedStatus: p.lastReportedStatus,
            mr: p.mr ?? null,
          })),
          jiraIssues: (v.jiraIssues || []).map((j) => ({
            key: j.key,
            url: j.url,
            summary: j.summary,
            status: j.status,
            statusCategory: j.statusCategory,
            messageServerId: j.messageServerId,
          })),
          opsgenieAlerts: (v.opsgenieAlerts || []).map((a) => ({
            id: a.id,
            url: a.url,
            message: a.message,
            status: a.status,
            acknowledged: a.acknowledged,
            messageServerId: a.messageServerId,
          })),
          confluencePages: (v.confluencePages || []).map((c) => ({
            key: c.key,
            target: c.target,
            url: c.url,
            title: c.title,
            spaceKey: c.spaceKey,
            spaceName: c.spaceName,
            messageServerId: c.messageServerId,
          })),
          codeLinks: (v.codeLinks || []).map((c) => ({
            key: c.key,
            project: c.project,
            refPath: c.refPath,
            startLine: c.startLine,
            endLine: c.endLine,
            url: c.url,
            messageServerId: c.messageServerId,
            unavailable: Boolean(c.unavailable),
          })),
        };
      }
      const completedArray = Array.from(this.completedMessages);
      const cappedCompleted = completedArray.length > 1000 ? completedArray.slice(-1000) : completedArray;
      const botArray = Array.from(botSentMessageIds);
      const cappedBot = botArray.length > 2000 ? botArray.slice(-2000) : botArray;

      const interactionsObj = {};
      for (const [k, v] of this.userInteractions.entries()) {
        interactionsObj[k] = v;
      }

      const bannedObj = {};
      for (const [k, v] of this.bannedUsers.entries()) {
        bannedObj[k] = v;
      }

      const data = {
        completedMessages: cappedCompleted,
        botMessageIds: cappedBot,
        entries: entriesObj,
        userInteractions: interactionsObj,
        bannedUsers: bannedObj,
        teamsApprovals: Object.fromEntries([...this.teamsApprovals].sort((a, b) => b[1].at - a[1].at).slice(0, TEAMS_APPROVALS_KEEP)),
        pendingTokenRenewalMessageIds: Array.from(this.pendingTokenRenewalMessageIds || []),
        lastGitLabExpiryWarningAt: this.lastGitLabExpiryWarningAt || 0,
        lastWebhookEvent: this.lastWebhookEvent || null,
        webhookSetupStatus: this.webhookSetupStatus || null,
      };
      const tmpPath = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.stateFile);
    } catch (err) {
      log(`Error saving state to ${this.stateFile}: ${err.message}`);
    }
  }

  recordUserInteraction(event, command) {
    const key = event.fromMri || event.from || 'unknown';
    const name = event.from || event.fromMri || 'Anonymous';
    let userStats = this.userInteractions.get(key);
    if (!userStats) {
      userStats = {
        name,
        mri: event.fromMri || '',
        count: 0,
        commands: {},
        lastSeen: Date.now(),
      };
      this.userInteractions.set(key, userStats);
    }
    if (event.from && userStats.name !== event.from) {
      userStats.name = event.from;
    }
    this.userDirectory.registerInteraction(event.from, event.fromMri);
    userStats.count = (userStats.count || 0) + 1;
    userStats.commands = userStats.commands || {};
    userStats.commands[command] = (userStats.commands[command] || 0) + 1;
    userStats.lastSeen = Date.now();
    this.saveState();
  }

  getAdminConversationId() {
    const notesConv = this.config.conversations.find(
      (c) => c.id === '48:notes' || (c.name && c.name.toLowerCase().includes('notes'))
    );
    return notesConv ? notesConv.id : '48:notes';
  }

  /**
   * The watched conversations as `{ name, id }` for the startup announcement.
   * The name is the title Teams shows (read-only lookup, remembered once found),
   * not the configured label, which is a short handle; when the lookup is
   * unavailable (or for the Notes self-chat) the configured label is the
   * fallback, so a failing lookup never blocks the announcement.
   */
  async lifecycleChats() {
    const lookupMs = 5000;
    this.conversationTitles ??= new Map();
    const seen = new Set();
    const entries = [];
    for (const c of this.config.conversations || []) {
      let id = String(c.id || '');
      try {
        id = decodeURIComponent(id);
      } catch {}
      if (!id || seen.has(id)) continue;
      seen.add(id);
      entries.push({ id, label: String(c.name || '').trim() });
    }
    return Promise.all(
      entries.map(async ({ id, label }) => {
        if (id.startsWith('19:') && !this.conversationTitles.has(id)) {
          let timer;
          try {
            const title = await Promise.race([
              transport.getConversationTitle(id),
              new Promise((resolve) => {
                timer = setTimeout(() => resolve(''), lookupMs);
              }),
            ]);
            if (typeof title === 'string' && title.trim()) this.conversationTitles.set(id, title.trim());
          } catch (err) {
            log(`Chat title lookup failed for a watched conversation: ${err.message}`);
          } finally {
            clearTimeout(timer);
          }
        }
        return { id, name: this.conversationTitles.get(id) || label || 'Chat' };
      })
    );
  }

  async sendStartupAnnouncement() {
    const adminConv = this.getAdminConversationId();
    if (!adminConv) return;

    const hostname = os.hostname();
    const pid = process.pid;
    const version = process.version;
    const platform = `${process.platform} ${process.arch}`;
    const startTime = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const chats = chatList(await this.lifecycleChats());
    const memRss = Math.round(process.memoryUsage().rss / 1024 / 1024);

    const isWhListening = Boolean(this.webhookServer?.listening);
    const pollSec = `${this.pollIntervalMs / 1000}s`;
    let gitlabFact;
    if (isWhListening) {
      const targetGroup = this.webhookSetupStatus?.group || this.config.gitlab?.group || this.gitlab?.group;
      // The group's webhook management page of the configured GitLab host (never the callback URL or its secret).
      const hooksUrl = gitlabHooksUrl(this.gitlab?.host || this.config.gitlab?.host, targetGroup);
      let setupDetail = '';
      if (this.webhookSetupStatus?.ok) {
        setupDetail = `configured on \`${targetGroup}\`${this.webhookSetupStatus.hookId ? ` id: ${this.webhookSetupStatus.hookId}` : ''}, `;
      } else {
        setupDetail = `listening on :${this.webhookServer.port}, `;
      }
      // The card drops the group and the hook id: the state and the fallback interval are what matter.
      const cardState = this.webhookSetupStatus?.ok ? 'Webhooks' : 'Webhook listener';
      gitlabFact = [
        'GitLab',
        `${linkedText('Webhooks active', hooksUrl)} (${setupDetail}fallback poll every ${pollSec})`,
        `${linkedText(cardState, hooksUrl)} · fallback ${pollSec}`,
      ];
    } else {
      gitlabFact = ['GitLab', `Polling every ${pollSec}`, `Polling · ${pollSec}`];
    }

    // Jira: the configured project(s) as links, with a concise suffix when the service is unhealthy.
    const jiraHealth = this.health?.getHealth?.()?.services?.jira?.status;
    const jiraSuffix = jiraHealth === 'auth_expired' ? ' (auth expired)' : jiraHealth === 'error' ? ' (error)' : '';
    const jiraValue = this.jira?.isConfigured()
      ? `${jiraProjectList(this.jira.baseUrl, [this.jira.project])}${jiraSuffix}`
      : 'Not configured';

    const facts = [
      ['Host', `\`${hostname}\``],
      ['PID', `\`${pid}\``],
      ['Runtime', `Node.js \`${version}\` (${platform})`],
      ['Memory', `${memRss} MB`],
      ['Started', startTime],
      ['Watched Conversations', chats, chats],
      gitlabFact,
      ['Jira', jiraValue, jiraValue],
      ['Home Assistant (HR works)', this.hrworks?.isConfigured() ? 'Active' : 'Not configured'],
      ['Precompute Cache', `Active (every ${this.precomputeIntervalMs / 60000}m)`],
    ];

    let notice = null;
    if (this.config.gitlab?.is_token_override) {
      const overridePath = this.config.gitlab.override_token_path;
      notice = {
        title: 'WARNING: GitLab Token Override is Active!',
        facts: [['Override File', `\`${overridePath}\``]],
        body:
          'The configured secret file was read-only; please update the rotated token in your host configuration/SOPS (`nixos-config-private`) so it persists:',
        command: `cat ${overridePath}`,
      };
    }

    const spec = { kind: 'startup', facts, notice };
    log(`Sending startup announcement to ${adminConv}...`);
    await sendDirectMessage(adminConv, this.richMessage(lifecycleMarkdown(spec), () => buildLifecycleCard(spec)));
  }

  async sendShutdownAnnouncement(signal = 'SIGTERM') {
    const adminConv = this.getAdminConversationId();
    if (!adminConv) return;

    const hostname = os.hostname();
    const pid = process.pid;
    const uptimeSec = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSec / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const seconds = uptimeSec % 60;
    const uptimeStr = `${hours > 0 ? `${hours}h ` : ''}${minutes}m ${seconds}s`;
    const shutdownTime = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

    const spec = {
      kind: 'shutdown',
      facts: [
        ['Host', `\`${hostname}\``],
        ['PID', `\`${pid}\``],
        ['Signal', `\`${signal}\``],
        ['Uptime', uptimeStr],
        ['Time', shutdownTime],
      ],
    };
    log(`Sending shutdown announcement (${signal}) to ${adminConv}...`);
    await sendDirectMessage(adminConv, this.richMessage(lifecycleMarkdown(spec), () => buildLifecycleCard(spec)));
  }

  /** True while a watched Jira issue we could not read is still in its retry back-off. */
  isJiraIssueDenied(denialKey, now = Date.now()) {
    return now < (this.jiraIssueDenials.get(denialKey)?.nextCheck ?? 0);
  }

  /** Records another denied read of a watched Jira issue; returns the delay until the next check. */
  recordJiraIssueDenial(denialKey, now = Date.now()) {
    const strikes = (this.jiraIssueDenials.get(denialKey)?.strikes ?? 0) + 1;
    const delayMs = Math.min(JIRA_ISSUE_DENIED_MAX_DELAY_MS, this.pollIntervalMs * 2 ** strikes);
    this.jiraIssueDenials.set(denialKey, { strikes, nextCheck: now + delayMs });
    return delayMs;
  }

  /** Connector credential failure; the tracker decides whether and when the admin hears about it. */
  notifyAdminAuthExpired(serviceName, errorDetails) {
    this.serviceAlerts.reportFailure(serviceName, errorDetails);
  }

  notifyAdminAuthRecovered(serviceName) {
    this.serviceAlerts.reportSuccess(serviceName);
  }

  async sendServiceAlert(event) {
    const adminConv = this.getAdminConversationId();
    if (!adminConv) return;
    const msg = formatServiceAlert(event, {
      hostname: os.hostname(),
      time: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    });
    if (!msg) return;
    log(`[alert] Notifying admin (${adminConv}) about ${event.name} (${event.type})`);
    try {
      await sendDirectMessage(adminConv, msg);
    } catch (err) {
      log(`[alert] Failed to send ${event.type} alert for ${event.name} to ${adminConv}: ${err.message}`);
    }
  }

  async getConnectorsStatus() {
    const health = this.health?.getHealth?.();
    const services = health?.services || {};

    // 1. Teams
    const teamsProfile = this.authManager?.getUserProfile?.();
    const authStatus = getMessageAuthStatus();
    let teamsUserStr = 'Unknown';
    if (teamsProfile) {
      const parts = [teamsProfile.displayName, teamsProfile.email ? `(${teamsProfile.email})` : ''].filter(Boolean);
      teamsUserStr = parts.join(' ') || teamsProfile.mri || 'Unknown';
    } else if (this.selfMri) {
      teamsUserStr = this.selfMri;
    }

    const teamsStatus = {
      name: 'Microsoft Teams',
      status: authStatus.hasToken ? 'ok' : 'auth_expired',
      connected: health?.teams?.connected ?? true,
      user: teamsUserStr,
      details: `Token: ~${authStatus.minutesRemaining ?? 0}m | Trouter: ${health?.teams?.trouter || 'connected'}`,
    };

    // 2. GitLab
    let glUser = null;
    if (this.gitlab?.token) {
      glUser = await this.gitlab.getCurrentUser().catch(() => null);
    }
    let glTokenInfo = null;
    if (this.gitlab?.getTokenInfo) {
      try {
        const rawToken = await this.gitlab.getTokenInfo();
        if (rawToken) {
          glTokenInfo = formatTokenExpiry(rawToken);
        }
      } catch {}
    }
    const glHealth = services.gitlab || {};
    let webhookStatusStr = null;
    if (this.webhookServer?.listening) {
      const portStr = this.webhookServer.port ? `:${this.webhookServer.port}` : '';
      if (this.webhookSetupStatus?.ok) {
        const group = this.webhookSetupStatus.group || this.gitlab?.group || '';
        const idPart = this.webhookSetupStatus.hookId ? `ID: ${this.webhookSetupStatus.hookId}` : '';
        const details = [group ? `group: \`${group}\`` : '', idPart, `listening on ${portStr}`].filter(Boolean).join(', ');
        webhookStatusStr = `🟢 Configured (${details})`;
      } else if (this.webhookSetupStatus && !this.webhookSetupStatus.ok) {
        webhookStatusStr = `⚠️ Setup error: ${this.webhookSetupStatus.error || 'Failed'} (listening on ${portStr})`;
      } else {
        webhookStatusStr = `🟢 Listening on ${portStr}`;
      }
    } else if (this.config.gitlab?.webhook?.enable) {
      webhookStatusStr = '❌ Enabled but not listening';
    } else {
      webhookStatusStr = '⚪ Disabled (polling fallback only)';
    }

    let lastWebhookStr = null;
    if (this.lastWebhookEvent?.timestamp) {
      const dateStr = new Date(this.lastWebhookEvent.timestamp).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
      const ageSec = Math.max(0, Math.floor((Date.now() - this.lastWebhookEvent.timestamp) / 1000));
      let ageStr = '';
      if (ageSec < 60) {
        ageStr = `${ageSec}s ago`;
      } else if (ageSec < 3600) {
        ageStr = `${Math.floor(ageSec / 60)}m ago`;
      } else {
        const h = Math.floor(ageSec / 3600);
        const m = Math.floor((ageSec % 3600) / 60);
        ageStr = `${h}h ${m}m ago`;
      }
      lastWebhookStr = `${dateStr} (${ageStr}) — ${this.lastWebhookEvent.summary || this.lastWebhookEvent.eventType}`;
    } else if (this.webhookServer?.listening || this.config.gitlab?.webhook?.enable) {
      lastWebhookStr = 'None received yet (waiting for GitLab events)';
    }

    const gitlabStatus = {
      name: 'GitLab',
      configured: Boolean(this.gitlab?.token),
      status: !this.gitlab?.token ? 'unconfigured' : (glHealth.status || 'ok'),
      host: this.gitlab?.host || 'git.wiit.one',
      group: this.gitlab?.group || '',
      user: glUser ? `${glUser.name || ''} (@${glUser.username})`.trim() : (glHealth.status === 'auth_expired' ? 'Auth expired' : 'N/A'),
      webhook: webhookStatusStr,
      webhookLastReceived: lastWebhookStr,
      tokenExpiry: glTokenInfo,
      tokenOverride: this.config.gitlab?.is_token_override ? this.config.gitlab.override_token_path : null,
      error: glHealth.error,
    };

    // 3. Jira
    let jiraUser = null;
    if (this.jira?.isConfigured()) {
      jiraUser = await this.jira.getCurrentUser().catch(() => null);
    }
    const jiraHealth = services.jira || {};
    const jiraStatus = {
      name: 'Jira',
      configured: Boolean(this.jira?.isConfigured()),
      status: !this.jira?.isConfigured() ? 'unconfigured' : (jiraHealth.status || 'ok'),
      url: this.jira?.baseUrl || '',
      project: this.jira?.project || '',
      user: jiraUser ? `${jiraUser.displayName || ''} (${jiraUser.name})`.trim() : (jiraHealth.status === 'auth_expired' ? 'Auth expired' : 'N/A'),
      error: jiraHealth.error,
    };

    // 4. OpsGenie
    const ogHealth = services.opsgenie || {};
    const opsgenieStatus = {
      name: 'OpsGenie',
      configured: Boolean(this.opsgenie?.isConfigured()),
      status: !this.opsgenie?.isConfigured() ? 'unconfigured' : (ogHealth.status || 'ok'),
      endpoint: this.opsgenie?.baseUrl?.includes('eu') ? 'EU' : 'US',
      onCall: Boolean(this.opsgenie?.onCallKey),
      support: Boolean(this.opsgenie?.supportKey),
      error: ogHealth.error,
    };

    // 5. Home Assistant (HR works)
    const haConfigured = Boolean(this.hrworks?.isConfigured?.());
    let haCheck = null;
    if (haConfigured && typeof this.hrworks?.checkConnection === 'function') {
      haCheck = await this.hrworks.checkConnection().catch(() => null);
    }
    const haHealth = services.homeassistant || {};
    let haStatus = !haConfigured ? 'unconfigured' : (haHealth.status || 'ok');
    if (haCheck && !haCheck.ok) {
      haStatus = haCheck.status || 'error';
    }
    const haError = haCheck?.error || haHealth.error || this.hrworks?.lastError || null;

    const stats = this.hrworks?.getStats?.() || {};
    const empCount = stats.employees ?? 0;
    const absCount = stats.absences ?? 0;
    const unitsCount = stats.units ?? 0;
    let haDetails = 'empty';
    if (empCount > 0 || absCount > 0) {
      const lastPrefetch = stats.lastFullPrefetchAt || stats.lastTeamPrefetchAt || 0;
      const ageStr = lastPrefetch ? `${Math.round((Date.now() - lastPrefetch) / 1000)}s ago` : 'cached';
      const unitsPart = unitsCount > 0 ? `, ${unitsCount} units` : '';
      haDetails = `${empCount} employees, ${absCount} absences${unitsPart} (${ageStr})`;
    } else if (haConfigured) {
      haDetails = '0 employees (prefetch pending)';
    }

    const homeAssistantStatus = {
      name: 'Home Assistant (HR works)',
      configured: haConfigured,
      status: haStatus,
      url: this.hrworks?.url || '',
      details: haDetails,
      error: haError,
    };

    // 6. Confluence
    let confUser = null;
    if (this.confluence?.isConfigured()) {
      confUser = await this.confluence.getCurrentUser().catch(() => null);
    }
    const confHealth = services.confluence || {};
    const confluenceStatus = {
      name: 'Confluence',
      configured: Boolean(this.confluence?.isConfigured()),
      status: !this.confluence?.isConfigured() ? 'unconfigured' : (confHealth.status || 'ok'),
      url: this.confluence?.baseUrl || '',
      user: confUser ? `${confUser.displayName || ''} (${confUser.username || confUser.name || ''})`.trim() : (confHealth.status === 'auth_expired' ? 'Auth expired' : 'N/A'),
      error: confHealth.error,
    };

    // 7. Screenshot / browser-daemon
    const ssConfigured = Boolean(this.screenshot?.isConfigured?.());
    const ssHealth = services.screenshot || {};
    const screenshotStatus = {
      name: 'browser-daemon (screenshot)',
      configured: ssConfigured,
      status: !ssConfigured ? 'unconfigured' : (ssHealth.status || 'ok'),
      url: this.screenshot?.url || '',
      error: ssHealth.error,
    };

    return {
      teams: teamsStatus,
      gitlab: gitlabStatus,
      jira: jiraStatus,
      confluence: confluenceStatus,
      opsgenie: opsgenieStatus,
      homeassistant: homeAssistantStatus,
      screenshot: screenshotStatus,
    };
  }

  getPrecomputeCacheLines() {
    const mrsAge = this.mrsCache?.data ? `${Math.round((Date.now() - this.mrsCache.timestamp) / 1000)}s ago` : 'empty';
    const alertsAge = this.alertsCache?.data ? `${Math.round((Date.now() - this.alertsCache.timestamp) / 1000)}s ago` : 'empty';
    const sprintAge = this.sprintCache?.text ? `${Math.round((Date.now() - this.sprintCache.timestamp) / 1000)}s ago` : 'empty';
    const meetingsAge = this.meetingsCache?.text ? `${Math.round((Date.now() - this.meetingsCache.timestamp) / 1000)}s ago` : 'empty';

    const hrworksStats = this.hrworks?.getStats?.() || {};
    const hrworksPrefetch = hrworksStats.lastFullPrefetchAt || hrworksStats.lastTeamPrefetchAt || 0;
    const hrworksAge = !this.hrworks?.isConfigured?.()
      ? 'not configured'
      : (hrworksPrefetch ? `${Math.round((Date.now() - hrworksPrefetch) / 1000)}s ago` : 'empty');
    const hrworksDetails = hrworksStats.employees ? ` (${hrworksStats.employees} employees, ${hrworksStats.absences} absences)` : '';

    return [
      `  - \`/mrs\`: ${mrsAge}`,
      `  - \`/alerts\`: ${alertsAge}`,
      `  - \`/sprint\`: ${sprintAge}`,
      `  - \`/meetings\`: ${meetingsAge}`,
      `  - \`/whereis\` (HR works): ${hrworksAge}${hrworksDetails}`,
    ];
  }

  setSelfMri(mri) {
    this.selfMri = mri;
    this.selfOid = extractUserOid(mri);
  }

  recordBotReaction(messageId, key) {
    if (!messageId || !key) return;
    const msgId = String(messageId);
    if (!this.botPlacedReactions.has(msgId)) {
      this.botPlacedReactions.set(msgId, new Set());
    }
    this.botPlacedReactions.get(msgId).add(String(key).toLowerCase());
  }

  unrecordBotReaction(messageId, key) {
    if (!messageId || !key) return;
    const msgId = String(messageId);
    const set = this.botPlacedReactions.get(msgId);
    if (set) {
      set.delete(String(key).toLowerCase());
      if (set.size === 0) this.botPlacedReactions.delete(msgId);
    }
  }

  isBotReaction(messageId, key) {
    if (!messageId || !key) return false;
    const msgId = String(messageId);
    const k = String(key).toLowerCase();
    if (this.botPlacedReactions.get(msgId)?.has(k)) return true;
    // With rich cards the bot places no state reactions: whatever sits on the
    // message (a thumbs up included) is the user's, whatever the entry status.
    if (this.richMessages) return false;
    for (const entry of this.watched.values()) {
      if (String(entry.messageId) === msgId && entry.status) {
        const expectedBotReaction = STATUS_REACTIONS[entry.status];
        if (expectedBotReaction && expectedBotReaction.toLowerCase() === k) {
          if (entry.editedOriginal && entry.status === 'pending') continue;
          return true;
        }
      }
    }
    return false;
  }

  get botPlacedLikeMessageIds() {
    return {
      has: (msgId) => this.isBotReaction(msgId, 'like'),
      add: (msgId) => this.recordBotReaction(msgId, 'like'),
      delete: (msgId) => this.unrecordBotReaction(msgId, 'like'),
    };
  }

  setWebhookServer(server) {
    this.webhookServer = server;
  }

  /** Enables the Approve button on merge request cards (an ApproveServer, or null). */
  setApproveFlow(flow) {
    this.approveFlow = flow || null;
  }

  /**
   * Remembers who really approved through the approval page: the signed-in GitLab user. The account that
   * approves is the bot's, so the card shows this person instead (with the Teams mark), like for `/approve`.
   * The directory person is found by an explicitly configured GitLab user name, else by the exact name;
   * without a match the GitLab name is shown (with initials). No comment is left here: the page does that.
   */
  recordWebApprover(project, iid, gitlabUser) {
    if (!project || iid === undefined || !gitlabUser?.username) return;
    const username = String(gitlabUser.username).toLowerCase();
    let user = null;
    try {
      const configured = this.userDirectory?.byGitlabUsername?.get(username);
      user = configured?.explicitGitlabUsernames?.has(username) ? configured : null;
      if (!user && gitlabUser.name) user = this.userDirectory?.findUser(gitlabUser.name) || null;
    } catch {
      user = null;
    }
    const name = user?.displayName || gitlabUser.name || gitlabUser.username;
    this.teamsApprovals.set(`${project}!${iid}`.toLowerCase(), { name: String(name), mri: String(user?.mri || ''), at: Date.now() });
    this.saveState();
  }

  /** The picture of a person for the approval pages: the cached photo, else their initials (as on the cards). */
  webAvatarOf(name) {
    const photo = this.avatarService && !this.suppressAvatars ? this.avatarService.peek(name) : null;
    return isImageDataUri(photo) && photo !== PLACEHOLDER_AVATAR ? photo : fallbackAvatar(name);
  }

  /**
   * Who a person (a display name the dashboard shows) is and whether they are around, for the dashboard's
   * person panel: the Teams directory entry (only an unambiguous match), Teams presence and HR WORKS absence.
   * Each slow source has its own time limit; a source that fails is left out, never guessed.
   */
  async personInfo(name) {
    const query = String(name || '').trim();
    if (!query || !this.userDirectory?.searchDirectory) return { name: query, found: false, reason: 'The Teams directory is not available.' };
    const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => { const t = setTimeout(() => resolve(undefined), ms); t.unref?.(); })]);
    let results;
    try {
      results = (await within(this.userDirectory.searchDirectory(query), 8_000)) || [];
    } catch (err) {
      log.warn(`Person lookup failed for a dashboard panel: ${err.message}`);
      return { name: query, found: false, reason: 'The Teams directory could not be searched right now.' };
    }
    const want = normalizeName(query);
    // One exact name match (the same account found twice counts once), else the only search result.
    const exact = [...new Map(results.filter((r) => r?.displayName && normalizeName(r.displayName) === want).map((r) => [r.mri || r.email || r.displayName, r])).values()];
    const person = exact.length === 1 ? exact[0] : !exact.length && results.length === 1 ? results[0] : null;
    if (!person) {
      return { name: query, found: false, reason: exact.length > 1 ? 'Several people in the Teams directory have this name.' : 'This person was not found in the Teams directory.' };
    }
    const info = {
      found: true,
      name: person.displayName || query,
      email: person.email || '',
      mri: person.mri || '',
      jobTitle: person.jobTitle || '',
      department: person.department || '',
      company: person.companyName || '',
      presence: null,
      absence: null,
    };
    const presence = person.mri
      ? within(getUserPresence(person.mri).then((res) => {
          const pr = res?.ok && Array.isArray(res.value?.data) ? res.value.data[0]?.presence : null;
          return pr ? { availability: pr.availability || '', activity: pr.activity || '', outOfOffice: pr.calendarData?.isOutOfOffice === true } : null;
        }).catch(() => null), 4_000)
      : Promise.resolve(null);
    info.presence = await presence;
    // The directory entry, for matching the person in HR WORKS (see personAbsence).
    info.directory = person;
    return info;
  }

  /**
   * The HR WORKS absence of a person `personInfo` found, from the calendar the background prefetch keeps in memory
   * (never a call to Home Assistant, so it costs nothing and is read fresh for every panel). `pending` while that
   * calendar is not loaded yet.
   */
  async personAbsence(info) {
    if (!this.hrworks || !info?.found || !info.directory) return null;
    try {
      const r = await this.hrworks.findPersonAbsence(info.directory, { offline: true });
      if (!r) return null;
      if (r.absence) return { state: 'away', current: r.absence };
      if (r.reason === 'not_found') return { state: 'not_found' };
      if (r.reason === 'calendar_unavailable') return { state: 'pending' };
      return { state: 'present', upcoming: r.upcomingAbsence || null };
    } catch {
      return { state: 'unavailable' };
    }
  }

  /** Loads the photos of the people an approval page shows (bounded by the picture service). */
  async webAvatarWarm(names) {
    if (!this.avatarService || this.suppressAvatars) return;
    await this.avatarService.avatarsFor(names);
  }

  /**
   * Link to the approval confirmation page, or null when the button must not
   * be shown: flow disabled, rich mode off, not a live open merge request,
   * draft or head commit unknown. The confirmation checks the signed-in user's approval.
   */
  mrApproveUrl(mr, mrDetails, { state }) {
    if (!this.approveFlow || !this.richMessages) return null;
    if (!['open', 'rebase', 'rebased'].includes(state)) return null;
    if (mrDetails?.draft === true) return null;
    const sha = typeof mrDetails?.sha === 'string' && mrDetails.sha ? mrDetails.sha : null;
    if (!sha || !mr?.project || mr.iid === undefined || mr.iid === null) return null;
    try {
      return this.approveFlow.linkFor({ project: mr.project, iid: mr.iid, sha });
    } catch (err) {
      log(`Approve link failed for ${mr.project}!${mr.iid}: ${err.message}`);
      return null;
    }
  }

  /**
   * Link to the merge confirmation page, or null when the button must not be
   * shown: flow disabled, rich mode off, not an open merge request (a merge
   * request that needs a rebase cannot be merged yet), draft, or head commit
   * unknown. The link is pinned to that head commit.
   */
  mrMergeUrl(mr, mrDetails, { state }) {
    if (!this.approveFlow || !this.richMessages) return null;
    if (!['open', 'rebased'].includes(state)) return null;
    if (mrDetails?.draft === true) return null;
    // Only what GitLab says is mergeable right now (approvals, pipeline, conflicts, discussions all in order):
    // a button that can only fail is not offered. The page checks again when it is opened.
    if (mrDetails?.detailedMergeStatus !== 'mergeable') return null;
    const sha = typeof mrDetails?.sha === 'string' && mrDetails.sha ? mrDetails.sha : null;
    if (!sha || !mr?.project || mr.iid === undefined || mr.iid === null) return null;
    try {
      return this.approveFlow.linkFor({ project: mr.project, iid: mr.iid, sha, action: 'merge' });
    } catch (err) {
      log(`Merge link failed for ${mr.project}!${mr.iid}: ${err.message}`);
      return null;
    }
  }

  /**
   * "Merge all" link of a multi merge request card, or null: only the open, non-draft merge requests GitLab
   * reports as mergeable right now, each pinned to its head commit (the page checks every one again).
   */
  batchMergeUrl(rows) {
    if (!this.approveFlow?.batchLinkFor || !this.richMessages) return null;
    const ready = rows.filter((row) => row.state === 'open' && !row.draft && row.sha && row.mergeable === true);
    if (!ready.length) return null;
    try {
      return this.approveFlow.batchLinkFor(ready, 'merge');
    } catch (err) {
      log(`Merge-all link failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Link to the rebase confirmation page, or null when the button must not be shown: flow disabled, rich mode
   * off, not an open merge request, not behind its target branch, or with merge conflicts (a rebase cannot
   * fix those).
   */
  mrRebaseUrl(mr, mrDetails, { state }) {
    if (!this.approveFlow || !this.richMessages) return null;
    if (!['open', 'rebase'].includes(state)) return null;
    if (mrDetails?.needsRebase !== true || mrDetails?.hasConflicts === true) return null;
    if (!mr?.project || mr.iid === undefined || mr.iid === null) return null;
    try {
      return this.approveFlow.linkFor({ project: mr.project, iid: mr.iid, action: 'rebase' });
    } catch (err) {
      log(`Rebase link failed for ${mr.project}!${mr.iid}: ${err.message}`);
      return null;
    }
  }

  /**
   * Link to the reopen confirmation page, or null when the button must not be
   * shown: flow disabled, rich mode off, or not a closed merge request (a
   * merged or open one cannot be reopened).
   */
  mrReopenUrl(mr, { state }) {
    if (!this.approveFlow || !this.richMessages) return null;
    if (state !== 'closed') return null;
    if (!mr?.project || mr.iid === undefined || mr.iid === null) return null;
    try {
      return this.approveFlow.linkFor({ project: mr.project, iid: mr.iid, action: 'reopen' });
    } catch (err) {
      log(`Reopen link failed for ${mr.project}!${mr.iid}: ${err.message}`);
      return null;
    }
  }

  /** Re-checks the watched cards of one merge request (like a webhook event does). */
  /**
   * The Teams card (the bot's status message) that shows a merge request, newest first when several
   * conversations watch it: `{conversationId, messageId}` or null. Used to link the card from the
   * comment an Approve-button approval leaves on the MR.
   */
  mrCardMessage(project, iid) {
    const projLower = String(project || '').toLowerCase();
    let best = null;
    for (const entry of this.watched.values()) {
      for (const m of entry.mrs || []) {
        if (String(m.iid) !== String(iid) || (m.project || '').toLowerCase() !== projLower || !m.ciMessageServerId) continue;
        if (!best || (entry.createdAt || 0) > best.at) best = { conversationId: entry.conversationId, messageId: String(m.ciMessageServerId), at: entry.createdAt || 0 };
      }
    }
    return best ? { conversationId: best.conversationId, messageId: best.messageId } : null;
  }

  async refreshMrCards(project, iid) {
    const projLower = String(project || '').toLowerCase();
    const keys = [];
    for (const [key, entry] of this.watched.entries()) {
      const hasMr = (entry.mrs || []).some(
        (m) => String(m.iid) === String(iid) && (m.project || '').toLowerCase() === projLower
      );
      if (hasMr) keys.push(key);
    }
    const results = await Promise.allSettled(keys.map((key) => this.checkWatchedKey(key)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    for (const r of results) {
      if (r.status === 'rejected') log(`Approval refresh failed: ${r.reason?.message || r.reason}`);
    }
    return { matched: keys.length, completed: keys.length - failed, failed };
  }

  setWebhookSetupStatus(status) {
    this.webhookSetupStatus = status;
    this.saveState();
  }

  async handleWebhookEvent(eventType, payload) {
    if (!payload) return;
    const kind = payload.object_kind || (eventType || '').toLowerCase();
    const timestamp = Date.now();
    let summary = kind;

    if (kind === 'merge_request' || eventType === 'Merge Request Hook') {
      const project = payload.project?.path_with_namespace || payload.project?.name;
      const iid = payload.object_attributes?.iid;
      const action = payload.object_attributes?.action || payload.object_attributes?.state;
      summary = `MR ${project}!${iid}${action ? ` (${action})` : ''}`;
      log(`GitLab webhook: ${summary}`);

      if (project && iid) {
        let matched = false;
        const projLower = project.toLowerCase();
        const projBase = projLower.split('/').pop();

        for (const [key, entry] of this.watched.entries()) {
          const hasMr = (entry.mrs || []).some((m) => {
            if (String(m.iid) !== String(iid)) return false;
            const mProj = (m.project || '').toLowerCase();
            return mProj === projLower || mProj.split('/').pop() === projBase;
          });
          if (hasMr) {
            matched = true;
            this.checkWatchedKey(key).catch((err) =>
              log(`Webhook check failed for ${key}: ${err.message}`)
            );
          }
        }

        if (!matched) {
          this.checkAllWatched().catch((err) =>
            log(`Webhook checkAllWatched failed: ${err.message}`)
          );
        }
      }
    } else if (kind === 'pipeline' || eventType === 'Pipeline Hook') {
      const project = payload.project?.path_with_namespace || payload.project?.name;
      const pipeId = payload.object_attributes?.id;
      const status = payload.object_attributes?.status;
      const mrIid = payload.merge_request?.iid;
      summary = `pipeline #${pipeId} for ${project} (${status}${mrIid ? `, MR !${mrIid}` : ''})`;
      log(`GitLab webhook: ${summary}`);

      if (mrIid && project) {
        const projLower = project.toLowerCase();
        const projBase = projLower.split('/').pop();
        for (const [key, entry] of this.watched.entries()) {
          const hasMr = (entry.mrs || []).some((m) => {
            if (String(m.iid) !== String(mrIid)) return false;
            const mProj = (m.project || '').toLowerCase();
            return mProj === projLower || mProj.split('/').pop() === projBase;
          });
          if (hasMr) {
            this.checkWatchedKey(key).catch((err) =>
              log(`Webhook pipeline check failed for ${key}: ${err.message}`)
            );
          }
        }
      } else {
        this.checkAllWatched().catch((err) =>
          log(`Webhook pipeline checkAllWatched failed: ${err.message}`)
        );
      }
    } else {
      const project = payload.project?.path_with_namespace || payload.project?.name;
      summary = project ? `${kind} for ${project}` : kind;
      log(`GitLab webhook: ${summary}`);
    }

    this.lastWebhookEvent = {
      timestamp,
      eventType,
      kind,
      summary,
    };
    this.saveState();
  }

  isSenderSelf(event) {
    if (!event) return false;
    const senderOid = extractUserOid(event.fromMri || event.sender?.mri);
    if (this.selfOid && senderOid && senderOid === this.selfOid) {
      return true;
    }
    if (this.selfMri) {
      const rawMri = String(event.fromMri || event.sender?.mri || '').trim().toLowerCase();
      const selfMriNorm = this.selfMri.toLowerCase().trim();
      if (rawMri && rawMri === selfMriNorm) {
        return true;
      }
    }
    return false;
  }

  shouldEditOriginalMessage(entry, targetUrl = null) {
    if (!this.editOwnUrlMessages) return false;
    if (!entry?.isSelf) return false;
    if (!entry?.isOnlyUrl) return false;
    if (targetUrl && entry.targetUrl && !isSameUrl(targetUrl, entry.targetUrl)) {
      return false;
    }
    return true;
  }

  isRecognizedUrl(url) {
    if (!url) return false;
    if (this.gitlab?.findMrLinks && this.gitlab.findMrLinks(url).length > 0) return true;
    if (this.gitlab?.findJobLinks && this.gitlab.findJobLinks(url).length > 0) return true;
    if (this.gitlab?.findPipelineLinks && this.gitlab.findPipelineLinks(url).length > 0) return true;
    if (this.jira?.findIssueLinks && this.jira.findIssueLinks(url).length > 0) return true;
    if (this.confluence?.findPageLinks && this.confluence.findPageLinks(url).length > 0) return true;
    if (this.opsgenie?.findAlertLinks && this.opsgenie.findAlertLinks(url).length > 0) return true;
    if (this.codePreviewEnabled() && this.gitlab?.findBlobLinks && this.gitlab.findBlobLinks(url).length > 0) return true;
    return false;
  }

  /** Whether a message from this sender may trigger a code preview (own messages only by default). */
  codePreviewAllowedFor(isSelf) {
    return Boolean(isSelf) || this.config?.gitlab?.code_preview?.allow_other_senders === true;
  }

  /** Whether GitLab blob links with a line anchor get a code preview (gitlab.code_preview.enable). */
  codePreviewEnabled() {
    return this.config?.gitlab?.code_preview?.enable !== false;
  }

  findUnrecognizedLinks(text, rawHtml = '', links = []) {
    const candidates = extractCandidateUrls(text, rawHtml, links);
    return candidates.filter((u) => !this.isRecognizedUrl(u));
  }

  async maybeAttachLinkThumbnail(event) {
    if (!this.screenshot?.isConfigured?.()) return;
    if (!event.conversationId || !event.messageId) return;
    if (!this.isSenderSelf(event)) return;

    const msgId = String(event.messageId);
    if (this.thumbnailEditedMessageIds.has(msgId)) return;
    if (botSentMessageIds.has(msgId)) return;
    if (event.content?.includes(BOT_WATERMARK) || event.rawHtml?.includes(BOT_WATERMARK)) return;

    const unrecognized = this.findUnrecognizedLinks(event.content, event.rawHtml, event.links);
    if (unrecognized.length === 0) return;

    const targetUrl = unrecognized[0];
    this.thumbnailEditedMessageIds.add(msgId);
    if (this.thumbnailEditedMessageIds.size > 2000) {
      const iter = this.thumbnailEditedMessageIds.values();
      this.thumbnailEditedMessageIds.delete(iter.next().value);
    }
    recordBotMessageId(msgId);

    log.debug(`[thumbnail] Capturing screenshot for unrecognized link ${targetUrl} in message ${msgId}...`);
    const thumbData = await this.screenshot.capture(targetUrl);
    if (!thumbData || (!thumbData.b64 && typeof thumbData !== 'string')) {
      log.warn(`[thumbnail] Failed to capture screenshot for ${targetUrl}`);
      return;
    }

    log.debug(`[thumbnail] Editing message ${msgId} with thumbnail screenshot card...`);
    const result = await appendThumbnailToMessage(
      event.conversationId,
      event.messageId,
      event.content,
      event.rawHtml,
      targetUrl,
      thumbData
    );

    if (result?.ok) {
      log(`[thumbnail] Successfully attached thumbnail to message ${msgId}`);
    } else {
      log(`[thumbnail] Failed to edit message ${msgId}: ${result?.error?.message || result?.error || 'unknown error'}`);
    }
  }

  isOwnMessage(fromMri, text, messageId = null, clientMessageId = null, rawHtml = null) {
    if (messageId && botSentMessageIds.has(String(messageId))) return true;
    if (clientMessageId && botSentMessageIds.has(String(clientMessageId))) return true;

    const t = text || '';
    if (t.includes(BOT_WATERMARK)) return true;
    if (rawHtml && rawHtml.includes(BOT_WATERMARK)) return true;

    if (
      t.startsWith(HEADSUP_PREFIX) ||
      t.includes(CI_PREFIX) ||
      t.includes(CI_JOB_PREFIX) ||
      t.includes(REBASE_PREFIX) ||
      t.includes('Approved ') ||
      t.includes('Approval status:') ||
      t.includes('Cannot approve') ||
      t.includes('already approved') ||
      t.includes('Not approved yet') ||
      t.includes('already merged') ||
      t.includes('already closed') ||
      t.includes('Merged ') ||
      t.includes('human merge request') ||
      t.includes('merge requests approved') ||
      t.includes('by humans found') ||
      t.includes('teams-live slash commands') ||
      t.includes('teams-live status') ||
      t.includes('teams-live started') ||
      t.includes('teams-live shutting down') ||
      t.includes('teams-live sudo') ||
      t.includes('POLO!') ||
      t.includes('was kicked from the conversation') ||
      t.includes('was banned from the conversation') ||
      t.includes('Random Fact') ||
      t.includes('📊') ||
      t.includes('Open Merge Requests') ||
      t.includes('No open merge requests found') ||
      t.includes('Renovate / Bot Updates') ||
      t.includes('No open renovate or bot merge requests found') ||
      t.includes('Bot Interaction Leaderboard') ||
      t.includes('CKS OpsGenie Alerts') ||
      t.includes('All CKS OpsGenie queues are clear!') ||
      t.includes('Current Sprint Tasks') ||
      t.includes('No active sprint tasks found') ||
      t.includes('Meetings for the rest of the week') ||
      t.includes('No upcoming meetings scheduled') ||
      t.includes('command not found') ||
      t.includes('[exec]') ||
      t.includes('dId yOu MeAn') ||
      t.includes('Rebase initiated') ||
      t.includes('Cannot automatically rebase') ||
      t.includes('Rebase required') ||
      t.includes('is now up to date') ||
      t.includes('Unknown command') ||
      t.includes('No merge request found') ||
      t.includes('Status check failed') ||
      t.includes('Weather lookup failed') ||
      t.includes('🌤️') ||
      t.includes('🦊 [') ||
      t.includes('🎫 [') ||
      t.includes('🚨 [Alert') ||
      t.includes('Failed to fetch Jira issue') ||
      t.includes('itemtype="http://schema.skype.com/Reply"')
    ) {
      return true;
    }

    return false;
  }

  watch(
    conversationId,
    messageId,
    text,
    { from = '', fromMri = '', content = null, rawHtml = '', links = [], initialStatus = null, isHistory = false } = {}
  ) {
    const mrLinks = this.gitlab.findMrLinks(text);
    const jobLinks = this.gitlab.findJobLinks(text);
    const pipelineLinks = this.gitlab.findPipelineLinks(text);
    const jiraLinks = this.jira?.findIssueLinks ? this.jira.findIssueLinks(text) : [];
    const opsgenieLinks = this.opsgenie?.findAlertLinks ? this.opsgenie.findAlertLinks(text) : [];
    const confluenceLinks = this.confluence?.findPageLinks ? this.confluence.findPageLinks(text) : [];
    // A code preview reads a repository file with the bot's token and posts it into
    // the chat, so only the authenticated user's own links trigger it (unless
    // gitlab.code_preview.allow_other_senders is set). Unknown identity counts as "not self".
    const isSelf = this.isSenderSelf({ from, fromMri });
    const codeLinks =
      this.codePreviewEnabled() && this.gitlab.findBlobLinks && this.codePreviewAllowedFor(isSelf)
        ? this.gitlab.findBlobLinks(text)
        : [];
    if (
      mrLinks.length === 0 &&
      jobLinks.length === 0 &&
      pipelineLinks.length === 0 &&
      jiraLinks.length === 0 &&
      opsgenieLinks.length === 0 &&
      confluenceLinks.length === 0 &&
      codeLinks.length === 0
    ) {
      return;
    }

    const key = `${conversationId}/${messageId}`;
    const saved = this.savedEntries.get(key);

    const candidateUrls = extractCandidateUrls(content || text, rawHtml, links);
    const isOnlyUrl = isMessageOnlyUrl(content || text, rawHtml, links);
    const targetUrl = isOnlyUrl && candidateUrls.length === 1 ? candidateUrls[0] : null;

    const mrsMap = new Map();
    const initialMrStatus = initialStatus === 'approved' ? 'approved' : null;
    for (const mr of mrLinks) {
      const mrKey = `${mr.project}!${mr.iid}`;
      if (!mrsMap.has(mrKey)) {
        const savedMr = saved?.mrs?.find((m) => m.project === mr.project && String(m.iid) === String(mr.iid));
        mrsMap.set(mrKey, {
          project: mr.project,
          iid: mr.iid,
          title: savedMr?.title ?? mr.title ?? null,
          lastReportedTitle: savedMr?.lastReportedTitle ?? savedMr?.title ?? mr.title ?? null,
          lastReportedDraft: savedMr?.lastReportedDraft ?? null,
          lastReportedJiraKey: savedMr?.lastReportedJiraKey ?? null,
          status: savedMr?.status ?? initialMrStatus,
          lastReportedClosed: savedMr?.lastReportedClosed ?? false,
          ciMessageServerId: savedMr?.ciMessageServerId ?? null,
          lastReportedPipelineId: savedMr?.lastReportedPipelineId ?? null,
          lastReportedPipelineStatus: savedMr?.lastReportedPipelineStatus ?? null,
          lastReportedApprovalStatus: savedMr?.lastReportedApprovalStatus ?? (initialStatus === 'approved'),
          lastReportedApprovedBy: savedMr?.lastReportedApprovedBy ?? null,
          rebaseMessageServerId: savedMr?.rebaseMessageServerId ?? null,
          lastReportedNeedsRebase: savedMr?.lastReportedNeedsRebase ?? null,
          lastReportedAutoMerge: savedMr?.lastReportedAutoMerge ?? null,
          lastReportedAutoMergeUser: savedMr?.lastReportedAutoMergeUser ?? null,
        });
      }
    }

    const jobsMap = new Map();
    for (const j of jobLinks) {
      const jKey = `${j.project}#job-${j.jobId}`;
      if (!jobsMap.has(jKey)) {
        const savedJob = saved?.jobs?.find((sj) => sj.project === j.project && String(sj.jobId) === String(j.jobId));
        jobsMap.set(jKey, {
          project: j.project,
          jobId: j.jobId,
          status: savedJob?.status ?? null,
          duration: savedJob?.duration ?? null,
          ciMessageServerId: savedJob?.ciMessageServerId ?? null,
          lastReportedStatus: savedJob?.lastReportedStatus ?? null,
          mr: savedJob?.mr ?? null,
        });
      }
    }

    const pipelinesMap = new Map();
    for (const p of pipelineLinks) {
      const pKey = `${p.project}#pipeline-${p.pipelineId}`;
      if (!pipelinesMap.has(pKey)) {
        const savedPipe = saved?.pipelines?.find(
          (sp) => sp.project === p.project && String(sp.pipelineId) === String(p.pipelineId)
        );
        pipelinesMap.set(pKey, {
          project: p.project,
          pipelineId: p.pipelineId,
          status: savedPipe?.status ?? null,
          duration: savedPipe?.duration ?? null,
          ciMessageServerId: savedPipe?.ciMessageServerId ?? null,
          lastReportedStatus: savedPipe?.lastReportedStatus ?? null,
          mr: savedPipe?.mr ?? null,
        });
      }
    }

    const jiraMap = new Map();
    for (const j of jiraLinks) {
      const jKey = j.key;
      if (!jiraMap.has(jKey)) {
        const savedJira = saved?.jiraIssues?.find((sj) => sj.key === j.key);
        jiraMap.set(jKey, {
          key: j.key,
          url: j.url,
          summary: savedJira?.summary ?? null,
          status: savedJira?.status ?? null,
          statusCategory: savedJira?.statusCategory ?? null,
          messageServerId: savedJira?.messageServerId ?? null,
        });
      }
    }

    const opsgenieMap = new Map();
    for (const a of opsgenieLinks) {
      const aKey = a.id;
      if (!opsgenieMap.has(aKey)) {
        const savedAlert = saved?.opsgenieAlerts?.find((sa) => sa.id === a.id);
        opsgenieMap.set(aKey, {
          id: a.id,
          url: a.url,
          message: savedAlert?.message ?? null,
          status: savedAlert?.status ?? null,
          acknowledged: savedAlert?.acknowledged ?? null,
          messageServerId: savedAlert?.messageServerId ?? null,
        });
      }
    }

    const confluenceMap = new Map();
    for (const c of confluenceLinks) {
      const cKey = c.key;
      if (!confluenceMap.has(cKey)) {
        const savedDoc = saved?.confluencePages?.find((sc) => sc.key === c.key);
        confluenceMap.set(cKey, {
          key: c.key,
          target: c.target || c.id || c.url,
          url: c.url,
          title: savedDoc?.title ?? null,
          spaceKey: savedDoc?.spaceKey ?? null,
          spaceName: savedDoc?.spaceName ?? null,
          messageServerId: savedDoc?.messageServerId ?? null,
        });
      }
    }

    const codeMap = new Map();
    for (const c of codeLinks) {
      if (codeMap.has(c.key)) continue;
      const savedCode = saved?.codeLinks?.find((sc) => sc.key === c.key);
      codeMap.set(c.key, {
        key: c.key,
        project: c.project,
        refPath: c.refPath,
        startLine: c.startLine,
        endLine: c.endLine,
        url: c.url,
        messageServerId: savedCode?.messageServerId ?? null,
        unavailable: savedCode?.unavailable ?? false,
        attempts: 0,
      });
    }

    this.watched.set(key, {
      conversationId,
      messageId,
      from,
      fromMri,
      content: content || text,
      isSelf: saved?.isSelf ?? isSelf,
      isOnlyUrl: saved?.isOnlyUrl ?? isOnlyUrl,
      targetUrl: saved?.targetUrl ?? targetUrl,
      editedOriginal: saved?.editedOriginal ?? false,
      multiMrMessageServerId: saved?.multiMrMessageServerId ?? null,
      mrs: [...mrsMap.values()],
      jobs: [...jobsMap.values()],
      pipelines: [...pipelinesMap.values()],
      jiraIssues: [...jiraMap.values()],
      opsgenieAlerts: [...opsgenieMap.values()],
      confluencePages: [...confluenceMap.values()],
      codeLinks: [...codeMap.values()],
      status: saved?.status ?? initialStatus,
      isHistory,
      createdAt: saved?.createdAt ?? Date.now(),
    });

    const watchedDesc = [];
    if (mrsMap.size > 0) watchedDesc.push(`MRs: ${[...mrsMap.keys()].join(', ')}`);
    if (jobsMap.size > 0) watchedDesc.push(`Jobs: ${[...jobsMap.keys()].join(', ')}`);
    if (pipelinesMap.size > 0) watchedDesc.push(`Pipelines: ${[...pipelinesMap.keys()].join(', ')}`);
    if (jiraMap.size > 0) watchedDesc.push(`Jira: ${[...jiraMap.keys()].join(', ')}`);
    if (opsgenieMap.size > 0) watchedDesc.push(`OpsGenie: ${[...opsgenieMap.keys()].join(', ')}`);
    if (confluenceMap.size > 0) watchedDesc.push(`Confluence: ${[...confluenceMap.keys()].join(', ')}`);
    if (codeMap.size > 0) watchedDesc.push(`Code: ${[...codeMap.keys()].join(', ')}`);
    log(`watching in ${conversationId}/${messageId}: ${watchedDesc.join('; ')}`);
    this.checkWatchedKey(key).catch((err) => log(`initial check failed for ${key}: ${err.message}`));
  }

  /**
   * Retires a state reaction the bot placed before rich cards were enabled
   * (restored from the saved state, so it is tracked as the bot's). A thumbs up
   * is only forgotten, never removed: it is the approve gesture, so it may be
   * the user's own.
   */
  async retireStateReaction(entry) {
    const key = STATUS_REACTIONS[entry.status];
    if (!key || !this.isBotReaction(entry.messageId, key)) return;
    this.unrecordBotReaction(entry.messageId, key);
    if (key === 'like') return;
    const result = await removeReaction(entry.conversationId, entry.messageId, key);
    if (!result.ok) log(`removing ${entry.status} reaction failed: ${result.error?.message}`);
  }

  /**
   * Removes the pending (eyes) reaction once the original message carries the
   * status itself. With rich cards the bot never places it, so only a tracked
   * leftover is removed.
   */
  async dropPendingReaction(entry) {
    const key = STATUS_REACTIONS.pending;
    if (this.richMessages && !this.isBotReaction(entry.messageId, key)) return;
    await removeReaction(entry.conversationId, entry.messageId, key).catch(() => {});
    this.unrecordBotReaction(entry.messageId, key);
  }

  async setReactionStatus(entry, newStatus) {
    const { conversationId, messageId } = entry;
    // The status stays tracked, but a rich card already shows it: no reaction
    // is added (only an earlier one is retired).
    if (this.richMessages) {
      if (entry.status !== newStatus) await this.retireStateReaction(entry);
      entry.status = newStatus;
      return;
    }
    // When the original message is directly edited, don't place the pending (eyes) reaction
    const skipPending = entry.editedOriginal && newStatus === 'pending';

    if (newStatus && newStatus !== entry.status && !skipPending) {
      if (STATUS_REACTIONS[newStatus]) {
        this.recordBotReaction(messageId, STATUS_REACTIONS[newStatus]);
      }
      const result = await addReaction(conversationId, messageId, STATUS_REACTIONS[newStatus]);
      if (!result.ok) log(`adding ${newStatus} reaction failed: ${result.error?.message}`);
    }

    if (entry.status && entry.status !== newStatus) {
      if (STATUS_REACTIONS[entry.status]) {
        this.unrecordBotReaction(messageId, STATUS_REACTIONS[entry.status]);
      }
      const result = await removeReaction(conversationId, messageId, STATUS_REACTIONS[entry.status]);
      if (!result.ok) log(`removing ${entry.status} reaction failed: ${result.error?.message}`);
    }

    if (skipPending && entry.status === 'pending') {
      if (STATUS_REACTIONS.pending) {
        this.unrecordBotReaction(messageId, STATUS_REACTIONS.pending);
      }
      const result = await removeReaction(conversationId, messageId, STATUS_REACTIONS.pending);
      if (!result.ok) log(`removing pending reaction failed: ${result.error?.message}`);
    }

    entry.status = newStatus;
  }

  isRecentMrMessage(entry, mr, maxLimit = null) {
    if (!mr || !entry) return true;
    const limit = maxLimit ?? this.config.gitlab?.max_mr_messages_to_update ?? 3;
    const projLower = (mr.project || '').toLowerCase();
    const projBase = projLower.split('/').pop();
    const mrIid = String(mr.iid);

    const norm = (id) => {
      try {
        return decodeURIComponent(String(id || ''));
      } catch {
        return String(id || '');
      }
    };
    const targetConv = norm(entry.conversationId);

    const matchingEntries = [];
    for (const item of this.watched.values()) {
      if (norm(item.conversationId) !== targetConv) continue;
      const hasMr = (item.mrs || []).some((m) => {
        if (String(m.iid) !== mrIid) return false;
        const mProj = (m.project || '').toLowerCase();
        return mProj === projLower || mProj.split('/').pop() === projBase;
      });
      if (hasMr) {
        matchingEntries.push(item);
      }
    }

    if (matchingEntries.length <= limit) return true;

    matchingEntries.sort((a, b) => {
      const timeA = a.createdAt || Number(a.messageId) || 0;
      const timeB = b.createdAt || Number(b.messageId) || 0;
      return timeB - timeA;
    });

    const allowed = matchingEntries.slice(0, limit);
    return allowed.some((e) => String(e.messageId) === String(entry.messageId));
  }

  async sendHeadsup(entry, mr) {
    if (!this.config.gitlab.notify?.approval_lost) return;
    if (!this.isRecentMrMessage(entry, mr)) return;
    const mrUrl = this.gitlab.mrLink(mr.project, mr.iid);
    const lines = [];
    if (mr.title) lines.push(`💬 **${mr.title}**`);
    lines.push(`${HEADSUP_PREFIX}${mrUrl} needs a new approval`);
    const msg = lines.map((l) => (l || '').trim()).filter(Boolean).join('\n\n').trim();
    log(`posting heads-up for ${mr.project}!${mr.iid} to ${entry.conversationId}`);
    const result = await sendReply(entry.conversationId, entry, msg);
    if (!result.ok) {
      log(`heads-up reply failed: ${result.error?.message}`);
    }
  }

  /**
   * Returns the markdown message as is, or (with `teams.rich_messages`) wrapped
   * together with its entity-specific Adaptive Card. The markdown stays the
   * fallback.
   *
   * `buildCard(markdown)` may return null (no specific card for this text).
   * In that case, and when the card is over the size limit, the plain markdown
   * is returned and the transport (prepareRichMessages) turns it into generic
   * reply cards, split into several when needed: in rich mode every outward
   * message is a card, so nothing is lost here. Mentions are rendered as names
   * in cards and do not notify anyone.
   */
  richMessage(markdown, buildCard) {
    if (!this.richMessages) return markdown;
    try {
      const card = buildCard(markdown);
      if (!card) return markdown;
      const message = makeRichMessage(markdown, card);
      // Measure what is actually sent: the card with its fallback copy of the markdown, escaped.
      let size = richMessageWireBytes(message);
      if (size > MAX_CARD_BYTES && this.avatarService) {
        // The pictures are the first thing to give up before the card is split.
        log(`Adaptive Card too large (${size} bytes), retrying without profile pictures`);
        this.suppressAvatars = true;
        try {
          const plain = makeRichMessage(markdown, buildCard(markdown));
          size = richMessageWireBytes(plain);
          if (size <= MAX_CARD_BYTES) return plain;
        } finally {
          this.suppressAvatars = false;
        }
      }
      if (size > MAX_CARD_BYTES) {
        log(`Adaptive Card too large (${size} bytes), splitting into several cards`);
        return markdown;
      }
      return message;
    } catch (e) {
      log(`building Adaptive Card failed, using generic card: ${e.message}`);
      return markdown;
    }
  }

  /** Rich message for a command reply, generated from the regular markdown (see buildMarkdownCard). */
  richCommandMessage(markdown, spec) {
    return this.richMessage(markdown, (text) => buildMarkdownCard(text, spec));
  }

  findMrJiraTicket(mrDetails, title) {
    return (
      mrDetails?.jiraTicket ||
      (this.jira?.findAssociatedIssue
        ? this.jira.findAssociatedIssue({
            title,
            description: mrDetails?.description,
            source_branch: mrDetails?.source_branch,
          })
        : null)
    );
  }

  /** Card data for the pipeline of a merge request (live pipeline, else last reported). */
  mrCardPipeline(mr, pipeline, { useLastReported = false } = {}) {
    if (pipeline) {
      return {
        id: pipeline.id,
        status: pipeline.status,
        url: pipeline.web_url || (pipeline.id ? this.gitlab.pipelineLink(mr.project, pipeline.id) : null),
      };
    }
    if (useLastReported && mr.lastReportedPipelineId) {
      return {
        id: mr.lastReportedPipelineId,
        status: mr.lastReportedPipelineStatus,
        url: this.gitlab.pipelineLink(mr.project, mr.lastReportedPipelineId),
      };
    }
    return null;
  }

  /**
   * Approval state for a card: true/false when known, null when it was not
   * retrieved (a failed lookup must not read as "not approved").
   */
  mrCardApproval(mrDetails, { fallbackToLastReported = null } = {}) {
    if (mrDetails?.approvalKnown === false && mrDetails?.status !== 'approved') {
      return fallbackToLastReported;
    }
    if (mrDetails?.approved === true || mrDetails?.status === 'approved') return true;
    if (mrDetails?.approved === false || mrDetails?.status === 'pending') return false;
    return fallbackToLastReported;
  }

  /**
   * Looks up the profile pictures of the people a card shows (cached, bounded
   * and deduplicated, see AvatarService) so the synchronous card builders can
   * embed them. Missing pictures simply mean names only. No-op outside rich mode.
   */
  async prefetchAvatars(data) {
    if (this.botNames.size === 0) await this.refreshBotNames();
    if (!this.avatarService) return;
    try {
      await this.avatarService.avatarsFor(collectCardPeople(data));
    } catch (e) {
      log.warn(`profile picture lookup failed: ${e.message}`);
    }
  }

  /**
   * Where a click on a person's picture goes and what hovering shows, by name: the Teams chat with the person
   * when the directory knows them, else their GitLab profile. The hover text is their name, job title,
   * department, e-mail address and GitLab user name, as far as the directory has them. Nobody the directory does
   * not know (a bot) gets an entry.
   */
  cardProfiles(data) {
    const profiles = {};
    if (!this.userDirectory || this.suppressAvatars) return profiles;
    for (const name of collectCardPeople(data)) {
      let user = null;
      try {
        user = this.userDirectory.findUser(name);
      } catch {
        user = null;
      }
      if (!user) continue;
      const gitlabUser = [...(user.explicitGitlabUsernames || [])][0] || '';
      const url = teamsUserLink(user.mri) || (gitlabUser && this.gitlab?.host ? `https://${this.gitlab.host}/${encodeURIComponent(gitlabUser)}` : '');
      if (!url) continue;
      const lines = [user.displayName || name, user.jobTitle, user.department, user.email, gitlabUser ? `@${gitlabUser}` : ''].filter(Boolean);
      profiles[name] = { url, tooltip: [...new Set(lines)].join('\n') };
    }
    return profiles;
  }

  /** Pictures already fetched for the people in `data` (never starts a request), by name. */
  cardAvatars(data) {
    const avatars = {};
    if (!this.avatarService || this.suppressAvatars) return avatars;
    for (const name of collectCardPeople(data)) {
      avatars[name] = this.avatarService.peekOrPlaceholder(name);
    }
    return avatars;
  }

  // Record the photos available when a status card was rendered. A later poll
  // can then upgrade a placeholder after a lookup exceeded the card deadline.
  mrAvatarSnapshot(mr, details) {
    if (!this.avatarService || this.suppressAvatars) return null;
    return new Map(collectCardPeople(this.mrCardPeopleData(mr, details))
      .map((name) => [name, Boolean(this.avatarService.peek(name))]));
  }

  mrAvatarAvailable(mr, details) {
    if (!mr.cardAvatarSnapshot || !this.avatarService) return false;
    return collectCardPeople(this.mrCardPeopleData(mr, details)).some((name) =>
      mr.cardAvatarSnapshot.has(name) && !mr.cardAvatarSnapshot.get(name) && this.avatarService.peek(name)
    );
  }

  /**
   * The author an MR card shows: this check's, else the one last seen for the
   * merge request (a failed lookup must not drop the row from a refresh).
   */
  mrCardAuthor(mr, mrDetails) {
    const author = String(mrDetails?.author || mr?.author?.name || mr?.author?.username || '').trim();
    if (author && mr) mr.lastAuthor = author;
    return author || (mr?.lastAuthor ?? '');
  }

  /** Fills `botNames` with the names of the GitLab accounts the bot acts as (cached by the client). */
  async refreshBotNames() {
    if (!this.gitlab?.getCurrentUser || !this.gitlab?.tokenIndices) return;
    try {
      const names = new Set();
      for (const index of [0]) {
        const user = await this.gitlab.getCurrentUser({ tokenIndex: index });
        for (const value of [user?.name, user?.username]) if (value) names.add(String(value).toLowerCase());
      }
      if (names.size > 0) this.botNames = names;
    } catch (err) {
      log.debug(`Could not read the bot accounts: ${err.message}`);
    }
  }

  /**
   * The approvers a merge request card shows. When the approval was made by the bot's own account on
   * somebody's behalf (see noteTeamsApproval), that person is shown instead of the bot, marked as
   * approved via the bot. Everything else is unchanged. Returns `{approvedBy, approvedVia}` where
   * `approvedVia` lists the names to mark.
   */
  resolveApprovers(project, iid, approvedBy) {
    const names = Array.isArray(approvedBy) ? approvedBy.filter(Boolean) : [];
    const record = project && iid !== undefined ? this.teamsApprovals.get(`${project}!${iid}`.toLowerCase()) : null;
    if (!record || this.botNames.size === 0) return { approvedBy: names, approvedVia: [] };
    const at = names.findIndex((n) => this.botNames.has(String(n).toLowerCase()));
    if (at < 0) return { approvedBy: names, approvedVia: [] };
    const resolved = names.slice();
    resolved[at] = record.name;
    // The requester may have approved directly as well: keep one entry, marked.
    return { approvedBy: resolved.filter((n, i) => resolved.findIndex((m) => m.toLowerCase() === n.toLowerCase()) === i), approvedVia: [record.name] };
  }

  /** The names an MR card shows people for: the author, approvers (live or last reported) and the auto-merge user. */
  mrCardPeopleData(mr, mrDetails) {
    // The card shows the fresh approvers, and for a merged or closed merge request (whose approvals are
    // not fetched again) the last reported ones: load the pictures of both, so nobody is left without.
    const fresh = Array.isArray(mrDetails?.approvedBy) ? mrDetails.approvedBy : [];
    const lastReported = mr?.lastReportedApprovedBy ? String(mr.lastReportedApprovedBy).split(', ') : [];
    const approvedBy = [...new Set([...fresh, ...lastReported].filter(Boolean))];
    const resolved = this.resolveApprovers(mr?.project, mr?.iid, approvedBy);
    return { author: this.mrCardAuthor(mr, mrDetails), approvedBy: resolved.approvedBy, autoMergeUser: mrDetails?.autoMergeUser };
  }

  /**
   * Builds the merge request card. `state` is open, merged, closed, rebase or
   * rebased. Approval and auto-merge are tri-state (true, false, null for
   * unknown) so the card can tell "disabled" from "not retrieved".
   */
  buildMrCard(mr, mrDetails, { state = 'open', pipeline = null, title = null } = {}) {
    const cardTitle = title || mrDetails?.title || mr.title;
    const jiraTicket = this.findMrJiraTicket(mrDetails, cardTitle);
    let approved = this.mrCardApproval(mrDetails);
    let approvedBy = mrDetails?.approvedBy;
    if (approved === null && (state === 'merged' || state === 'closed') && typeof mr.lastReportedApprovalStatus === 'boolean') {
      // The approvals of a merged or closed merge request are not fetched: use what was last reported.
      approved = mr.lastReportedApprovalStatus;
      approvedBy =
        approved && mr.lastReportedApprovedBy ? String(mr.lastReportedApprovedBy).split(', ') : [];
    }
    // Line totals: this check's, else the last known ones for the same head commit
    // (a failed lookup must not drop them from an in-place refresh).
    let diffStats = mrDetails?.diffStats ?? null;
    if (diffStats) {
      mr.lastDiffStats = { ...diffStats, sha: mrDetails.sha ?? null };
    } else if (mr.lastDiffStats && mr.lastDiffStats.sha === (mrDetails?.sha ?? null)) {
      diffStats = mr.lastDiffStats;
    }
    const resolvedApprovers = this.resolveApprovers(mr.project, mr.iid, approvedBy);
    return buildMergeRequestCard({
      state,
      diffStats,
      approveUrl: this.mrApproveUrl(mr, mrDetails, { state }),
      mergeUrl: this.mrMergeUrl(mr, mrDetails, { state }),
      rebaseUrl: this.mrRebaseUrl(mr, mrDetails, { state }),
      reopenUrl: this.mrReopenUrl(mr, { state }),
      iid: mr.iid,
      project: mr.project,
      title: cardTitle,
      url: mrDetails?.web_url || this.gitlab.mrLink(mr.project, mr.iid),
      targetBranch: mrDetails?.target_branch,
      approved,
      approvedBy: approved === true ? resolvedApprovers.approvedBy : approvedBy,
      approvedVia: approved === true ? resolvedApprovers.approvedVia : [],
      // GitLab's own counts for the pending approval badge (null when it requires none).
      approvalsGiven: mrDetails?.approvalsGiven ?? null,
      approvalsRequired: mrDetails?.approvalsRequired ?? null,
      draft: mrDetails?.draft === true,
      needsRebase: mrDetails?.needsRebase === true,
      hasConflicts: mrDetails?.hasConflicts === true,
      detailedMergeStatus: mrDetails?.detailedMergeStatus,
      autoMerge: typeof mrDetails?.autoMerge === 'boolean' ? mrDetails.autoMerge : null,
      autoMergeUser: mrDetails?.autoMergeUser,
      author: this.mrCardAuthor(mr, mrDetails),
      avatars: this.cardAvatars(this.mrCardPeopleData(mr, mrDetails)),
      profiles: this.cardProfiles(this.mrCardPeopleData(mr, mrDetails)),
      pipeline,
      // "none"/"unknown" only when this card's details are the ones that found no pipeline.
      pipelineKnown:
        typeof mrDetails?.pipelineKnown === 'boolean' && !(mrDetails.pipeline && !pipeline)
          ? mrDetails.pipelineKnown
          : undefined,
      jira: jiraTicket ? { key: jiraTicket.key, url: jiraTicket.url } : null,
    }, { compact: this.config.teams?.compact_cards === true });
  }

  async handleCiStatusComment(entry, mr, pipeline, mrDetails) {
    if (!this.config.gitlab.notify?.ci?.enable) return;

    let icon = getCiStatusEmoji(pipeline?.status);
    let statusText = pipeline?.status || 'unknown';
    let shouldNotify = false;

    if (pipeline?.status === 'success') {
      statusText = 'passed';
      shouldNotify = this.config.gitlab.notify?.ci?.on_success;
    } else if (pipeline?.status === 'failed') {
      statusText = 'failed';
      shouldNotify = this.config.gitlab.notify?.ci?.on_failure;
    } else if (pipeline?.status) {
      shouldNotify = true;
    }

    const isApproved = Boolean(mrDetails?.approved || mrDetails?.status === 'approved');
    if (
      isApproved ||
      mrDetails?.statusReopened ||
      mrDetails?.approvalChanged ||
      mrDetails?.approversChanged ||
      mrDetails?.needsRebase ||
      mrDetails?.rebaseChanged ||
      mrDetails?.autoMerge ||
      mrDetails?.autoMergeChanged ||
      mrDetails?.autoMergeUserChanged ||
      mrDetails?.titleChanged ||
      mrDetails?.draftChanged ||
      mrDetails?.jiraChanged ||
      mrDetails?.avatarChanged ||
      (!entry.isHistory && !mr.ciMessageServerId)
    ) {
      shouldNotify = true;
    }

    if (!shouldNotify) return;

    if (!this.isRecentMrMessage(entry, mr)) {
      log.debug(
        `Skipping CI status comment for older message ${entry.messageId} in ${entry.conversationId} for ${mr.project}!${mr.iid} (only updating last 3 messages)`
      );
      return;
    }

    await this.prefetchAvatars(this.mrCardPeopleData(mr, mrDetails));
    const msg = this.richMessage(this.formatMrStatusMessage(mr, pipeline, mrDetails), () =>
      this.buildMrCard(mr, mrDetails, {
        state: mrDetails?.state === 'closed' || mrDetails?.status === 'closed' ? 'closed' : 'open',
        pipeline: this.mrCardPipeline(mr, pipeline),
      })
    );
    const avatarSnapshot = this.mrAvatarSnapshot(mr, mrDetails);

    const mrUrl = mrDetails?.web_url || this.gitlab.mrLink(mr.project, mr.iid);

    if (this.shouldEditOriginalMessage(entry, mrUrl)) {
      log(`editing original message with status (CI: ${pipeline?.status}, approved: ${isApproved}) for ${mr.project}!${mr.iid}`);
      const editResult = await editOriginalMessage(entry.conversationId, entry.messageId, mrUrl, msg);
      if (editResult.ok) {
        mr.cardAvatarSnapshot = avatarSnapshot;
        entry.editedOriginal = true;
        mr.lastReportedClosed = false;
        await this.dropPendingReaction(entry);
        this.saveState();
        return;
      }
      if (entry.editedOriginal) throw new Error(`updating original message failed: ${editResult.error?.message}`);
      log(`editing original message failed (${editResult.error?.message}), falling back to reply`);
    }

    if (mr.ciMessageServerId) {
      log(`updating status comment (CI: ${pipeline?.status}, approved: ${isApproved}) for ${mr.project}!${mr.iid} (msg ${mr.ciMessageServerId})`);
      const updateResult = await updateReply(entry.conversationId, mr.ciMessageServerId, entry, msg, { preserveCard: true });
      if (updateResult.ok) {
        mr.cardAvatarSnapshot = avatarSnapshot;
        mr.lastReportedClosed = false;
        this.saveState();
        return;
      }
      throw new Error(`updating status comment failed: ${updateResult.error?.message}`);
    }

    log(`posting new status comment (CI: ${pipeline?.status}, approved: ${isApproved}) for ${mr.project}!${mr.iid}`);
    const result = await sendReply(entry.conversationId, entry, msg);
    if (result.ok && (result.value?.timestamp || result.value?.messageId)) {
      mr.cardAvatarSnapshot = avatarSnapshot;
      mr.ciMessageServerId = String(result.value.timestamp || result.value.messageId);
      mr.lastReportedClosed = false;
      this.saveState();
    } else {
      throw new Error(`CI status reply failed or returned no message ID: ${result.error?.message || 'missing ID'}`);
    }
  }

  async handleRebaseComment(entry, mr, mrDetails) {
    if (!this.config.gitlab.notify?.rebase) return;

    const mrRef = `!${mr.iid} (${mr.project})`;
    const mrUrl = mrDetails?.web_url || this.gitlab.mrLink(mr.project, mr.iid);
    const title = mrDetails?.title || mr.title;
    const titleLine = title ? `💬 **${title}**` : '';

    if (mrDetails.needsRebase) {
      if (mr.lastReportedNeedsRebase === true) return; // already reported

      if (entry.editedOriginal && this.shouldEditOriginalMessage(entry, mrUrl)) {
        mr.lastReportedNeedsRebase = true;
        this.saveState();
        return;
      }

      const reason = mrDetails.hasConflicts ? 'merge conflicts' : 'behind target branch';
      const lines = [];
      if (titleLine) {
        lines.push(titleLine);
      }
      lines.push(`⚠️ **Rebase required** for [${mrRef}](${mrUrl})`);
      lines.push(`Branch has ${reason} (status: \`${mrDetails.detailedMergeStatus}\`).`);
      await this.prefetchAvatars(this.mrCardPeopleData(mr, mrDetails));
      const msg = this.richMessage(lines.join('\n\n'), () =>
        this.buildMrCard(mr, mrDetails, {
          state: 'rebase',
          pipeline: this.mrCardPipeline(mr, mrDetails?.pipeline, { useLastReported: true }),
        })
      );

      if (mr.rebaseMessageServerId) {
        log(`updating rebase comment for ${mr.project}!${mr.iid} (msg ${mr.rebaseMessageServerId})`);
        const updateResult = await updateReply(entry.conversationId, mr.rebaseMessageServerId, entry, msg);
        if (updateResult.ok) {
          mr.lastReportedNeedsRebase = true;
          return;
        }
        log(`updating rebase comment failed (${updateResult.error?.message}), falling back to new reply`);
      }

      log(`posting rebase required comment for ${mr.project}!${mr.iid}`);
      const result = await sendReply(entry.conversationId, entry, msg);
      if (result.ok && result.value?.timestamp) {
        mr.rebaseMessageServerId = String(result.value.timestamp);
        this.saveState();
      } else if (!result.ok) {
        log(`rebase reply failed: ${result.error?.message}`);
      }
      mr.lastReportedNeedsRebase = true;
      this.saveState();
    } else if (mr.lastReportedNeedsRebase === true) {
      // Was previously reported needing rebase, now up to date! Update the comment in-place.
      const lines = [];
      if (titleLine) {
        lines.push(titleLine);
      }
      lines.push(`✅ **Rebased** [${mrRef}](${mrUrl}) is now up to date and conflict-free.`);
      await this.prefetchAvatars(this.mrCardPeopleData(mr, mrDetails));
      const msg = this.richMessage(lines.join('\n\n'), () =>
        this.buildMrCard(mr, mrDetails, {
          state: 'rebased',
          pipeline: this.mrCardPipeline(mr, mrDetails?.pipeline, { useLastReported: true }),
        })
      );
      if (mr.rebaseMessageServerId) {
        log(`updating rebase comment to resolved for ${mr.project}!${mr.iid} (msg ${mr.rebaseMessageServerId})`);
        const updateResult = await updateReply(entry.conversationId, mr.rebaseMessageServerId, entry, msg);
        if (!updateResult.ok) {
          log(`updating rebase comment to resolved failed: ${updateResult.error?.message}`);
        }
      }
      mr.lastReportedNeedsRebase = false;
    }
  }

  async handleMergedComment(entry, mr, mrDetails) {
    const notifyMerged = this.config.gitlab.notify?.merged ?? true;
    if (!notifyMerged) return;

    if (!this.isRecentMrMessage(entry, mr)) {
      log.debug(
        `Skipping merged comment for older message ${entry.messageId} in ${entry.conversationId} for ${mr.project}!${mr.iid} (only updating last 3 messages)`
      );
      return;
    }

    let title = mrDetails?.title || mr.title;
    if (!title) {
      try {
        const mrData = await this.gitlab.getMr(mr.project, mr.iid);
        title = mrData?.title || null;
        if (title) mr.title = title;
      } catch {
        // ignore
      }
    }

    const mrRef = `!${mr.iid} (${mr.project})`;
    const mrUrl = mrDetails?.web_url || this.gitlab.mrLink(mr.project, mr.iid);
    const targetBranch = mrDetails?.target_branch ? ` into \`${mrDetails.target_branch}\`` : '';
    const titleLine = title ? `💬 **${title}**` : '';

    const lines = [];
    if (titleLine) {
      lines.push(titleLine);
    }
    lines.push(`🎉 **Merged** [${mrRef}](${mrUrl})${targetBranch}`);

    const jiraTicket =
      mrDetails?.jiraTicket ||
      (this.jira?.findAssociatedIssue
        ? this.jira.findAssociatedIssue({
            title,
            description: mrDetails?.description,
            source_branch: mrDetails?.source_branch,
          })
        : null);
    if (jiraTicket) {
      lines.push(`🎫 [${jiraTicket.key}](${jiraTicket.url})`);
    }

    const pipe = mrDetails?.pipeline;
    const pipeStatus = pipe?.status || mr.lastReportedPipelineStatus;
    const pipeIcon = pipeStatus ? getCiStatusEmoji(pipeStatus) : '🏗️';
    if (pipe) {
      lines.push(`${pipeIcon} [Pipeline #${pipe.id}](${pipe.web_url})`);
    } else if (mr.lastReportedPipelineId) {
      const pipeUrl = this.gitlab.pipelineLink(mr.project, mr.lastReportedPipelineId);
      lines.push(`${pipeIcon} [Pipeline #${mr.lastReportedPipelineId}](${pipeUrl})`);
    }

    await this.prefetchAvatars(this.mrCardPeopleData(mr, mrDetails));
    const msg = this.richMessage(lines.map((l) => (l || '').trim()).filter(Boolean).join('\n\n').trim(), () =>
      this.buildMrCard(mr, { ...mrDetails, jiraTicket }, {
        state: 'merged',
        title,
        pipeline: this.mrCardPipeline(mr, pipe, { useLastReported: true }),
      })
    );

    if (this.shouldEditOriginalMessage(entry, mrUrl)) {
      log(`editing original message to merged for ${mr.project}!${mr.iid}`);
      const editResult = await editOriginalMessage(entry.conversationId, entry.messageId, mrUrl, msg);
      if (editResult.ok) {
        entry.editedOriginal = true;
        mr.lastReportedClosed = false;
        await this.dropPendingReaction(entry);
        this.saveState();
        return;
      }
      log(`editing original message failed (${editResult.error?.message}), falling back to other comment or reply`);
    }

    if (mr.ciMessageServerId) {
      log(`updating CI status comment to merged for ${mr.project}!${mr.iid} (msg ${mr.ciMessageServerId})`);
      const updateResult = await updateReply(entry.conversationId, mr.ciMessageServerId, entry, msg, { preserveCard: true });
      if (updateResult.ok) {
        mr.lastReportedClosed = false;
        this.saveState();
        return;
      }
      throw new Error(`updating merged card failed: ${updateResult.error?.message}`);
    }

    if (mr.rebaseMessageServerId) {
      log(`updating rebase comment to merged for ${mr.project}!${mr.iid} (msg ${mr.rebaseMessageServerId})`);
      const updateResult = await updateReply(entry.conversationId, mr.rebaseMessageServerId, entry, msg);
      if (updateResult.ok) {
        mr.lastReportedClosed = false;
        this.saveState();
        return;
      }
      log(`updating rebase comment to merged failed (${updateResult.error?.message}), falling back to new reply`);
    }

    log(`posting merged comment for ${mr.project}!${mr.iid}`);
    const result = await sendReply(entry.conversationId, entry, msg);
    if (result.ok && (result.value?.timestamp || result.value?.messageId)) {
      mr.ciMessageServerId = String(result.value.timestamp || result.value.messageId);
      mr.lastReportedClosed = false;
      this.saveState();
    }
  }

  async handleClosedComment(entry, mr, mrDetails) {
    const notifyClosed = this.config.gitlab.notify?.closed ?? true;
    if (!notifyClosed) return;

    if (!this.isRecentMrMessage(entry, mr)) {
      log.debug(
        `Skipping closed comment for older message ${entry.messageId} in ${entry.conversationId} for ${mr.project}!${mr.iid} (only updating last 3 messages)`
      );
      return;
    }

    let title = mrDetails?.title || mr.title;
    if (!title) {
      try {
        const mrData = await this.gitlab.getMr(mr.project, mr.iid);
        title = mrData?.title || null;
        if (title) mr.title = title;
      } catch {
        // ignore
      }
    }

    const mrRef = `!${mr.iid} (${mr.project})`;
    const mrUrl = mrDetails?.web_url || this.gitlab.mrLink(mr.project, mr.iid);
    const titleLine = title ? `💬 **${title}**` : '';

    const jiraTicket =
      mrDetails?.jiraTicket ||
      (this.jira?.findAssociatedIssue
        ? this.jira.findAssociatedIssue({
            title,
            description: mrDetails?.description,
            source_branch: mrDetails?.source_branch,
          })
        : null);

    const lines = [];
    lines.push(`🦊 [${mrRef}](${mrUrl})`);
    if (titleLine) {
      lines.push(titleLine);
    }
    if (jiraTicket) {
      lines.push(`🎫 [${jiraTicket.key}](${jiraTicket.url})`);
    }
    lines.push('🚫 **Closed** (unmerged)');

    const pipe = mrDetails?.pipeline;
    const pipeStatus = pipe?.status || mr.lastReportedPipelineStatus;
    const pipeIcon = pipeStatus ? getCiStatusEmoji(pipeStatus) : '🏗️';
    if (pipe) {
      lines.push(`${pipeIcon} [Pipeline #${pipe.id}](${pipe.web_url})`);
    } else if (mr.lastReportedPipelineId) {
      const pipeUrl = this.gitlab.pipelineLink(mr.project, mr.lastReportedPipelineId);
      lines.push(`${pipeIcon} [Pipeline #${mr.lastReportedPipelineId}](${pipeUrl})`);
    }

    await this.prefetchAvatars(this.mrCardPeopleData(mr, mrDetails));
    const msg = this.richMessage(lines.map((l) => (l || '').trim()).filter(Boolean).join('\n\n').trim(), () =>
      this.buildMrCard(mr, { ...mrDetails, jiraTicket }, {
        state: 'closed',
        title,
        pipeline: this.mrCardPipeline(mr, pipe, { useLastReported: true }),
      })
    );

    if (this.shouldEditOriginalMessage(entry, mrUrl)) {
      log(`editing original message to closed for ${mr.project}!${mr.iid}`);
      const editResult = await editOriginalMessage(entry.conversationId, entry.messageId, mrUrl, msg);
      if (editResult.ok) {
        entry.editedOriginal = true;
        mr.lastReportedClosed = true;
        await this.dropPendingReaction(entry);
        this.saveState();
        return;
      }
      log(`editing original message failed (${editResult.error?.message}), falling back to other comment or reply`);
    }

    if (mr.ciMessageServerId) {
      log(`updating CI status comment to closed for ${mr.project}!${mr.iid} (msg ${mr.ciMessageServerId})`);
      const updateResult = await updateReply(entry.conversationId, mr.ciMessageServerId, entry, msg, { preserveCard: true });
      if (updateResult.ok) {
        mr.lastReportedClosed = true;
        this.saveState();
        return;
      }
      throw new Error(`updating closed card failed: ${updateResult.error?.message}`);
    }

    if (mr.rebaseMessageServerId) {
      log(`updating rebase comment to closed for ${mr.project}!${mr.iid} (msg ${mr.rebaseMessageServerId})`);
      const updateResult = await updateReply(entry.conversationId, mr.rebaseMessageServerId, entry, msg);
      if (updateResult.ok) {
        mr.lastReportedClosed = true;
        this.saveState();
        return;
      }
      log(`updating rebase comment to closed failed (${updateResult.error?.message}), falling back to new reply`);
    }

    log(`posting closed comment for ${mr.project}!${mr.iid}`);
    const result = await sendReply(entry.conversationId, entry, msg);
    if (result.ok && (result.value?.timestamp || result.value?.messageId)) {
      mr.ciMessageServerId = String(result.value.timestamp || result.value.messageId);
      mr.lastReportedClosed = true;
      this.saveState();
    }
  }

  formatMrStatusMessage(mr, pipeline, mrDetails) {
    let icon = getCiStatusEmoji(pipeline?.status);
    let statusText = pipeline?.status || 'unknown';

    if (pipeline?.status === 'success') {
      statusText = 'passed';
    } else if (pipeline?.status === 'failed') {
      statusText = 'failed';
    }

    const isApproved = Boolean(mrDetails?.approved || mrDetails?.status === 'approved');
    const mrRef = `!${mr.iid} (${mr.project})`;
    const mrUrl = mrDetails?.web_url || this.gitlab.mrLink(mr.project, mr.iid);
    const title = mrDetails?.title || mr.title;
    const titleLine = title ? `💬 **${title}**` : '';
    const approverNames = (mrDetails?.approvedBy || []).filter(Boolean);

    const jiraTicket =
      mrDetails?.jiraTicket ||
      (this.jira?.findAssociatedIssue
        ? this.jira.findAssociatedIssue({
            title,
            description: mrDetails?.description,
            source_branch: mrDetails?.source_branch,
          })
        : null);

    let approvalLine = '';
    if (isApproved) {
      const byText = approverNames.length > 0 ? ` by ${approverNames.join(', ')}` : '';
      approvalLine = `👍 **Approved**${byText}`;
    } else {
      approvalLine = '⏳ **Not approved yet**';
    }

    const rebaseLine = mrDetails?.needsRebase
      ? (mrDetails.hasConflicts ? '⚠️ **Rebase required** (merge conflicts)' : '⚠️ **Rebase required**')
      : '';

    const autoMergeLine = mrDetails?.autoMerge
      ? `🔀 **Auto-merge enabled**${mrDetails.autoMergeUser ? ` by ${mrDetails.autoMergeUser}` : ''}`
      : '';

    const lines = [];
    lines.push(`🦊 [${mrRef}](${mrUrl})`);
    if (titleLine) {
      lines.push(titleLine);
    }
    if (jiraTicket) {
      lines.push(`🎫 [${jiraTicket.key}](${jiraTicket.url})`);
    }
    if (mrDetails?.state === 'closed' || mrDetails?.status === 'closed') {
      lines.push('🚫 **Closed** (unmerged)');
    }
    if (pipeline) {
      const pipeUrl = pipeline.web_url || (pipeline.id ? this.gitlab.pipelineLink(mr.project, pipeline.id) : null);
      lines.push(
        pipeUrl
          ? `${icon} [${CI_PREFIX}](${pipeUrl}) **${statusText}**`
          : `${icon} ${CI_PREFIX} **${statusText}**`
      );
    }
    lines.push(approvalLine);
    if (rebaseLine) {
      lines.push(rebaseLine);
    }
    if (autoMergeLine) {
      lines.push(autoMergeLine);
    }

    return lines.map((l) => (l || '').trim()).filter(Boolean).join('\n\n').trim();
  }

  formatJobStatusMessage(jobData, project, mr = null) {
    const icon = getCiStatusEmoji(jobData.status);
    const statusText = jobData.status || 'unknown';
    const projectRef = project.split('/').pop() || project;
    const jobUrl = jobData.web_url || this.gitlab.jobLink(project, jobData.id);
    const durationText = jobData.duration ? ` (${formatDuration(jobData.duration)})` : '';
    const refText = jobData.ref ? ` on \`${jobData.ref}\`` : '';
    const stageText = jobData.stage ? ` (${jobData.stage})` : '';

    const lines = [];
    if (mr?.title) lines.push(`💬 **${mr.title}**`);
    lines.push(
      `${icon} CI job **${jobData.name || jobData.id}**${stageText} **${statusText}**${refText} for [Job #${jobData.id} (${projectRef})](${jobUrl})${durationText}`
    );

    if (jobData.status === 'failed' && jobData.failure_reason) {
      lines.push(`**Failure reason**: \`${jobData.failure_reason}\``);
    }

    const pipe = jobData.pipeline;
    const pipeId = pipe?.id || jobData.pipeline_id;
    if (pipeId) {
      const pipeUrl = pipe?.web_url || this.gitlab.pipelineLink(project, pipeId);
      const pipeIcon = pipe?.status ? getCiStatusEmoji(pipe.status) : '🏗️';
      const pipeStatusText = pipe?.status ? ` (${pipe.status})` : '';
      lines.push(`${pipeIcon} [Pipeline #${pipeId}](${pipeUrl})${pipeStatusText}`);
    }

    if (mr) {
      lines.push(`[MR !${mr.iid}](${mr.web_url})`);
    }

    return lines.map((l) => (l || '').trim()).filter(Boolean).join('\n\n').trim();
  }

  formatPipelineStatusMessage(pipeData, project, mr = null) {
    const icon = getCiStatusEmoji(pipeData.status);
    const statusText = pipeData.status || 'unknown';
    const projectRef = project.split('/').pop() || project;
    const pipeUrl = pipeData.web_url || this.gitlab.pipelineLink(project, pipeData.id);
    const durationText = pipeData.duration ? ` (${formatDuration(pipeData.duration)})` : '';
    const refText = pipeData.ref ? ` on \`${pipeData.ref}\`` : '';

    const lines = [];
    if (mr?.title) lines.push(`💬 **${mr.title}**`);
    lines.push(
      `${icon} CI pipeline **${statusText}**${refText} for [Pipeline #${pipeData.id} (${projectRef})](${pipeUrl})${durationText}`
    );

    if (pipeData.yaml_errors) {
      lines.push(`**YAML errors**: ${pipeData.yaml_errors}`);
    }

    if (mr) {
      lines.push(`[MR !${mr.iid}](${mr.web_url})`);
    }

    return lines.map((l) => (l || '').trim()).filter(Boolean).join('\n\n').trim();
  }

  buildJobCardFromData(jobData, project, mr = null) {
    const pipe = jobData.pipeline;
    const pipeId = pipe?.id || jobData.pipeline_id;
    return buildJobCard({
      id: jobData.id,
      name: jobData.name,
      project: project.split('/').pop() || project,
      status: jobData.status,
      stage: jobData.stage,
      ref: jobData.ref,
      duration: jobData.duration ? formatDuration(jobData.duration) : '',
      failureReason: jobData.failure_reason,
      url: jobData.web_url || this.gitlab.jobLink(project, jobData.id),
      pipeline: pipeId
        ? {
            id: pipeId,
            status: pipe?.status,
            url: pipe?.web_url || this.gitlab.pipelineLink(project, pipeId),
          }
        : null,
      mr: mr ? { iid: mr.iid, title: mr.title, url: mr.web_url } : null,
    });
  }

  buildPipelineCardFromData(pipeData, project, mr = null) {
    return buildPipelineCard({
      id: pipeData.id,
      project: project.split('/').pop() || project,
      status: pipeData.status,
      ref: pipeData.ref,
      duration: pipeData.duration ? formatDuration(pipeData.duration) : '',
      yamlErrors: pipeData.yaml_errors,
      url: pipeData.web_url || this.gitlab.pipelineLink(project, pipeData.id),
      mr: mr ? { iid: mr.iid, title: mr.title, url: mr.web_url } : null,
    });
  }

  async handleJobStatusComment(entry, job, jobData) {
    if (!job.mr) {
      job.mr = await this.gitlab.getMrForJob(job.project, jobData).catch(() => null);
    }
    const msg = this.richMessage(this.formatJobStatusMessage(jobData, job.project, job.mr), () =>
      this.buildJobCardFromData(jobData, job.project, job.mr)
    );
    const jobUrl = jobData?.web_url || (job.project && job.jobId ? this.gitlab.jobLink?.(job.project, job.jobId) : null);

    if (this.shouldEditOriginalMessage(entry, jobUrl)) {
      log(`editing original message with job status (${jobData.status}) for ${job.project}#job-${job.jobId}`);
      const editResult = await editOriginalMessage(entry.conversationId, entry.messageId, jobUrl, msg);
      if (editResult.ok) {
        entry.editedOriginal = true;
        await this.dropPendingReaction(entry);
        this.saveState();
        return;
      }
      log(`editing original message failed (${editResult.error?.message}), falling back to reply`);
    }

    if (job.ciMessageServerId) {
      log(
        `updating job status comment (status: ${jobData.status}) for ${job.project}#job-${job.jobId} (msg ${job.ciMessageServerId})`
      );
      const updateResult = await updateReply(entry.conversationId, job.ciMessageServerId, entry, msg);
      if (updateResult.ok) return;
      log(`updating job status comment failed (${updateResult.error?.message}), falling back to new reply`);
    }

    log(`posting new job status comment (status: ${jobData.status}) for ${job.project}#job-${job.jobId}`);
    const result = await sendReply(entry.conversationId, entry, msg);
    if (result.ok && result.value?.timestamp) {
      job.ciMessageServerId = String(result.value.timestamp);
      this.saveState();
    } else if (!result.ok) {
      log(`job status reply failed: ${result.error?.message}`);
    }
  }

  async handlePipelineStatusComment(entry, pipe, pipeData) {
    if (!pipe.mr) {
      pipe.mr = await this.gitlab.getMrForPipeline(pipe.project, pipeData).catch(() => null);
    }
    const msg = this.richMessage(this.formatPipelineStatusMessage(pipeData, pipe.project, pipe.mr), () =>
      this.buildPipelineCardFromData(pipeData, pipe.project, pipe.mr)
    );
    const pipeUrl = pipeData?.web_url || (pipe.project && pipe.pipelineId ? this.gitlab.pipelineLink?.(pipe.project, pipe.pipelineId) : null);

    if (this.shouldEditOriginalMessage(entry, pipeUrl)) {
      log(`editing original message with pipeline status (${pipeData.status}) for ${pipe.project}#pipeline-${pipe.pipelineId}`);
      const editResult = await editOriginalMessage(entry.conversationId, entry.messageId, pipeUrl, msg);
      if (editResult.ok) {
        entry.editedOriginal = true;
        await this.dropPendingReaction(entry);
        this.saveState();
        return;
      }
      log(`editing original message failed (${editResult.error?.message}), falling back to reply`);
    }

    if (pipe.ciMessageServerId) {
      log(
        `updating pipeline status comment (status: ${pipeData.status}) for ${pipe.project}#pipeline-${pipe.pipelineId} (msg ${pipe.ciMessageServerId})`
      );
      const updateResult = await updateReply(entry.conversationId, pipe.ciMessageServerId, entry, msg);
      if (updateResult.ok) return;
      log(`updating pipeline status comment failed (${updateResult.error?.message}), falling back to new reply`);
    }

    log(`posting new pipeline status comment (status: ${pipeData.status}) for ${pipe.project}#pipeline-${pipe.pipelineId}`);
    const result = await sendReply(entry.conversationId, entry, msg);
    if (result.ok && result.value?.timestamp) {
      pipe.ciMessageServerId = String(result.value.timestamp);
      this.saveState();
    } else if (!result.ok) {
      log(`pipeline status reply failed: ${result.error?.message}`);
    }
  }

  formatJiraIssueMessage(issue) {
    const typeIcons = {
      bug: '🐛',
      story: '📖',
      task: '📋',
      subtask: '📄',
      spike: '⚡',
      epic: '🏔️',
      improvement: '💡',
    };
    const tLower = (issue.issueType || '').toLowerCase();
    const typeIcon = typeIcons[tLower] || '📋';

    const sCategory = (issue.statusCategory || '').toLowerCase();
    const sName = (issue.status || '').toLowerCase();
    let statusIcon = '⚪';
    if (sCategory === 'done' || sName === 'done' || sName === 'closed' || sName === 'resolved') {
      statusIcon = '🟢';
    } else if (sName.includes('review')) {
      statusIcon = '🟣';
    } else if (sCategory === 'indeterminate' || sName.includes('progress') || sName.includes('active')) {
      statusIcon = '🟡';
    }

    const pLower = (issue.priority || '').toLowerCase();
    let priorityIcon = '🟡';
    if (pLower.includes('high') || pLower.includes('blocker') || pLower.includes('critical')) {
      priorityIcon = '🔴';
    } else if (pLower.includes('low') || pLower.includes('trivial')) {
      priorityIcon = '🟢';
    }

    const lines = [
      `💬 **${escapeHtml(issue.summary)}**`,
      `🎫 [${issue.key}](${issue.url}) • ${typeIcon} ${issue.issueType || 'Task'}`,
      `${statusIcon} **${issue.status}** • Priority: ${priorityIcon} ${issue.priority || 'None'}`,
      `👤 Assignee: ${issue.assignee || 'Unassigned'}`,
    ];

    return lines.map((l) => (l || '').trim()).filter(Boolean).join('\n\n').trim();
  }

  opsGenieOwnerText(alert) {
    if (alert.owner) {
      return humanizeRecipient(alert.owner);
    }
    if (Array.isArray(alert.responders) && alert.responders.length > 0) {
      return alert.responders.map((r) => r.name || r.username || r.id).filter(Boolean).join(', ') || 'Unassigned';
    }
    return 'Unassigned';
  }

  formatOpsGenieAlertMessage(alert) {
    const pIcons = {
      P1: '🚨',
      P2: '🔥',
      P3: '⚠️',
      P4: 'ℹ️',
      P5: '🔹',
    };
    const pIcon = pIcons[alert.priority] || '⚠️';

    const isClosed = alert.status === 'closed';
    const sIcon = isClosed ? '⚪' : '🟢';
    const ackText = alert.acknowledged ? 'acknowledged' : 'unacknowledged';

    const ownerText = this.opsGenieOwnerText(alert);

    const label = alert.tinyId ? `Alert #${alert.tinyId}` : `Alert ${alert.id.slice(0, 8)}`;

    const lines = [
      `💬 **${escapeHtml(alert.message)}**`,
      `🚨 [${label}](${alert.url})`,
      `${pIcon} **${alert.priority || 'P3'}** • ${sIcon} **${alert.status || 'open'}** (${ackText})`,
      `👤 Owner: ${ownerText}`,
    ];

    return lines.map((l) => (l || '').trim()).filter(Boolean).join('\n\n').trim();
  }

  async handleJiraIssueComment(entry, issue, issueData) {
    await this.prefetchAvatars(issueData);
    const msg = this.richMessage(this.formatJiraIssueMessage(issueData), () =>
      buildJiraIssueCard({ ...issueData, avatars: this.cardAvatars(issueData), profiles: this.cardProfiles(issueData) })
    );
    const issueUrl = issueData?.url || issue?.url;

    if (this.shouldEditOriginalMessage(entry, issueUrl)) {
      log(`editing original message with Jira issue for ${issue.key}`);
      const editResult = await editOriginalMessage(entry.conversationId, entry.messageId, issueUrl, msg);
      if (editResult.ok) {
        entry.editedOriginal = true;
        await this.dropPendingReaction(entry);
        this.saveState();
        return;
      }
      log(`editing original message failed (${editResult.error?.message}), falling back to reply`);
    }

    if (issue.messageServerId) {
      log(`updating Jira issue comment for ${issue.key} (msg ${issue.messageServerId})`);
      const updateResult = await updateReply(entry.conversationId, issue.messageServerId, entry, msg);
      if (updateResult.ok) return;
      log(`updating Jira issue comment failed (${updateResult.error?.message}), falling back to new reply`);
    }

    log(`posting Jira issue comment for ${issue.key}`);
    const result = await sendReply(entry.conversationId, entry, msg);
    if (result.ok && result.value?.timestamp) {
      issue.messageServerId = String(result.value.timestamp);
      this.saveState();
    } else if (!result.ok) {
      log(`Jira issue reply failed: ${result.error?.message}`);
    }
  }

  async handleOpsGenieAlertComment(entry, alert, alertData) {
    const alertCard = { ...alertData, owner: this.opsGenieOwnerText(alertData) };
    await this.prefetchAvatars(alertCard);
    const msg = this.richMessage(this.formatOpsGenieAlertMessage(alertData), () =>
      buildOpsGenieAlertCard({ ...alertCard, avatars: this.cardAvatars(alertCard), profiles: this.cardProfiles(alertCard) })
    );
    const alertUrl = alertData?.url || alert?.url;

    if (this.shouldEditOriginalMessage(entry, alertUrl)) {
      log(`editing original message with OpsGenie alert for ${alert.id}`);
      const editResult = await editOriginalMessage(entry.conversationId, entry.messageId, alertUrl, msg);
      if (editResult.ok) {
        entry.editedOriginal = true;
        await this.dropPendingReaction(entry);
        this.saveState();
        return;
      }
      log(`editing original message failed (${editResult.error?.message}), falling back to reply`);
    }

    if (alert.messageServerId) {
      log(`updating OpsGenie alert comment for ${alert.id} (msg ${alert.messageServerId})`);
      const updateResult = await updateReply(entry.conversationId, alert.messageServerId, entry, msg);
      if (updateResult.ok) return;
      log(`updating OpsGenie alert comment failed (${updateResult.error?.message}), falling back to new reply`);
    }

    log(`posting OpsGenie alert comment for ${alert.id}`);
    const result = await sendReply(entry.conversationId, entry, msg);
    if (result.ok && result.value?.timestamp) {
      alert.messageServerId = String(result.value.timestamp);
      this.saveState();
    } else if (!result.ok) {
      log(`OpsGenie alert reply failed: ${result.error?.message}`);
    }
  }

  formatConfluencePageMessage(page) {
    const spaceInfo = page.spaceName
      ? `${page.spaceName} (${page.spaceKey})`
      : (page.spaceKey || '');
    const spacePart = spaceInfo ? ` • 📚 **${escapeHtml(spaceInfo)}**` : '';
    const authorPart = page.author ? `\n\n👤 Last edited by: ${escapeHtml(page.author)}` : '';
    const pageUrl = page.url || '';
    const linkText = `[${escapeHtml(page.title)}](${pageUrl})`;

    return `📄 **${escapeHtml(page.title)}**\n\n🔗 ${linkText}${spacePart}${authorPart}`.trim();
  }

  async handleConfluencePageComment(entry, doc, pageData) {
    const msg = this.richMessage(this.formatConfluencePageMessage(pageData), () =>
      buildConfluencePageCard(pageData)
    );
    const pageUrl = pageData?.url || doc?.url;

    if (this.shouldEditOriginalMessage(entry, pageUrl)) {
      log(`editing original message with Confluence page for ${doc.key}`);
      const editResult = await editOriginalMessage(entry.conversationId, entry.messageId, pageUrl, msg);
      if (editResult.ok) {
        entry.editedOriginal = true;
        await this.dropPendingReaction(entry);
        this.saveState();
        return;
      }
      log(`editing original message failed (${editResult.error?.message}), falling back to reply`);
    }

    if (doc.messageServerId) {
      log(`updating Confluence page comment for ${doc.key} (msg ${doc.messageServerId})`);
      const updateResult = await updateReply(entry.conversationId, doc.messageServerId, entry, msg);
      if (updateResult.ok) return;
      log(`updating Confluence page comment failed (${updateResult.error?.message}), falling back to new reply`);
    }

    log(`posting Confluence page comment for ${doc.key}`);
    const result = await sendReply(entry.conversationId, entry, msg);
    if (result.ok && result.value?.timestamp) {
      doc.messageServerId = String(result.value.timestamp);
      this.saveState();
    } else if (!result.ok) {
      log(`Confluence page reply failed: ${result.error?.message}`);
    }
  }

  formatCodePreviewMessage(preview) {
    return formatCodePreviewMarkdown(preview);
  }

  async handleCodePreviewComment(entry, link, preview) {
    const msg = this.richMessage(this.formatCodePreviewMessage(preview), () => buildCodePreviewCard(preview));

    if (this.shouldEditOriginalMessage(entry, link.url)) {
      log(`editing original message with code preview for ${link.key}`);
      const editResult = await editOriginalMessage(entry.conversationId, entry.messageId, link.url, msg);
      if (editResult.ok) {
        entry.editedOriginal = true;
        link.messageServerId = link.messageServerId || 'edited';
        await this.dropPendingReaction(entry);
        this.saveState();
        return;
      }
      log(`editing original message failed (${editResult.error?.message}), falling back to reply`);
    }

    if (link.messageServerId && link.messageServerId !== 'edited') {
      log(`updating code preview comment for ${link.key} (msg ${link.messageServerId})`);
      const updateResult = await updateReply(entry.conversationId, link.messageServerId, entry, msg);
      if (updateResult.ok) return;
      log(`updating code preview comment failed (${updateResult.error?.message}), falling back to new reply`);
    }

    log(`posting code preview comment for ${link.key}`);
    const result = await sendReply(entry.conversationId, entry, msg);
    if (result.ok && result.value?.timestamp) {
      link.messageServerId = String(result.value.timestamp);
      this.saveState();
    } else if (!result.ok) {
      log(`code preview reply failed: ${result.error?.message}`);
    }
  }

  async checkWatchedKey(key) {
    // Webhooks, polling and the initial check can overlap for the same message.
    // Queue each check so it sees the message ID and state saved by the previous one.
    this.watchedChecks ??= new Map();
    const previous = this.watchedChecks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.checkWatchedKeyOnce(key));
    this.watchedChecks.set(key, current);
    try {
      return await current;
    } finally {
      if (this.watchedChecks.get(key) === current) this.watchedChecks.delete(key);
    }
  }

  async checkWatchedKeyOnce(key) {
    const entry = this.watched.get(key);
    if (!entry) return;

    if (Date.now() - (entry.createdAt || 0) > this.maxWatchDurationMs) {
      log(`Watch duration for ${key} exceeded ${this.maxWatchDurationMs / 1000}s, unwatching`);
      this.completedMessages.add(String(entry.messageId));
      this.watched.delete(key);
      this.saveState();
      return;
    }

    try {
      const statuses = [];
      const updatedMrs = [];
      const seenProjects = new Set();
      // Existing individual replies continue using their original lifecycle.
      const multiMr = this.richMessages && this.config.gitlab.notify?.ci?.enable && (entry.mrs || []).length > 1 &&
        (entry.multiMrMessageServerId || (!entry.isHistory && entry.mrs.every((mr) => !mr.ciMessageServerId)));
      const multiRows = [];

      for (const mr of (entry.mrs || [])) {
        let mrState = null;
        try {
          mrState = await this.gitlab.getMrStatus(mr.project, mr.iid);
        } catch (err) {
          if (err.message && err.message.includes('404')) {
            try {
              const resolved = await this.gitlab.resolveProjectPath(mr.project);
              if (resolved && resolved !== mr.project) {
                log.debug(`Resolved project ${mr.project} -> ${resolved} for MR !${mr.iid}`);
                mr.project = resolved;
                const key = `${mr.project}!${mr.iid}`.toLowerCase();
                if (seenProjects.has(key)) {
                  continue;
                }
                mrState = await this.gitlab.getMrStatus(mr.project, mr.iid);
              }
            } catch (resolveErr) {
              log(`Failed resolving 404 project ${mr.project} for MR !${mr.iid}: ${resolveErr.message}`);
            }
          }

          if (!mrState) {
            log(`Error checking MR ${mr.project}!${mr.iid} for ${key}: ${err.message}`);
            const basename = mr.project.split('/').pop().toLowerCase();
            const hasBetter = (entry.mrs || []).some(
              (other) => other !== mr && other.project.split('/').pop().toLowerCase() === basename && String(other.iid) === String(mr.iid)
            );
            if (hasBetter) {
              continue;
            }
            mr.status = 'closed';
            statuses.push('closed');
            updatedMrs.push(mr);
            continue;
          }
        }

        const projectKey = `${mr.project}!${mr.iid}`.toLowerCase();
        if (seenProjects.has(projectKey)) {
          continue;
        }
        seenProjects.add(projectKey);
        updatedMrs.push(mr);

        if (multiMr) {
          await this.prefetchAvatars(this.mrCardPeopleData(mr, mrState));
          const state = mrState.status === 'merged' ? 'merged' : mrState.status === 'closed' ? 'closed' : 'open';
          const people = this.mrCardPeopleData(mr, mrState);
          const approvers = mrState.approvalKnown === false
            ? (mr.lastReportedApprovedBy ? mr.lastReportedApprovedBy.split(', ') : [])
            : (mrState.approvedBy || []);
          const resolved = this.resolveApprovers(mr.project, mr.iid, approvers);
          multiRows.push({
            iid: mr.iid, project: mr.project, title: mrState.title || mr.title,
            url: mrState.web_url || this.gitlab.mrLink(mr.project, mr.iid), state,
            author: people.author, avatars: this.cardAvatars(people), profiles: this.cardProfiles(people),
            approved: this.mrCardApproval(mrState), approvedBy: resolved.approvedBy, approvedVia: resolved.approvedVia,
            approvalsGiven: mrState.approvalsGiven, approvalsRequired: mrState.approvalsRequired,
            draft: mrState.draft === true, pipeline: this.mrCardPipeline(mr, mrState.pipeline),
            autoMerge: mrState.autoMerge, sha: mrState.sha, needsRebase: mrState.needsRebase,
            hasConflicts: mrState.hasConflicts, jira: this.findMrJiraTicket(mrState, mrState.title || mr.title),
            mergeable: mrState.detailedMergeStatus === 'mergeable',
          });
        }

        const currentTitle = mrState.title || mr.title;
        const isDraft = Boolean(
          mrState.draft ?? (currentTitle?.startsWith('Draft:') || currentTitle?.startsWith('WIP:'))
        );
        const titleChanged = Boolean(currentTitle && mr.lastReportedTitle && mr.lastReportedTitle !== currentTitle);
        const draftChanged =
          mr.lastReportedDraft !== null &&
          mr.lastReportedDraft !== undefined &&
          mr.lastReportedDraft !== isDraft;

        const jiraTicket = this.jira?.findAssociatedIssue
          ? this.jira.findAssociatedIssue({
              title: currentTitle,
              description: mrState.description,
              source_branch: mrState.source_branch,
            })
          : null;
        const currentJiraKey = jiraTicket?.key || null;
        const jiraChanged = mr.lastReportedJiraKey !== currentJiraKey;

        if (mrState.title && mr.title !== mrState.title) {
          mr.title = mrState.title;
        }

        statuses.push(mrState.status);

        // An approval lookup that failed is unknown, not "not approved": it
        // must neither trigger the heads-up nor count as a change.
        const approvalUnknown = mrState.approvalKnown === false && mrState.status === 'pending';

        // Heads-up: was approved, but now pending
        if (mr.status === 'approved' && mrState.status === 'pending' && !approvalUnknown) {
          await this.sendHeadsup(entry, mr);
        }

        // CI Pipeline, Approval status, & Rebase check (with in-place update)
        const pipe = mrState.pipeline;
        const pipelineChanged =
          pipe && (mr.lastReportedPipelineId !== pipe.id || mr.lastReportedPipelineStatus !== pipe.status);
        const isApproved = approvalUnknown
          ? (mr.lastReportedApprovalStatus ?? null)
          : Boolean(mrState.approved || mrState.status === 'approved');
        const approvalChanged = mr.lastReportedApprovalStatus !== isApproved;
        const approversKey = approvalUnknown
          ? (mr.lastReportedApprovedBy ?? null)
          : (mrState.approvedBy || []).filter(Boolean).slice().sort().join(', ');
        const approversChanged = mr.lastReportedApprovedBy !== approversKey;
        const avatarChanged = this.isRecentMrMessage(entry, mr) && this.mrAvatarAvailable(mr, mrState);
        const needsRebase = Boolean(mrState.needsRebase);
        const rebaseChanged = mr.lastReportedNeedsRebase !== needsRebase;
        const isAutoMerge =
          typeof mrState.autoMerge === 'boolean' ? mrState.autoMerge : (mr.lastReportedAutoMerge ?? null);
        const autoMergeChanged = mr.lastReportedAutoMerge !== isAutoMerge;
        const autoMergeUser = mrState.autoMergeUser || null;
        const autoMergeUserChanged = mr.lastReportedAutoMergeUser !== autoMergeUser;
        const statusReopened = Boolean(
          (mr.status === 'closed' || mr.lastReportedClosed) && mrState.status !== 'closed'
        );
        const needsInitialComment = !entry.isHistory && !mr.ciMessageServerId;

        if (
          mrState.status !== 'merged' &&
          (pipelineChanged ||
            approvalChanged ||
            approversChanged ||
            avatarChanged ||
            rebaseChanged ||
            autoMergeChanged ||
            autoMergeUserChanged ||
            titleChanged ||
            draftChanged ||
            jiraChanged ||
            statusReopened ||
            needsInitialComment)
        ) {
          if (
            !entry.isHistory ||
            mr.lastReportedPipelineStatus !== null ||
            mr.lastReportedApprovalStatus !== null ||
            mr.lastReportedNeedsRebase !== null ||
            mr.lastReportedAutoMerge !== null ||
            mr.lastReportedTitle !== null ||
            mr.lastReportedJiraKey !== null ||
            statusReopened
          ) {
            if (!multiMr) await this.handleCiStatusComment(entry, mr, pipe, {
              ...mrState,
              approvalChanged,
              approversChanged,
              avatarChanged,
              rebaseChanged,
              autoMergeChanged,
              autoMergeUserChanged,
              titleChanged,
              draftChanged,
              jiraChanged,
              jiraTicket,
              statusReopened,
            });
          }
          if (pipe) {
            mr.lastReportedPipelineId = pipe.id;
            mr.lastReportedPipelineStatus = pipe.status;
          }
          mr.lastReportedApprovalStatus = isApproved;
          mr.lastReportedApprovedBy = approversKey;
          mr.lastReportedNeedsRebase = needsRebase;
          mr.lastReportedAutoMerge = isAutoMerge;
          mr.lastReportedAutoMergeUser = autoMergeUser;
          if (currentTitle) {
            mr.lastReportedTitle = currentTitle;
          }
          mr.lastReportedDraft = isDraft;
          mr.lastReportedJiraKey = currentJiraKey;
        }

        // Merged status check (with in-place update)
        if (mrState.status === 'merged' && mr.status !== 'merged') {
          if (!multiMr && (!entry.isHistory || mr.status !== null)) {
            await this.handleMergedComment(entry, mr, {
              ...mrState,
              jiraTicket,
            });
          }
        }

        // Closed status check (with in-place update)
        if (mrState.status === 'closed' && mr.status !== 'closed') {
          if (!multiMr && (!entry.isHistory || mr.status !== null)) {
            await this.handleClosedComment(entry, mr, {
              ...mrState,
              jiraTicket,
            });
          }
        }

        mr.status = approvalUnknown && mr.status ? mr.status : mrState.status;
      }

      if (updatedMrs.length !== (entry.mrs || []).length) {
        entry.mrs = updatedMrs;
        this.saveState();
      }

      if (multiMr && multiRows.length === updatedMrs.length && multiRows.length > 1) {
        const markdown = multiRows.map((mr) => {
          const facts = [mr.state, mr.author && `author: ${mr.author}`,
            mr.approved === null ? 'approval unknown' : mr.approved ? 'approved' : 'not approved',
            mr.approvedBy.length && `approvers: ${mr.approvedBy.join(', ')}`,
            mr.pipeline?.status && `pipeline: ${mr.pipeline.status}`,
            typeof mr.autoMerge === 'boolean' && `auto-merge: ${mr.autoMerge ? 'on' : 'off'}`,
            mr.needsRebase && (mr.hasConflicts ? 'rebase required (conflicts)' : 'rebase required'),
            mr.jira?.key && `ticket: ${mr.jira.key}`].filter(Boolean).join(' · ');
          return `- [!${mr.iid} ${mr.title}](${mr.url}) · ${facts}`;
        }).join('\n');
        const eligible = multiRows.filter((mr) => mr.state === 'open' && !mr.draft && mr.sha);
        const approveUrl = eligible.length && this.approveFlow?.batchLinkFor
          ? this.approveFlow.batchLinkFor(eligible, 'approve') : null;
        const openUrl = this.approveFlow?.batchLinkFor ? this.approveFlow.batchLinkFor(multiRows, 'open') : null;
        const mergeUrl = this.batchMergeUrl(multiRows);
        const message = this.richMessage(markdown, () => buildMultiMrCard(multiRows.map((row) => ({
          ...row, avatars: this.suppressAvatars ? {} : row.avatars,
        })), { fallbackText: markdown, approveUrl, mergeUrl, openUrl, images: !this.suppressAvatars }));
        const fingerprint = JSON.stringify(message);
        if (fingerprint !== entry.multiMrFingerprint) {
          const result = entry.multiMrMessageServerId
            ? await updateReply(entry.conversationId, entry.multiMrMessageServerId, entry, message, { preserveCard: true })
            : await sendReply(entry.conversationId, entry, message);
          if (!result.ok) throw new Error(`updating multi-MR card failed: ${result.error?.message || 'unknown error'}`);
          if (!entry.multiMrMessageServerId) {
            const id = result.value?.timestamp || result.value?.messageId;
            if (!id) throw new Error('multi-MR card returned no message ID');
            entry.multiMrMessageServerId = String(id);
          }
          entry.multiMrFingerprint = fingerprint;
          this.saveState();
        }
      }

      // Check watched jobs
      for (const job of (entry.jobs || [])) {
        try {
          const jobData = await this.gitlab.getJob(job.project, job.jobId);
          if (!jobData) continue;
          const currentStatus = jobData.status;

          const statusChanged = job.lastReportedStatus !== currentStatus;
          const durationChanged = (job.duration || 0) !== (jobData.duration || 0);

          if (statusChanged || (currentStatus === 'running' && durationChanged) || !job.ciMessageServerId) {
            if (!entry.isHistory || job.lastReportedStatus !== null || !isTerminalCiStatus(currentStatus)) {
              await this.handleJobStatusComment(entry, job, jobData);
            }
            job.lastReportedStatus = currentStatus;
            job.duration = jobData.duration;
          }

          job.status = currentStatus;
        } catch (jobErr) {
          log(`Error checking job ${job.project}#job-${job.jobId} for ${key}: ${jobErr.message}`);
        }
      }

      // Check watched pipelines
      for (const pipe of (entry.pipelines || [])) {
        try {
          const pipeData = await this.gitlab.getPipeline(pipe.project, pipe.pipelineId);
          if (!pipeData) continue;
          const currentStatus = pipeData.status;

          const statusChanged = pipe.lastReportedStatus !== currentStatus;
          const durationChanged = (pipe.duration || 0) !== (pipeData.duration || 0);

          if (statusChanged || (currentStatus === 'running' && durationChanged) || !pipe.ciMessageServerId) {
            if (!entry.isHistory || pipe.lastReportedStatus !== null || !isTerminalCiStatus(currentStatus)) {
              await this.handlePipelineStatusComment(entry, pipe, pipeData);
            }
            pipe.lastReportedStatus = currentStatus;
            pipe.duration = pipeData.duration;
          }

          pipe.status = currentStatus;
        } catch (pipeErr) {
          log(`Error checking pipeline ${pipe.project}#pipeline-${pipe.pipelineId} for ${key}: ${pipeErr.message}`);
        }
      }

      // Check watched Jira issues
      for (const issue of (entry.jiraIssues || [])) {
        const denialKey = `${key}|${issue.key}`;
        try {
          if (!this.jira?.isConfigured()) continue;
          // An issue we may not read (or that is gone) is retried with a growing delay, not every poll.
          if (this.isJiraIssueDenied(denialKey)) continue;
          const issueData = await this.jira.getIssue(issue.key);
          if (this.jiraIssueDenials.delete(denialKey)) {
            log(`Jira issue ${issue.key} is accessible again (watched on ${key})`);
          }
          if (!issueData) continue;

          const statusChanged = issue.status !== issueData.status;
          const summaryChanged = issue.summary !== issueData.summary;
          const needsInitialComment = !entry.isHistory && !issue.messageServerId;

          if (statusChanged || summaryChanged || needsInitialComment) {
            await this.handleJiraIssueComment(entry, issue, issueData);
            issue.status = issueData.status;
            issue.statusCategory = issueData.statusCategory;
            issue.summary = issueData.summary;
          }
        } catch (jiraErr) {
          if (jiraErr?.isIssueAccessError) {
            // Permission or not-found for this one issue: not an authentication problem.
            const delayMs = this.recordJiraIssueDenial(denialKey);
            log(`Jira issue ${issue.key} (watched on ${key}) is not accessible (HTTP ${jiraErr.status}); next check in ${Math.round(delayMs / 60_000)} min`);
          } else {
            log(`Error checking Jira issue ${issue.key} for ${key}: ${jiraErr.message}`);
          }
        }
      }

      // Check watched OpsGenie alerts
      for (const alert of (entry.opsgenieAlerts || [])) {
        try {
          if (!this.opsgenie?.isConfigured()) continue;
          const alertData = await this.opsgenie.getAlert(alert.id);
          if (!alertData) continue;

          const statusChanged = alert.status !== alertData.status;
          const ackChanged = alert.acknowledged !== alertData.acknowledged;
          const needsInitialComment = !entry.isHistory && !alert.messageServerId;

          if (statusChanged || ackChanged || needsInitialComment) {
            await this.handleOpsGenieAlertComment(entry, alert, alertData);
            alert.status = alertData.status;
            alert.acknowledged = alertData.acknowledged;
            alert.message = alertData.message;
          }
        } catch (ogErr) {
          log(`Error checking OpsGenie alert ${alert.id} for ${key}: ${ogErr.message}`);
        }
      }

      // Check watched Confluence pages
      for (const doc of (entry.confluencePages || [])) {
        try {
          if (!this.confluence?.isConfigured()) continue;
          const needsInitialComment = !entry.isHistory && !doc.messageServerId;
          if (!needsInitialComment && doc.title) continue;

          const pageData = await this.confluence.getPage(doc.target);
          if (!pageData) continue;

          const titleChanged = doc.title !== pageData.title;
          if (titleChanged || needsInitialComment) {
            await this.handleConfluencePageComment(entry, doc, pageData);
            doc.title = pageData.title;
            doc.spaceKey = pageData.spaceKey;
            doc.spaceName = pageData.spaceName;
            if (pageData.url) doc.url = pageData.url;
          }
        } catch (confErr) {
          log(`Error checking Confluence page ${doc.key} for ${key}: ${confErr.message}`);
        }
      }

      // Check GitLab code links: one preview per link, posted once. The file is not
      // watched afterwards (a permalink is what people share); a link that has
      // nothing to show (outside the group, secrets, binary, missing) is dropped.
      for (const link of (entry.codeLinks || [])) {
        if (link.messageServerId || link.unavailable) continue;
        // Defense in depth for restored state: never read a file for someone else's message.
        if (!this.codePreviewAllowedFor(entry.isSelf)) {
          link.unavailable = true;
          continue;
        }
        link.attempts = (link.attempts || 0) + 1;
        try {
          let unavailableReason = null;
          const preview = await this.gitlab.getBlobPreview(link, {
            maxLines: this.config?.gitlab?.code_preview?.max_lines ?? 30,
            restrictToGroup: this.config?.gitlab?.code_preview?.restrict_to_group === true,
            onUnavailable: (reason) => {
              unavailableReason = reason;
            },
          });
          if (!preview) {
            link.unavailable = true;
            log.warn(`no code preview for ${link.key}${unavailableReason ? `: ${unavailableReason}` : ''}`);
            continue;
          }
          await this.handleCodePreviewComment(entry, link, preview);
        } catch (codeErr) {
          log(`Error building code preview ${link.key} for ${key}: ${codeErr.message}`);
          // A persistent failure must not keep the entry (and the retries) alive forever.
          if (link.attempts >= 3) link.unavailable = true;
        }
      }

      entry.isHistory = false;

      // Overall status:
      let overallStatus = null;
      const anyCiFailed = (entry.mrs || []).some(
        (m) => m.lastReportedPipelineStatus === 'failed' && m.status !== 'merged' && m.status !== 'closed'
      );
      const anyJobFailed = (entry.jobs || []).some((j) => j.status === 'failed');
      const anyPipeFailed = (entry.pipelines || []).some((p) => p.status === 'failed');

      if ((entry.mrs || []).length > 0) {
        if (statuses.length > 0 && statuses.every((s) => s === 'merged')) {
          overallStatus = 'merged';
        } else if (statuses.length > 0 && statuses.every((s) => s === 'closed')) {
          overallStatus = 'closed';
        } else if (anyCiFailed || anyJobFailed || anyPipeFailed) {
          overallStatus = 'failed';
        } else if (statuses.includes('approved')) {
          overallStatus = 'approved';
        } else if (statuses.includes('pending')) {
          overallStatus = 'pending';
        }
      } else {
        if (anyJobFailed || anyPipeFailed) {
          overallStatus = 'failed';
        } else {
          const hasJobsOrPipes = (entry.jobs || []).length > 0 || (entry.pipelines || []).length > 0;
          const allJobsSuccess = (entry.jobs || []).every((j) => j.status === 'success');
          const allPipesSuccess = (entry.pipelines || []).every((p) => p.status === 'success');
          if (hasJobsOrPipes && allJobsSuccess && allPipesSuccess) {
            overallStatus = 'merged';
          }
        }
      }

      if (overallStatus !== entry.status) {
        await this.setReactionStatus(entry, overallStatus);
        log(`${key} status updated -> ${overallStatus ?? 'cleared'}`);
      }

      const mrsDone = (entry.mrs || []).length === 0 || statuses.every((s) => s === 'merged');
      const jobsDone = (entry.jobs || []).length === 0 || (entry.jobs || []).every((j) => isTerminalCiStatus(j.status));
      const pipesDone = (entry.pipelines || []).length === 0 || (entry.pipelines || []).every((p) => isTerminalCiStatus(p.status));
      const jiraDone =
        (entry.jiraIssues || []).length === 0 ||
        (entry.jiraIssues || []).every(
          (j) =>
            j.messageServerId &&
            (j.statusCategory === 'done' || ['done', 'closed', 'resolved'].includes((j.status || '').toLowerCase()))
        );
      const opsgenieDone =
        (entry.opsgenieAlerts || []).length === 0 ||
        (entry.opsgenieAlerts || []).every((a) => a.messageServerId && a.status === 'closed');
      const confluenceDone =
        (entry.confluencePages || []).length === 0 ||
        (entry.confluencePages || []).every((c) => c.messageServerId && c.title);

      const codeDone = (entry.codeLinks || []).every((c) => c.messageServerId || c.unavailable);

      if (mrsDone && jobsDone && pipesDone && jiraDone && opsgenieDone && confluenceDone && codeDone) {
        log(`All watched items (MRs, jobs, pipelines, Jira, OpsGenie, Confluence, code) completed for ${key}, unwatching`);
        this.completedMessages.add(String(entry.messageId));
        this.watched.delete(key);
        this.saveState();
      } else {
        this.saveState();
      }
    } catch (err) {
      log(`Error checking watched items for ${key}: ${err.message}`);
    }
  }

  async checkAllWatched() {
    for (const key of this.watched.keys()) {
      await this.checkWatchedKey(key);
    }
  }

  isMrWatched(conversationId, project, iid, messageId = null) {
    const norm = (id) => {
      try {
        return decodeURIComponent(String(id || ''));
      } catch {
        return String(id || '');
      }
    };
    const targetConv = norm(conversationId);
    const projLower = (project || '').toLowerCase();
    const projBase = projLower.split('/').pop();

    const matchesMr = (m) => {
      if (String(m.iid) !== String(iid)) return false;
      const mProj = (m.project || '').toLowerCase();
      return mProj === projLower || mProj.split('/').pop() === projBase;
    };

    if (messageId) {
      const key = `${conversationId}/${messageId}`;
      const entry = this.watched.get(key);
      if (entry && (entry.mrs || []).some(matchesMr)) {
        return true;
      }
    }

    for (const entry of this.watched.values()) {
      if (norm(entry.conversationId) === targetConv) {
        if ((entry.mrs || []).some(matchesMr)) {
          return true;
        }
      }
    }
    return false;
  }

  isSlashCommand(text) {
    if (!text) return false;
    const trimmed = text.trim();
    return trimmed.startsWith('/') && !trimmed.startsWith('//');
  }

  parseSlashCommand(text) {
    if (!text) return null;
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return null;

    const parts = trimmed.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);
    return { command, args, fullText: trimmed };
  }

  async setCommandReaction(conversationId, messageId, reactionKey) {
    if (!conversationId || !messageId) {
      log.warn(`Cannot set command reaction: missing conversationId (${conversationId}) or messageId (${messageId})`);
      return;
    }
    try {
      if (reactionKey !== COMMAND_REACTIONS.pending) {
        try {
          await removeReaction(conversationId, messageId, COMMAND_REACTIONS.pending);
        } catch {}
      }
      const res = await addReaction(conversationId, messageId, reactionKey);
      if (res && !res.ok) {
        log.warn(`Failed to set reaction ${reactionKey} on ${messageId} in ${conversationId}: ${res.error?.message || JSON.stringify(res.error)}`);
      } else {
        log.debug(`Set reaction ${reactionKey} on ${messageId} in ${conversationId}`);
      }
      return res;
    } catch (err) {
      log(`Failed to set reaction ${reactionKey} on ${messageId} in ${conversationId}: ${err.message}`);
    }
  }

  /** The merge requests a watched message stands for (its card, CI or rebase reply) in a conversation; [] when none. */
  watchedMrsOfMessage(conversationId, messageId) {
    const id = String(messageId || '');
    if (!id) return [];
    for (const entry of this.watched.values()) {
      if (entry.conversationId !== conversationId || !Array.isArray(entry.mrs)) continue;
      const hit =
        String(entry.messageId) === id ||
        entry.mrs.some((m) => String(m.ciMessageServerId) === id || String(m.rebaseMessageServerId) === id);
      if (hit) return entry.mrs.filter((m) => m.project && m.iid).map((m) => ({ project: m.project, iid: m.iid, title: m.title }));
    }
    return [];
  }

  async findTargetMrsForCommand(event, args) {
    // 1. Direct MR links in the command arguments (e.g. "/approve https://..."):
    const directText = stripTruncatedUrlText(args.join(' '), event);
    const directLinks = deduplicateMrs(this.gitlab.findMrLinks(directText));
    if (directLinks.length > 0) {
      directLinks.source = 'args';
      directLinks.isDirectReply = false;
      return directLinks;
    }

    // 2. Direct MR links in the command message itself (or HTML quote block):
    const quoteSearch = buildMessageSearchText({ rawHtml: event.rawHtml, links: event.links }, { includeQuotes: true });
    const htmlLinks = deduplicateMrs(this.gitlab.findMrLinks(quoteSearch, { allowQuotes: true }));
    if (htmlLinks.length > 0) {
      htmlLinks.source = 'quote';
      const quoteMatch = (event.rawHtml || '').match(/itemid=["']?(\d+)["']?/i);
      htmlLinks.sourceMessageId = quoteMatch ? quoteMatch[1] : null;
      htmlLinks.isDirectReply = args.length === 0 && htmlLinks.length === 1;
      return htmlLinks;
    }

    // 2b. A quote of a watched merge request message (its card has no link in the quoted text).
    const quotedId = (event.rawHtml || '').match(/itemid=["']?(\d+)["']?/i)?.[1];
    const quotedMrs = quotedId ? deduplicateMrs(this.watchedMrsOfMessage(event.conversationId, quotedId)) : [];
    if (quotedMrs.length > 0) {
      quotedMrs.source = 'quote';
      quotedMrs.sourceMessageId = quotedId;
      quotedMrs.isDirectReply = args.length === 0 && quotedMrs.length === 1;
      return quotedMrs;
    }

    // 3. Fallback: Search conversation history for the most recent message from another user with an MR link
    try {
      const thread = await (this.threadMessages || getThreadMessages)(event.conversationId, { limit: 15 });
      if (thread.ok && Array.isArray(thread.value?.messages)) {
        const msgs = [...thread.value.messages].sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
        let interveningHumanMessages = 0;
        for (const msg of msgs) {
          if (String(msg.id) === String(event.messageId)) continue;
          // A watched merge request message (the posted link, edited into its card, or a CI or rebase
          // reply) is the bot's own, but it IS the merge request the command is about. Without this the
          // search skips the card just above the command and lands on an older merge request.
          const watchedMrs = this.watchedMrsOfMessage(event.conversationId, msg.id);
          if (watchedMrs.length > 0) {
            const links = deduplicateMrs(watchedMrs);
            links.source = 'preceding';
            links.sourceMessageId = String(msg.id);
            links.interveningHumanMessages = interveningHumanMessages;
            links.isDirectReply = args.length === 0 && links.length === 1 && interveningHumanMessages === 0;
            return links;
          }
          if (botSentMessageIds.has(String(msg.id))) continue;
          const senderMri = msg.sender?.mri?.split('/contacts/').pop();
          if (this.isOwnMessage(senderMri, msg.content, msg.id, msg.clientMessageId, msg.content)) continue;

          const msgText = buildMessageSearchText({ content: msg.content, links: msg.links }, { includeQuotes: true });
          const links = deduplicateMrs(this.gitlab.findMrLinks(msgText, { allowQuotes: true }));
          if (links.length > 0) {
            log.debug(`Found target MR in preceding message ${msg.id}: ${links.map((l) => `${l.project}!${l.iid}`).join(', ')}`);
            links.source = 'preceding';
            links.sourceMessageId = String(msg.id);
            links.interveningHumanMessages = interveningHumanMessages;
            links.isDirectReply = args.length === 0 && links.length === 1 && interveningHumanMessages === 0;
            return links;
          }
          interveningHumanMessages++;
        }
      }
    } catch (err) {
      log(`Error looking up recent messages for slash command: ${err.message}`);
    }

    return [];
  }

  /**
   * Who asked for an approval from Teams: their name, MRI and, when it is certain, GitLab username
   * (the configured mapping, else one exact-name match in GitLab). The usernames the directory derives
   * from names are guesses and never used: a wrong mention would notify a stranger.
   */
  async approvalRequester({ name = '', mri = '' } = {}) {
    const user = (mri && this.userDirectory.findUser(mri)) || (name && this.userDirectory.findUser(name)) || null;
    let gitlabUser = user ? [...(user.explicitGitlabUsernames || [])][0] : null;
    if (!gitlabUser && typeof this.gitlab?.findUsernameByName === 'function') {
      gitlabUser = await this.gitlab.findUsernameByName(name || user?.displayName).catch(() => '');
    }
    return { name: name || user?.displayName || '', mri: mri || user?.mri || '', gitlabUser: gitlabUser || '' };
  }

  /**
   * Leaves a comment on the merge request saying who approved (or revoked) from Teams and what
   * triggered it, with links to the person and the Teams message (see approval-note.mjs). Always
   * sent; best effort in that it never fails the approval.
   */
  async noteTeamsApproval(project, iid, { name, mri, via, conversationId, messageId, action = 'approved' }) {
    // Remember who asked, so the MR card can show them (with the bot mark) instead of the bot.
    const key = `${project}!${iid}`.toLowerCase();
    if (action === 'revoked') this.teamsApprovals.delete(key);
    else if (name) this.teamsApprovals.set(key, { name: String(name), mri: String(mri || ''), at: Date.now() });
    this.saveState();
    if (!this.gitlab?.addMrNote) return;
    try {
      const requester = await this.approvalRequester({ name, mri });
      await this.gitlab.addMrNote(project, iid, buildApprovalNote({ action, requester, trigger: via, message: { conversationId, messageId } }));
    } catch (err) {
      log.warn(`Could not comment the approver on ${project}!${iid}: ${err.message}`);
    }
  }

  /** Resolve an explicitly configured Teams identity to its GitLab credential. */
  async gitlabActor(mri) {
    const oid = extractUserOid(mri);
    const matches = (this.config.gitlab?.user_token_mappings || []).filter((mapping) => {
      const mappedOid = extractUserOid(mapping.teams_mri);
      return oid && mappedOid && oid.toLowerCase() === mappedOid.toLowerCase();
    });
    if (matches.length > 1) throw new Error('Multiple GitLab credentials are configured for this Teams user');
    const tokenIndex = matches[0]?.token_index ?? 0;
    if (!this.gitlab?.getCurrentUser) return { tokenIndex };
    const user = await this.gitlab.getCurrentUser({ tokenIndex });
    if (!user?.id) throw new Error('The selected GitLab account is unavailable');
    if (matches.length && String(user.username || '').toLowerCase() !== matches[0].gitlab_username.toLowerCase()) {
      throw new Error('The selected GitLab credential does not match the configured account');
    }
    return { tokenIndex, expectUserId: user.id };
  }

  /** Withdraws the bot's approval of the target MR and says on the MR who asked for it from Teams. */
  async executeUnapproveCommand(event, args, command = '/unapprove') {
    log(`Executing ${command} from ${event.from || event.fromMri} in ${event.conversationId}...`);
    const allMrs = await this.findTargetMrsForCommand(event, args);
    const mr = allMrs[0];
    if (!mr) {
      await sendReply(
        event.conversationId,
        event,
        `❌ No merge request found. Quote a message containing an MR or send \`${command}\` immediately following it.`
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }
    const mrRef = `!${mr.iid} (${mr.project})`;
    const mrUrl = this.gitlab.mrLink(mr.project, mr.iid);
    try {
      const mrState = await this.gitlab.getMrStatus(mr.project, mr.iid);
      const title = mrState?.title || mr.title;
      const titleLine = title ? `\n\n💬 **${title}**` : '';
      if (mrState.status === 'merged' || mrState.status === 'closed') {
        await sendReply(event.conversationId, event, `ℹ️ [${mrRef}](${mrUrl})${titleLine} is already ${mrState.status}.`);
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
        return;
      }
      const actor = await this.gitlabActor(event.fromMri || event.sender?.mri);
      const own = await this.gitlab.getUserApprovalState(mr.project, mr.iid, actor).catch(() => ({ known: false }));
      if (own.known && !own.hasApproved) {
        const others = mrState.approved || mrState.status === 'approved';
        await sendReply(
          event.conversationId,
          event,
          `ℹ️ [${mrRef}](${mrUrl})${titleLine} has no approval of mine to withdraw${others ? ' (it is approved by other people, which I cannot revoke)' : ''}.`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
        return;
      }
      log(`Revoking approval of ${mr.project}!${mr.iid} via GitLab API...`);
      await this.gitlab.unapproveMr(mr.project, mr.iid, actor);
      if (actor.tokenIndex === 0) await this.noteTeamsApproval(mr.project, mr.iid, {
        name: event.from,
        mri: event.fromMri,
        via: command,
        conversationId: event.conversationId,
        messageId: event.messageId,
        action: 'revoked',
      });
      await sendReply(event.conversationId, event, `↩️ Approval withdrawn from [${mrRef}](${mrUrl})${titleLine}`);
      await this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success);
      this.checkAllWatched().catch((err) => log(`Post-unapproval check failed: ${err.message}`));
    } catch (err) {
      log(`Error revoking approval of ${mr.project}!${mr.iid}: ${err.message}`);
      await sendReply(event.conversationId, event, `❌ Could not withdraw the approval of [${mrRef}](${mrUrl}): ${err.message}`);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    }
  }

  async executeApproveCommand(event, args) {
    if (args.length > 0 && args[0].toLowerCase() === 'all') {
      return await this.executeApproveAllCommand(event, args.slice(1));
    }

    log(`Executing /approve command from ${event.from || event.fromMri} in ${event.conversationId}...`);
    const allMrs = await this.findTargetMrsForCommand(event, args);
    const mrs = allMrs.slice(0, 1);
    if (mrs.length === 0) {
      await sendReply(
        event.conversationId,
        event,
        '❌ No merge request found to approve. Quote a message containing an MR or send `/approve` immediately following it.'
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    const mr = mrs[0];
    const mrRef = `!${mr.iid} (${mr.project})`;
    const mrUrl = this.gitlab.mrLink(mr.project, mr.iid);

    try {
      const mrState = await this.gitlab.getMrStatus(mr.project, mr.iid);
      const title = mrState?.title || mr.title;
      const titleLine = title ? `\n\n💬 **${title}**` : '';
      const pipe = mrState.pipeline;

      // Precondition 1: Already approved?
      if (mrState.status === 'approved' || mrState.approved) {
        await sendReply(
          event.conversationId,
          event,
          `ℹ️ [${mrRef}](${mrUrl})${titleLine} is already approved.`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
        return;
      }

      // Precondition 2: Already merged or closed?
      if (mrState.status === 'merged' || mrState.status === 'closed') {
        await sendReply(
          event.conversationId,
          event,
          `ℹ️ [${mrRef}](${mrUrl})${titleLine} is already ${mrState.status}.`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
        return;
      }

      // Action: Approve MR via GitLab API
      log(`Approving ${mr.project}!${mr.iid} via GitLab API...`);
      const actor = await this.gitlabActor(event.fromMri || event.sender?.mri);
      await this.gitlab.approveMr(mr.project, mr.iid, actor);
      log(`Approved ${mr.project}!${mr.iid} successfully`);
      if (actor.tokenIndex === 0) await this.noteTeamsApproval(mr.project, mr.iid, { name: event.from, mri: event.fromMri, via: '/approve', conversationId: event.conversationId, messageId: event.messageId });

      const isSimpleDirectReply = Boolean(
        allMrs.isDirectReply &&
        this.isMrWatched(event.conversationId, mr.project, mr.iid, allMrs.sourceMessageId)
      );

      if (!isSimpleDirectReply) {
        const notes = [];
        if (pipe && pipe.status !== 'success') {
          notes.push(`CI pipeline is ${pipe.status}`);
        } else if (!pipe) {
          notes.push('no CI pipeline');
        }
        if (mrState.needsRebase || mrState.hasConflicts) {
          notes.push(mrState.hasConflicts ? 'merge conflicts' : 'needs rebase');
        }
        const noteText = notes.length > 0 ? ` _(${notes.join(', ')})_` : '';
        await sendReply(
          event.conversationId,
          event,
          `✅ Approved [${mrRef}](${mrUrl})${titleLine}${noteText}`
        );
      } else {
        log.debug(`Skipping 'Approved' reply for ${mr.project}!${mr.iid} in ${event.conversationId} because it is a direct response to a watched MR message`);
      }
      await this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success);

      // Trigger immediate status check of watched entries so reactions update
      this.checkAllWatched().catch((err) => log(`Post-approval check failed: ${err.message}`));
    } catch (err) {
      log(`Error approving ${mr.project}!${mr.iid}: ${err.message}`);
      const titleLine = mr.title ? `\n\n💬 **${mr.title}**` : '';
      await sendReply(
        event.conversationId,
        event,
        `❌ Approval failed for [${mrRef}](${mrUrl})${titleLine}: ${err.message}`
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    }
  }

  async executeApproveAllCommand(event, _args) {
    const group = this.gitlab.group || 'kubernetes';
    log(`Executing /approve all from ${event.from || event.fromMri} for group ${group} in ${event.conversationId}...`);
    this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.pending).catch(() => {});

    try {
      const groupMrs = await this.gitlab.getGroupMrs(group);

      if (!groupMrs || groupMrs.length === 0) {
        await sendReply(
          event.conversationId,
          event,
          `ℹ️ No open merge requests found in GitLab group \`${group}\`.`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
        return;
      }

      const humanMrs = groupMrs.filter((mr) => !isBotMr(mr) && !mr.draft && !mr.work_in_progress);

      if (humanMrs.length === 0) {
        await sendReply(
          event.conversationId,
          event,
          `ℹ️ No open merge requests by humans found in group \`${group}\` (found ${groupMrs.length} bot/draft MRs).`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
        return;
      }

      const approved = [];
      const skipped = [];

      for (const mr of humanMrs) {
        const links = this.gitlab.findMrLinks(mr.web_url);
        const project = links[0]?.project || mr.project_id;
        const iid = links[0]?.iid || mr.iid;
        const mrRef = `!${iid} (${project})`;
        const mrUrl = mr.web_url || this.gitlab.mrLink(project, iid);

        try {
          const mrState = await this.gitlab.getMrStatus(project, iid);

          if (mrState.state === 'merged' || mrState.state === 'closed') {
            skipped.push({ mrRef, mrUrl, reason: `already ${mrState.state}` });
            continue;
          }

          if (mrState.approved || mrState.status === 'approved') {
            skipped.push({ mrRef, mrUrl, reason: 'already approved' });
            continue;
          }

          if (mrState.needsRebase || mrState.hasConflicts) {
            skipped.push({ mrRef, mrUrl, reason: mrState.hasConflicts ? 'merge conflicts' : 'needs rebase' });
            continue;
          }

          const pipe = mrState.pipeline;
          if (pipe && pipe.status !== 'success') {
            skipped.push({ mrRef, mrUrl, reason: `pipeline is ${pipe.status}` });
            continue;
          }

          log(`Approving ${project}!${iid} as part of /approve all...`);
          const actor = await this.gitlabActor(event.fromMri || event.sender?.mri);
          await this.gitlab.approveMr(project, iid, actor);
          log(`Approved ${project}!${iid}`);
          if (actor.tokenIndex === 0) await this.noteTeamsApproval(project, iid, { name: event.from, mri: event.fromMri, via: '/approve all', conversationId: event.conversationId, messageId: event.messageId });
          approved.push({
            mrRef,
            mrUrl,
            title: mr.title,
            author: mr.author?.username || mr.author?.name || 'unknown',
            pipelineNote: pipe ? 'green pipeline' : 'no pipeline',
          });
        } catch (err) {
          log(`Failed to inspect/approve ${project}!${iid}: ${err.message}`);
          skipped.push({ mrRef, mrUrl, reason: err.message });
        }
      }

      let replyText = '';
      if (approved.length > 0) {
        replyText =
          `✅ **Approved ${approved.length} human merge request${approved.length > 1 ? 's' : ''}** in \`${group}\`:\n\n` +
          approved.map((a) => `- [${a.mrRef}](${a.mrUrl}): ${a.title} (${this.userDirectory.formatMention(a.author)}) _(${a.pipelineNote})_`).join('\n');
        if (skipped.length > 0) {
          replyText +=
            `\n\n_Skipped ${skipped.length} other human MR${skipped.length > 1 ? 's' : ''}: ` +
            skipped.map((s) => `[${s.mrRef}](${s.mrUrl}) (${s.reason})`).join(', ') +
            '_';
        }
      } else {
        replyText =
          `ℹ️ No merge requests approved in \`${group}\` (inspected ${humanMrs.length} human MR${humanMrs.length > 1 ? 's' : ''}`;
        if (skipped.length > 0) {
          replyText += `: ${skipped.map((s) => `[${s.mrRef}](${s.mrUrl}) - ${s.reason}`).join(', ')}`;
        }
        replyText += ').';
      }

      await sendReply(event.conversationId, event, replyText);
      this.setCommandReaction(
        event.conversationId,
        event.messageId,
        approved.length > 0 ? COMMAND_REACTIONS.success : COMMAND_REACTIONS.failure
      ).catch(() => {});

      if (approved.length > 0) {
        this.checkAllWatched().catch((err) => log(`Post-approve-all check failed: ${err.message}`));
      }
    } catch (err) {
      log(`Error executing /approve all: ${err.message}`);
      await sendReply(
        event.conversationId,
        event,
        `❌ Error executing \`/approve all\`: ${err.message}`
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    }
  }

  async executeMergeCommand(event, args) {
    log(`Executing /merge command from ${event.from || event.fromMri} in ${event.conversationId}...`);
    const allMrs = await this.findTargetMrsForCommand(event, args);
    const mrs = allMrs.slice(0, 1);
    if (mrs.length === 0) {
      await sendReply(
        event.conversationId,
        event,
        '❌ No merge request found to merge. Quote a message containing an MR or send `/merge` immediately following it.'
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    const mr = mrs[0];
    const mrRef = `!${mr.iid} (${mr.project})`;
    const mrUrl = this.gitlab.mrLink(mr.project, mr.iid);

    try {
      const mrState = await this.gitlab.getMrStatus(mr.project, mr.iid);
      const title = mrState?.title || mr.title;
      const titleLine = title ? `\n\n💬 **${title}**` : '';
      const jiraTicket = this.jira?.findAssociatedIssue ? this.jira.findAssociatedIssue(mrState) : null;
      const jiraLine = jiraTicket ? `\n\n🎫 [${jiraTicket.key}](${jiraTicket.url})` : '';

      // Precondition 1: Already merged?
      if (mrState.status === 'merged') {
        await sendReply(
          event.conversationId,
          event,
          `ℹ️ [${mrRef}](${mrUrl})${titleLine}${jiraLine}\n\nis already merged.`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
        return;
      }

      // Precondition 2: Closed?
      if (mrState.status === 'closed') {
        await sendReply(
          event.conversationId,
          event,
          `❌ Cannot merge [${mrRef}](${mrUrl})${titleLine}${jiraLine}\n\nMR is closed.`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
        return;
      }

      // Precondition 3: Draft / WIP?
      if (mrState.draft) {
        await sendReply(
          event.conversationId,
          event,
          `⚠️ Cannot merge [${mrRef}](${mrUrl})${titleLine}${jiraLine}\n\nMR is marked as Draft/WIP. Undraft it before merging.`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.warning).catch(() => {});
        return;
      }

      // Precondition 4: Conflicts / needs rebase?
      if (mrState.hasConflicts || mrState.detailedMergeStatus === 'conflict') {
        await sendReply(
          event.conversationId,
          event,
          `💥 Cannot merge [${mrRef}](${mrUrl})${titleLine}${jiraLine}\n\nBranch has merge conflicts.`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
        return;
      }

      if (mrState.needsRebase || mrState.detailedMergeStatus === 'need_rebase') {
        await sendReply(
          event.conversationId,
          event,
          `⚠️ Cannot merge [${mrRef}](${mrUrl})${titleLine}${jiraLine}\n\nBranch needs to be rebased (\`${mrState.detailedMergeStatus || 'need_rebase'}\`).`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.warning).catch(() => {});
        return;
      }

      // Precondition 5: CI check (if failed)
      const pipe = mrState.pipeline;
      if (pipe && pipe.status === 'failed') {
        await sendReply(
          event.conversationId,
          event,
          `❌ Cannot merge [${mrRef}](${mrUrl})${titleLine}${jiraLine}\n\nCI pipeline [#${pipe.id}](${pipe.web_url}) has failed.`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
        return;
      }

      // Precondition 6: Approvals check (if GitLab requires approvals and not approved yet)
      if (mrState.detailedMergeStatus === 'not_approved') {
        await sendReply(
          event.conversationId,
          event,
          `⏳ Cannot merge [${mrRef}](${mrUrl})${titleLine}${jiraLine}\n\nMR is not approved yet.`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.warning).catch(() => {});
        return;
      }

      // Action: Merge MR via GitLab API
      log(`Merging ${mr.project}!${mr.iid} via GitLab API...`);
      const mergeResult = await this.gitlab.mergeMr(mr.project, mr.iid, {
        shouldRemoveSourceBranch: true,
        mergeWhenPipelineSucceeds: true,
        ...(await this.gitlabActor(event.fromMri || event.sender?.mri)),
      });
      log(`Merged ${mr.project}!${mr.iid} result: state=${mergeResult?.state}, autoMerge=${mergeResult?.merge_when_pipeline_succeeds}`);

      if (mergeResult?.state === 'merged') {
        const targetBranch = mrState?.target_branch ? ` into \`${mrState.target_branch}\`` : '';
        await sendReply(
          event.conversationId,
          event,
          `🎉 Merged [${mrRef}](${mrUrl})${targetBranch}${titleLine}${jiraLine}`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
      } else if (mergeResult?.merge_when_pipeline_succeeds) {
        const pipeNote = pipe ? ` when [Pipeline #${pipe.id}](${pipe.web_url}) succeeds` : ' when CI succeeds';
        await sendReply(
          event.conversationId,
          event,
          `⏳ Auto-merge enabled for [${mrRef}](${mrUrl})${titleLine}${jiraLine} (will merge${pipeNote}).`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.running).catch(() => {});
      } else {
        await sendReply(
          event.conversationId,
          event,
          `✅ Merge requested for [${mrRef}](${mrUrl})${titleLine}${jiraLine} (status: \`${mergeResult?.state || 'in progress'}\`).`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
      }

      // Trigger immediate status check of watched entries so reactions and comment update
      this.checkAllWatched().catch((err) => log(`Post-merge check failed: ${err.message}`));
    } catch (err) {
      log(`Error merging ${mr.project}!${mr.iid}: ${err.message}`);
      const titleLine = mr.title ? `\n\n💬 **${mr.title}**` : '';
      await sendReply(
        event.conversationId,
        event,
        `❌ Merge failed for [${mrRef}](${mrUrl})${titleLine}: ${err.message}`
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    }
  }

  async executeCloseCommand(event, args) {
    log(`Executing /close command from ${event.from || event.fromMri} in ${event.conversationId}...`);
    const allMrs = await this.findTargetMrsForCommand(event, args);
    const mrs = allMrs.slice(0, 1);
    if (mrs.length === 0) {
      await sendReply(
        event.conversationId,
        event,
        '❌ No merge request found to close. Quote a message containing an MR or send `/close` immediately following it.'
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    const mr = mrs[0];
    const mrRef = `!${mr.iid} (${mr.project})`;
    const mrUrl = this.gitlab.mrLink(mr.project, mr.iid);

    try {
      const mrState = await this.gitlab.getMrStatus(mr.project, mr.iid);
      const title = mrState?.title || mr.title;
      const titleLine = title ? `\n\n💬 **${title}**` : '';
      const jiraTicket = this.jira?.findAssociatedIssue ? this.jira.findAssociatedIssue(mrState) : null;
      const jiraLine = jiraTicket ? `\n\n🎫 [${jiraTicket.key}](${jiraTicket.url})` : '';

      if (mrState.status === 'closed') {
        await sendReply(
          event.conversationId,
          event,
          `ℹ️ [${mrRef}](${mrUrl})${titleLine}${jiraLine}\n\nis already closed.`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
        return;
      }

      if (mrState.status === 'merged') {
        await sendReply(
          event.conversationId,
          event,
          `❌ Cannot close [${mrRef}](${mrUrl})${titleLine}${jiraLine}\n\nMR is already merged.`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
        return;
      }

      log(`Closing ${mr.project}!${mr.iid} via GitLab API...`);
      await this.gitlab.closeMr(mr.project, mr.iid, await this.gitlabActor(event.fromMri || event.sender?.mri));
      log(`Closed ${mr.project}!${mr.iid} successfully`);

      await sendReply(
        event.conversationId,
        event,
        `🚫 Closed [${mrRef}](${mrUrl})${titleLine}${jiraLine}`
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});

      this.checkAllWatched().catch((err) => log(`Post-close check failed: ${err.message}`));
    } catch (err) {
      log(`Error closing ${mr.project}!${mr.iid}: ${err.message}`);
      const titleLine = mr.title ? `\n\n💬 **${mr.title}**` : '';
      await sendReply(
        event.conversationId,
        event,
        `❌ Failed to close [${mrRef}](${mrUrl})${titleLine}: ${err.message}`
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    }
  }

  async executeReopenCommand(event, args) {
    log(`Executing /reopen command from ${event.from || event.fromMri} in ${event.conversationId}...`);
    const allMrs = await this.findTargetMrsForCommand(event, args);
    const mrs = allMrs.slice(0, 1);
    if (mrs.length === 0) {
      await sendReply(
        event.conversationId,
        event,
        '❌ No merge request found to reopen. Quote a message containing an MR or send `/reopen` immediately following it.'
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    const mr = mrs[0];
    const mrRef = `!${mr.iid} (${mr.project})`;
    const mrUrl = this.gitlab.mrLink(mr.project, mr.iid);

    try {
      const mrState = await this.gitlab.getMrStatus(mr.project, mr.iid);
      const title = mrState?.title || mr.title;
      const titleLine = title ? `\n\n💬 **${title}**` : '';
      const jiraTicket = this.jira?.findAssociatedIssue ? this.jira.findAssociatedIssue(mrState) : null;
      const jiraLine = jiraTicket ? `\n\n🎫 [${jiraTicket.key}](${jiraTicket.url})` : '';

      if (mrState.status === 'merged') {
        await sendReply(
          event.conversationId,
          event,
          `❌ Cannot reopen [${mrRef}](${mrUrl})${titleLine}${jiraLine}\n\nMR is already merged.`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
        return;
      }

      if (mrState.status !== 'closed') {
        await sendReply(
          event.conversationId,
          event,
          `ℹ️ [${mrRef}](${mrUrl})${titleLine}${jiraLine}\n\nis already open.`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
        return;
      }

      log(`Reopening ${mr.project}!${mr.iid} via GitLab API...`);
      await this.gitlab.reopenMr(mr.project, mr.iid, await this.gitlabActor(event.fromMri || event.sender?.mri));
      log(`Reopened ${mr.project}!${mr.iid} successfully`);

      if (allMrs.sourceMessageId) {
        await this.watchMessage(
          event.conversationId,
          allMrs.sourceMessageId,
          event.from,
          mrUrl,
          event.fromMri,
          { isHistory: false }
        ).catch(() => {});
      }

      await sendReply(
        event.conversationId,
        event,
        `🔓 Reopened [${mrRef}](${mrUrl})${titleLine}${jiraLine}`
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});

      this.checkAllWatched().catch((err) => log(`Post-reopen check failed: ${err.message}`));
    } catch (err) {
      log(`Error reopening ${mr.project}!${mr.iid}: ${err.message}`);
      const titleLine = mr.title ? `\n\n💬 **${mr.title}**` : '';
      await sendReply(
        event.conversationId,
        event,
        `❌ Failed to reopen [${mrRef}](${mrUrl})${titleLine}: ${err.message}`
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    }
  }

  async executeRebaseCommand(event, args) {
    log(`Executing /rebase command from ${event.from || event.fromMri} in ${event.conversationId}...`);
    const mrs = await this.findTargetMrsForCommand(event, args);
    if (mrs.length === 0) {
      await sendReply(
        event.conversationId,
        event,
        '❌ No merge request found to rebase. Quote an MR message or send `/rebase` immediately following it.'
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    for (const mr of mrs) {
      const mrRef = `!${mr.iid} (${mr.project})`;
      const mrUrl = this.gitlab.mrLink(mr.project, mr.iid);

      try {
        const mrState = await this.gitlab.getMrStatus(mr.project, mr.iid);
        const title = mrState?.title || mr.title;
        const titleLine = title ? `\n\n💬 **${title}**` : '';

        if (mrState.status === 'merged' || mrState.status === 'closed') {
          await sendReply(
            event.conversationId,
            event,
            `ℹ️ [${mrRef}](${mrUrl})${titleLine}\n\nis already ${mrState.status}.`
          );
          this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
          continue;
        }

        if (mrState.details?.hasConflicts) {
          await sendReply(
            event.conversationId,
            event,
            `❌ Cannot automatically rebase [${mrRef}](${mrUrl})${titleLine}\n\nBranch has merge conflicts that must be resolved manually.`
          );
          this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
          continue;
        }

        if (!mrState.needsRebase) {
          this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
          this.checkAllWatched().catch((err) => log(`Post-rebase check failed: ${err.message}`));
          continue;
        }

        log(`Triggering GitLab rebase for ${mr.project}!${mr.iid}...`);
        await this.gitlab.rebaseMr(mr.project, mr.iid, await this.gitlabActor(event.fromMri || event.sender?.mri));
        log(`Rebase triggered for ${mr.project}!${mr.iid}`);

        await sendReply(
          event.conversationId,
          event,
          `⏳ Rebase initiated for [${mrRef}](${mrUrl}).${titleLine}\n\nThe watcher will update once complete.`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.running).catch(() => {});

        this.checkAllWatched().catch((err) => log(`Post-rebase check failed: ${err.message}`));
      } catch (err) {
        log(`Error rebasing ${mr.project}!${mr.iid}: ${err.message}`);
        const titleLine = mr.title ? `\n\n💬 **${mr.title}**` : '';
        await sendReply(
          event.conversationId,
          event,
          `❌ Rebase failed for [${mrRef}](${mrUrl})${titleLine}: ${err.message}`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      }
    }
  }

  async executeStatusCommand(event, args) {
    const hasDirectLinks = args.some((a) => this.gitlab.findMrLinks(stripTruncatedUrlText(a, event)).length > 0);
    const hasQuoteLinks =
      this.gitlab.findMrLinks(buildMessageSearchText({ rawHtml: event.rawHtml, links: event.links })).length > 0;

    if (!hasDirectLinks && !hasQuoteLinks && args.length === 0) {
      log(`Executing bot runtime /status in ${event.conversationId}...`);
      const uptimeSec = Math.floor(process.uptime());
      const hours = Math.floor(uptimeSec / 3600);
      const minutes = Math.floor((uptimeSec % 3600) / 60);
      const seconds = uptimeSec % 60;
      const uptimeStr = `${hours > 0 ? `${hours}h ` : ''}${minutes}m ${seconds}s`;
      const memRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      const startTime = new Date(Date.now() - uptimeSec * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

      const convCount = this.watchedConversations.size;
      const watchedMrsCount = this.watched.size;
      const completedCount = this.completedMessages.size;

      const conn = await this.getConnectorsStatus();
      const brokenConnectors = [];
      if (conn.teams.status !== 'ok') {
        brokenConnectors.push(`- 💬 **Microsoft Teams**: ❌ Disconnected (${conn.teams.details})`);
      }
      if (conn.gitlab.status === 'auth_expired' || conn.gitlab.status === 'error') {
        brokenConnectors.push(`- 🦊 **GitLab**: ❌ ${conn.gitlab.error || 'Authentication expired'}`);
      }
      if (conn.jira.status === 'auth_expired' || conn.jira.status === 'error') {
        brokenConnectors.push(`- 📋 **Jira**: ❌ ${conn.jira.error || 'Authentication expired'}`);
      }
      if (conn.confluence && (conn.confluence.status === 'auth_expired' || conn.confluence.status === 'error')) {
        brokenConnectors.push(`- 📄 **Confluence**: ❌ ${conn.confluence.error || 'Authentication expired'}`);
      }
      if (conn.opsgenie.status === 'auth_expired' || conn.opsgenie.status === 'error') {
        brokenConnectors.push(`- 🚨 **OpsGenie**: ❌ ${conn.opsgenie.error || 'Authentication expired'}`);
      }
      if (conn.homeassistant && (conn.homeassistant.status === 'auth_expired' || conn.homeassistant.status === 'error')) {
        brokenConnectors.push(`- 🏠 **Home Assistant (HR works)**: ❌ ${conn.homeassistant.error || 'Authentication expired'}`);
      }

      let connectorNotice = '';
      if (brokenConnectors.length > 0) {
        connectorNotice = `\n⚠️ **Connector Issues**:\n${brokenConnectors.join('\n')}\n`;
      }

      await sendReply(
        event.conversationId,
        event,
        '🤖 **teams-live status**:\n\n' +
        `- ⏱️ **Uptime**: ${uptimeStr} (started ${startTime})\n` +
        `- ⚙️ **Runtime**: Node.js ${process.version} (PID ${process.pid})\n` +
        `- 💾 **Memory (RSS)**: ${memRss} MB\n` +
        `- 🔌 **Trouter**: Connected 🟢\n` +
        `- 💬 **Watched Conversations**: ${convCount}\n` +
        `- 👀 **Active MR Watchers**: ${watchedMrsCount}\n` +
        `- ⚡ **Precompute Cache**:\n` +
        this.getPrecomputeCacheLines().join('\n') + '\n' +
        `- 📬 **Completed Message Cache**: ${completedCount}\n` +
        connectorNotice +
        '\n_Tip: To check an MR status, use `/status [link]` or quote an MR message._'
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
      return;
    }

    const mrs = await this.findTargetMrsForCommand(event, args);
    if (mrs.length === 0) {
      await sendReply(
        event.conversationId,
        event,
        '❌ No merge request found. Quote an MR message or send `/status` immediately following it.'
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    for (const mr of mrs) {
      const mrRef = `!${mr.iid} (${mr.project})`;
      const mrUrl = this.gitlab.mrLink(mr.project, mr.iid);
      try {
        const mrState = await this.gitlab.getMrStatus(mr.project, mr.iid);
        const title = mrState.title || mr.title;
        const titleLine = title ? `💬 **${title}**\n\n` : '';
        const jiraTicket = this.jira?.findAssociatedIssue ? this.jira.findAssociatedIssue(mrState) : null;
        const jiraLine = jiraTicket ? `🎫 [${jiraTicket.key}](${jiraTicket.url})\n\n` : '';
        const pipe = mrState.pipeline;
        const pipeIcon = pipe?.status ? getCiStatusEmoji(pipe.status) : '🏗️';
        const pipeText = pipe ? `${pipeIcon} [#${pipe.id} (${pipe.status})](${pipe.web_url})` : 'none';
        const rebaseText = mrState.needsRebase
          ? `⚠️ Needs rebase (${mrState.hasConflicts ? 'conflicts' : 'behind'})`
          : '✅ Up to date';
        const approverNames = (mrState.approvedBy || []).filter(Boolean);
        const approvalText =
          mrState.approved || mrState.status === 'approved'
            ? `👍 **Approved**${approverNames.length > 0 ? ` by ${approverNames.join(', ')}` : ''}`
            : '⏳ **Not approved yet**';
        const autoMergeText = mrState.autoMerge
          ? `🔀 **Enabled**${mrState.autoMergeUser ? ` by ${mrState.autoMergeUser}` : ''}`
          : 'disabled';
        const statusText = `Status: **${mrState.status}**\n\nApproval: ${approvalText}\n\nPipeline: ${pipeText}\n\nBranch: ${rebaseText}\n\nAuto-merge: ${autoMergeText}`;

        const statusMarkdown = `📊 [${mrRef}](${mrUrl})\n\n${titleLine}${jiraLine}${statusText}`;
        const statusState = mrState.state === 'merged' ? 'merged' : mrState.state === 'closed' ? 'closed' : 'open';
        await this.prefetchAvatars(this.mrCardPeopleData(null, mrState));
        const statusMessage = this.richMessage(statusMarkdown, () =>
          this.buildMrCard({ project: mr.project, iid: mr.iid, title: mr.title }, mrState, {
            state: statusState,
            pipeline: this.mrCardPipeline(mr, pipe),
          })
        );
        await sendReply(event.conversationId, event, statusMessage);
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
      } catch (err) {
        const titleText = mr.title ? `: ${mr.title}` : '';
        await sendReply(event.conversationId, event, `❌ Status check failed for [${mrRef}](${mrUrl})${titleText}: ${err.message}`);
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      }
    }
  }

  /** Whether the TV cards show programme pictures (`tv.artwork`, on by default). */
  tvArtwork() {
    return this.tv.config?.artwork !== false;
  }

  /** The `/tv program` reply: regular markdown, or with rich messages the programme card. */
  formatTvProgrammeMessage(data) {
    const markdown = formatProgrammeText(data);
    if (!this.richMessages) return markdown;
    return this.richMessage(markdown, () => buildTvProgrammeCard(data, { artwork: this.tvArtwork() }));
  }

  /** The reply of a `/tv` control (see tvControlReply): regular markdown, or with rich messages its compact card. */
  tvControlMessage(outcome) {
    const { markdown, card } = tvControlReply(outcome, {
      now: this.tv.now(),
      timezone: this.tv.config.timezone,
      artwork: this.tvArtwork(),
    });
    if (!this.richMessages) return markdown;
    return this.richMessage(markdown, () => card);
  }

  async executeTvCommand(event, args = []) {
    const parsed = parseTvArgs(args);
    if (TV_CONTROL_ACTIONS.includes(parsed.action)) {
      await this.executeTvSwitchCommand(event, parsed.action);
      return;
    }
    if (parsed.action !== 'programme') {
      await sendReply(event.conversationId, event, `\u2139\uFE0F ${TV_USAGE}`);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.warning).catch(() => {});
      return;
    }
    log(`Executing /tv program in ${event.conversationId}...`);
    try {
      const data = await this.tv.getProgramme();
      await sendReply(event.conversationId, event, this.formatTvProgrammeMessage(data));
      const failed = data.channels.every((ch) => ch.error);
      this.setCommandReaction(
        event.conversationId,
        event.messageId,
        failed ? COMMAND_REACTIONS.failure : COMMAND_REACTIONS.success
      ).catch(() => {});
    } catch (err) {
      log(`TV programme lookup failed: ${err.message}`);
      await sendReply(event.conversationId, event, `\u274C TV programme lookup failed: ${err.message}`);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    }
  }

  /**
   * The owner-only `/tv` controls (same policy as /restart), fail-closed:
   * `ard|zdf|tagesschau|off`, `next|prev`, `mute`, `unmute`, `vol up|down`. Webhook URLs,
   * ids and the Home Assistant token never appear in a reply or in the log.
   */
  async executeTvSwitchCommand(event, action) {
    const react = (kind) =>
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS[kind]).catch(() => {});
    if (!this.isAdmin(event)) {
      log.warn(`Unauthorized /tv ${action} attempt from ${event.from || event.fromMri} in ${event.conversationId}`);
      await sendReply(event.conversationId, event, this.respondNotPrivileged(event));
      react('failure');
      return;
    }
    const name = action.replace('_', ' ');
    const command = `/tv ${name}`;
    if (!this.tvSwitch.canRun(action)) {
      log(`${command}: not configured`);
      await sendReply(event.conversationId, event, this.tvControlMessage({ type: 'unconfigured', command }));
      react('warning');
      return;
    }
    log(`Admin ${command} issued by ${event.from || event.fromMri} in ${event.conversationId}`);
    let result;
    let doing;
    if (action === 'next' || action === 'prev') {
      doing = 'Switching channel';
      result = await this.tvSwitch.cycle(action);
    } else if (action === 'mute') {
      doing = 'Muting';
      result = await this.tvSwitch.mute();
    } else if (action === 'unmute') {
      doing = 'Unmuting';
      result = await this.tvSwitch.unmute();
    } else if (action === 'volume_up' || action === 'volume_down') {
      doing = 'Changing the volume';
      result = await this.tvSwitch.volumeStep(action === 'volume_up' ? 'up' : 'down');
    } else {
      doing = `Switching to ${action === 'off' ? 'off (brb)' : TV_CHANNEL_LABELS[action]}`;
      result = await this.tvSwitch.switchTo(action);
    }
    if (result.noop) {
      // The scene gate refused: nothing was sent, which is not a failure of the daemon.
      log(`${command}: nothing to do (${result.error})`);
      await sendReply(event.conversationId, event, this.tvControlMessage({ type: 'noop', command, reason: result.error }));
      react('warning');
      return;
    }
    if (!result.ok) {
      log(`${command} failed: ${result.error}`);
      await sendReply(event.conversationId, event, this.tvControlMessage({ type: 'failed', doing, error: result.error }));
      react('failure');
      return;
    }
    if (result.requested) {
      // A webhook cannot prove OBS acted: say "requested", never "done".
      await sendReply(
        event.conversationId,
        event,
        this.tvControlMessage({ type: 'audio', action, channel: result.channel, level: result.level })
      );
      react('success');
      return;
    }
    // The webhook only queued the switch. The readback of the scene (when there is one) decides between
    // "confirmed" and "requested", and the programme is a best effort next to it: both are bounded, run
    // side by side, and neither can turn the accepted switch into an error.
    const target = result.target || action;
    const [confirmed, programme] = await Promise.all([
      this.tvSwitch.confirm(target).catch(() => false),
      target === 'off' ? null : this.tv.channelNow(target).catch(() => null),
    ]);
    await sendReply(
      event.conversationId,
      event,
      this.tvControlMessage({ type: 'switch', target, state: confirmed ? 'confirmed' : 'requested', programme })
    );
    react('success');
  }

  async executeWeatherCommand(event, args) {
    const location = args.join(' ').trim() || 'Berlin';
    log(`Executing /weather for "${location}" in ${event.conversationId}...`);
    try {
      const url = `https://wttr.in/${encodeURIComponent(location)}?format=%l:+%c+%t+(feels+like+%f),+humidity:+%h,+wind:+%w`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'curl/8.0' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const weatherText = (await res.text()).trim();
      await sendReply(event.conversationId, event, `🌤️ ${weatherText}`);
      this.setCommandReaction(event.conversationId, event.messageId, 'like').catch(() => {});
    } catch (err) {
      log(`Weather lookup failed: ${err.message}`);
      await sendReply(event.conversationId, event, `❌ Weather lookup failed for "${location}": ${err.message}`);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    }
  }

  extractWhoisTarget(event, args) {
    const rawArgs = args.join(' ').trim();
    if (rawArgs) return rawArgs;

    // Check if command was sent in reply to another message
    const html = event.rawHtml || '';
    const mriMatch = html.match(/itemprop=["']mri["']\s+itemid=["']([^"']+)["']/i) ||
                     html.match(/itemid=["']([^"']+)["']\s+itemprop=["']mri["']/i);
    if (mriMatch) return mriMatch[1];

    const senderMatch = html.match(/<strong[^>]*itemprop=["']mri["'][^>]*>([^<]+)<\/strong>/i);
    if (senderMatch) return senderMatch[1].trim();

    return null;
  }

  async executeWhoisCommand(event, args) {
    const target = this.extractWhoisTarget(event, args);
    if (!target) {
      await sendReply(
        event.conversationId,
        event,
        'ℹ️ Usage: `/whois <name | email | username | @mention>` (or reply to a message with `/whois`)'
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.warning).catch(() => {});
      return;
    }

    try {
      let query = target.trim();
      if (query.toLowerCase() === 'me') {
        query = event.fromMri || event.from || 'me';
      }

      log(`Executing /whois for "${query}" in ${event.conversationId}...`);
      const results = await this.userDirectory.searchDirectory(query);
      if (!results || results.length === 0) {
        const suggestions = this.userDirectory.findSuggestions(query);
        let tip = '';
        if (suggestions.length > 0) {
          const first = suggestions[0];
          const queryCandidate = first.email || first.displayName;
          tip = `\n\n💡 *Did you mean*: \`/whois ${queryCandidate}\`?`;
        }
        await sendReply(
          event.conversationId,
          event,
          `❌ No one found matching "**${escapeHtml(query)}**" in the Teams directory.${tip}`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
        return;
      }

      // If exactly 1 result, show full contact card
      if (results.length === 1) {
        const text = this.richCommandMessage(
          formatContactCard(results[0], { userDirectory: this.userDirectory }),
          { service: 'directory', kind: 'Contact' }
        );
        await sendReply(event.conversationId, event, text);
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
        return;
      }

      // Check for an unambiguous single exact match among multiple results
      const qNorm = normalizeName(query);
      const qLower = query.toLowerCase();
      const exactMatches = results.filter((r) => {
        if (r.mri && r.mri === query) return true;
        if (r.email && r.email.toLowerCase() === qLower) return true;
        if (r.email && r.email.split('@')[0].toLowerCase() === qLower) return true;
        if (r.displayName && normalizeName(r.displayName) === qNorm) return true;
        return false;
      });

      if (exactMatches.length === 1) {
        const text = this.richCommandMessage(
          formatContactCard(exactMatches[0], { userDirectory: this.userDirectory }),
          { service: 'directory', kind: 'Contact' }
        );
        await sendReply(event.conversationId, event, text);
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
      } else {
        const text = this.richCommandMessage(formatSearchResultsList(results, query), {
          service: 'directory',
          kind: 'Search results',
        });
        await sendReply(event.conversationId, event, text);
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
      }
    } catch (err) {
      log(`Failed to execute /whois: ${err.message}`);
      await sendReply(event.conversationId, event, `❌ Failed to look up user in Teams directory: ${err.message}`);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    }
  }

  async executeWhereisCommand(event, args) {
    const target = this.extractWhoisTarget(event, args);
    let query = target ? target.trim() : '';
    if (!query || query.toLowerCase() === 'me') {
      query = event.fromMri || event.from || 'me';
    }

    try {
      log(`Executing /whereis for "${query}" in ${event.conversationId}...`);
      const results = await this.userDirectory.searchDirectory(query);
      if (!results || results.length === 0) {
        const suggestions = this.userDirectory.findSuggestions(query);
        let tip = '';
        if (suggestions.length > 0) {
          const first = suggestions[0];
          const queryCandidate = first.email || first.displayName;
          tip = `\n\n💡 *Did you mean*: \`/whereis ${queryCandidate}\`?`;
        }
        await sendReply(
          event.conversationId,
          event,
          `❌ No one found matching "**${escapeHtml(query)}**" in the Teams directory.${tip}`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
        return;
      }

      // Check disambiguation
      let targetPerson = null;
      if (results.length === 1) {
        targetPerson = results[0];
      } else {
        const qNorm = normalizeName(query);
        const qLower = query.toLowerCase();
        const exactMatches = results.filter((r) => {
          if (r.mri && r.mri === query) return true;
          if (r.email && r.email.toLowerCase() === qLower) return true;
          if (r.email && r.email.split('@')[0].toLowerCase() === qLower) return true;
          if (r.displayName && normalizeName(r.displayName) === qNorm) return true;
          return false;
        });

        if (exactMatches.length === 1) {
          targetPerson = exactMatches[0];
        } else {
          const text = this.richCommandMessage(
            formatSearchResultsList(results, query, { command: '/whereis' }),
            { service: 'availability', kind: 'Search results' }
          );
          await sendReply(event.conversationId, event, text);
          this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
          return;
        }
      }

      // Fetch Presence
      let presenceData = {};
      if (targetPerson.mri) {
        try {
          const presRes = await getUserPresence(targetPerson.mri);
          if (presRes.ok && Array.isArray(presRes.value?.data)) {
            presenceData = presRes.value.data[0]?.presence || {};
          }
        } catch (err) {
          log.warn(`Failed to fetch presence for ${targetPerson.mri}: ${err.message}`);
        }
      }

      // Check active meetings from calendar
      let activeMeeting = null;
      try {
        const now = new Date();
        const calRes = await getCalendarView({
          startDate: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
          endDate: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
          limit: 10,
        });

        if (calRes.ok && Array.isArray(calRes.value?.meetings)) {
          const nowMs = now.getTime();
          const targetEmail = targetPerson.email?.toLowerCase();
          const currentMeetings = calRes.value.meetings.filter((m) => {
            const startMs = new Date(m.startTime).getTime();
            const endMs = new Date(m.endTime).getTime();
            return nowMs >= startMs - 5 * 60 * 1000 && nowMs <= endMs + 5 * 60 * 1000;
          });

          if (currentMeetings.length > 0) {
            activeMeeting = currentMeetings.find((m) =>
              m.organizer?.email?.toLowerCase() === targetEmail ||
              (targetPerson.mri && m.id?.includes(targetPerson.mri))
            ) || (presenceData.activity === 'InAMeeting' || presenceData.activity === 'InACall' ? currentMeetings[0] : null);
          }
        }
      } catch (err) {
        log.warn(`Calendar view query failed: ${err.message}`);
      }

      // Check HRworks absences
      let hrworksAbsence = null;
      if (this.hrworks) {
        try {
          hrworksAbsence = await this.hrworks.findPersonAbsence(targetPerson);
        } catch (err) {
          log.warn(`HRworks absence query failed: ${err.message}`);
          hrworksAbsence = { checked: true, error: err.message };
        }
      }

      const text = this.richCommandMessage(
        formatWhereisCard(targetPerson, presenceData, {
          activeMeeting,
          hrworksAbsence,
          userDirectory: this.userDirectory,
        }),
        { service: 'availability', kind: 'Availability' }
      );

      await sendReply(event.conversationId, event, text);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
    } catch (err) {
      log(`Failed to execute /whereis: ${err.message}`);
      await sendReply(event.conversationId, event, `❌ Failed to look up user location/status: ${err.message}`);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    }
  }

  async executeRandomCommand(event) {
    log(`Executing /random fact in ${event.conversationId}...`);
    try {
      const res = await fetch('https://uselessfacts.jsph.pl/api/v2/facts/random', {
        headers: { 'User-Agent': 'teams-live/1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      await sendReply(event.conversationId, event, `💡 **Random Fact**:\n\n${data.text}`);
      this.setCommandReaction(event.conversationId, event.messageId, 'like').catch(() => {});
    } catch (err) {
      log(`Random fact failed: ${err.message}`);
      await sendReply(event.conversationId, event, `❌ Failed to fetch a random fact: ${err.message}`);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    }
  }

  async getOrFetchMrsData({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.mrsCache.data && now - this.mrsCache.timestamp < this.cacheTtlMs) {
      return this.mrsCache.data;
    }
    if (this.mrsCache.loading) {
      return await this.mrsCache.loading;
    }

    this.mrsCache.loading = (async () => {
      try {
        const mrs = await this.gitlab.getGroupMrs(null, { approvals: this.richMessages });
        this.mrsCache.data = mrs;
        this.mrsCache.timestamp = Date.now();
        return mrs;
      } catch (err) {
        if (this.mrsCache.data) {
          log(`Failed to refresh /mrs cache (${err.message}), serving stale cache`);
          return this.mrsCache.data;
        }
        throw err;
      } finally {
        this.mrsCache.loading = null;
      }
    })();

    return await this.mrsCache.loading;
  }

  /**
   * The /mrs list as data: the headline and the sections (heading, rows, note),
   * each row with its regular markdown line and the facts the list card shows
   * (see mrsListCards). `text` instead is a reply without a list.
   */
  collectMrsListing(mrs, opts = {}) {
    if (!mrs || mrs.length === 0) {
      return { text: '📋 No open merge requests found.' };
    }

    const { mode = 'default', userFilter = null, userFilterLabel = null, rich = false } =
      typeof opts === 'string' ? { mode: opts } : (opts || {});

    // Rich lists show the author's picture where the identity is exact (see mrListAuthorPersons).
    const authorPersons = rich && this.avatarService ? this.mrListAuthorPersons(mrs) : null;

    const groupPrefix = this.config.gitlab?.group
      ? new RegExp(`^${this.config.gitlab.group}/?`)
      : null;

    const formatMrRow = (mr) => {
      const fullRef = mr.references?.full || mr.references?.relative || `!${mr.iid}`;
      const displayRef = groupPrefix ? fullRef.replace(groupPrefix, '') : fullRef;
      const mention = this.userDirectory.formatMention(mr.author);
      const statusEmoji = getMrStatusEmoji(mr);
      const jiraTicket = this.jira?.findAssociatedIssue ? this.jira.findAssociatedIssue(mr) : null;
      const jiraBadge = jiraTicket ? ` 🎫 [${jiraTicket.key}](${jiraTicket.url})` : '';

      const needsRebase =
        !mr.rebase_in_progress &&
        (mr.detailed_merge_status === 'need_rebase' ||
          (typeof mr.diverged_commits_count === 'number' && mr.diverged_commits_count > 0) ||
          mr.should_be_rebased === true);

      let rebaseBadge = '';
      let rebaseText = '';
      if (mr.rebase_in_progress) {
        rebaseBadge = ' 🔄 _rebase in progress_';
        rebaseText = '🔄 rebase in progress';
      } else if (mr.has_conflicts || mr.detailed_merge_status === 'conflict') {
        rebaseBadge = ' 💥 _conflicts_';
        rebaseText = '💥 conflicts';
      } else if (needsRebase) {
        rebaseBadge = ' ⚠️ _rebase!_';
        rebaseText = '⚠️ rebase!';
      }

      // Rich lists also carry the approval (when it was retrieved) and honour the
      // newer auto-merge flag; the regular list is unchanged.
      const autoMerge = rich ? mr.merge_when_pipeline_succeeds || mr.auto_merge_enabled : mr.merge_when_pipeline_succeeds;
      const autoMergeBadge = autoMerge ? ' 🔀 _auto-merge_' : '';
      let approvalBadge = '';
      let approvalText = '';
      if (rich && mr.approval_summary?.known) {
        approvalBadge = mr.approval_summary.approved ? ' 👍 _approved_' : ' ⏳ _not approved_';
        approvalText = mr.approval_summary.approved ? '👍 approved' : '⏳ not approved';
      }

      const refMatch = /^(.*?)(!\d+)$/.exec(displayRef);
      return {
        multiMr: {
          iid: mr.iid, title: mr.title, url: mr.web_url,
          fullProject: mr.references?.full?.replace(/!\d+$/, '') || '',
          sha: mr.sha || mr.diff_refs?.head_sha || null,
          project: refMatch ? refMatch[1].replace(/\/$/, '') : '',
          state: !mr.state || mr.state === 'opened' ? 'open' : mr.state,
          draft: mr.draft || mr.work_in_progress, author: mr.author?.name || '',
          approved: mr.approval_summary?.known ? mr.approval_summary.approved : null,
          approvedBy: mr.approval_summary?.approvedBy || [],
          pipeline: { status: mr.head_pipeline?.status || mr.pipeline_status || mr.pipeline?.status },
          autoMerge: Boolean(autoMerge), needsRebase,
          hasConflicts: mr.has_conflicts || mr.detailed_merge_status === 'conflict',
          rebaseInProgress: mr.rebase_in_progress, jira: jiraTicket,
          mergeable: mr.detailed_merge_status === 'mergeable',
        },
        line: `- ${statusEmoji} [${displayRef}](${mr.web_url})${jiraBadge}: ${mr.title} (${mention})${approvalBadge}${rebaseBadge}${autoMergeBadge}`,
        project: refMatch ? refMatch[1].replace(/\/$/, '') : '',
        ref: refMatch ? refMatch[2] : displayRef,
        url: mr.web_url,
        title: mr.title,
        state: mrListState({ state: mr.state, draft: mr.draft || mr.work_in_progress }),
        ciStatus: mr.head_pipeline?.status || mr.pipeline_status || mr.pipeline?.status || null,
        statusEmoji,
        author: mention,
        authorPerson: authorPersons?.get(mr) || null,
        // Every author not taken for a bot gets a picture slot (the neutral placeholder when no photo
        // is known). isBotMr is a heuristic (name, username and title patterns): a human it takes for
        // a bot is listed with the bots and has no slot, a limit of that classification, not of the slots.
        avatarSlot: Boolean(authorPersons) && Boolean(mr.author) && typeof mr.author === 'object' && !isBotMr(mr),
        jira: jiraTicket ? { key: jiraTicket.key, url: jiraTicket.url } : null,
        badges: [approvalText, rebaseText, autoMerge ? '🔀 auto-merge' : ''].filter(Boolean),
      };
    };

    if (mode === 'user' && userFilter) {
      const filtered = sortMrs(mrs.filter((mr) => this.userDirectory.matchesUser(mr.author, userFilter)));
      const label = userFilterLabel || (typeof userFilter === 'object' ? userFilter.displayName : userFilter);
      if (filtered.length === 0) {
        return { text: `📋 No open merge requests found for **${label}**.` };
      }
      return {
        headline: `📋 **Open Merge Requests by ${label}** (${filtered.length} open):`,
        sections: [{ heading: null, rows: filtered.map(formatMrRow), note: null }],
      };
    }

    const humanMrs = sortMrs(mrs.filter((mr) => !isBotMr(mr)));
    const botMrs = sortMrs(mrs.filter(isBotMr));

    if (mode === 'bots') {
      if (botMrs.length === 0) {
        return { text: '🤖 No open renovate or bot merge requests found.' };
      }
      return {
        headline: `🤖 **Renovate / Bot Updates** (${botMrs.length}):`,
        sections: [{ heading: null, rows: botMrs.map(formatMrRow), note: null }],
      };
    }

    if (mode === 'default') {
      // Just the people's merge requests; the bot ones stay out unless asked for (`/mrs all`, `/mrs bots`).
      if (humanMrs.length === 0) {
        return {
          text: botMrs.length > 0
            ? `📋 No open human merge requests (${botMrs.length} bot MRs: use \`/mrs bots\` or \`/mrs all\`).`
            : '📋 No open merge requests found.',
        };
      }
      return {
        headline: `📋 **Open Merge Requests** (${humanMrs.length} human):`,
        // The card needs neither a title nor a section heading for a single group.
        cardHeadline: '',
        sections: [
          {
            heading: null,
            rows: humanMrs.map(formatMrRow),
            note: botMrs.length > 0 ? `_${botMrs.length} bot MRs not shown (use \`/mrs all\` or \`/mrs bots\`)_` : null,
          },
        ],
      };
    }

    const sections = [];
    if (humanMrs.length > 0) {
      sections.push({
        heading: `👤 **Human Merge Requests** (${humanMrs.length}):`,
        rows: humanMrs.map(formatMrRow),
        note: null,
      });
    }

    if (botMrs.length > 0) {
      sections.push({
        heading: `🤖 **Renovate / Bot Updates** (${botMrs.length}):`,
        rows: botMrs.map(formatMrRow),
        note: null,
      });
    }

    return {
      headline: `📋 **Open Merge Requests** (${mrs.length} total: ${humanMrs.length} human, ${botMrs.length} bot):`,
      // The card's sections carry the counts; it needs no title of its own.
      cardHeadline: '',
      sections,
    };
  }

  /** The regular markdown of a listing (see collectMrsListing). */
  renderMrsListing(listing) {
    if (listing.text) return listing.text;
    const parts = listing.sections.map((sec) =>
      [sec.heading, sec.rows.map((row) => row.line).join('\n'), sec.note].filter(Boolean).join('\n\n')
    );
    return [listing.headline, ...parts].join('\n\n');
  }

  formatMrsText(mrs, opts = {}) {
    return this.renderMrsListing(this.collectMrsListing(mrs, opts));
  }

  async getOrFetchMrsText({ force = false, ...parsed } = {}) {
    const data = await this.getOrFetchMrsData({ force });
    if (Array.isArray(data)) {
      for (const mr of data) {
        if (mr.author && !isBotMr(mr)) {
          this.userDirectory.resolveUser(mr.author).catch(() => {});
        }
      }
    }
    await this.prefetchMrsListAvatars(data);
    return this.formatMrsMessage(data, parsed);
  }

  /**
   * Who a listed merge request's author is, for the profile picture: the
   * GitLab display name, and only when no other author of the list has the
   * same name. AvatarService then still needs exactly one Teams identity with
   * that full name (see avatars.mjs); GitLab usernames are not used, as the
   * directory only guesses them from names. Bots have no Teams profile.
   * Returns a Map of merge request to person.
   */
  mrListAuthorPersons(mrs) {
    const persons = new Map();
    if (!this.avatarService || !Array.isArray(mrs)) return persons;
    const norm = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
    const listed = mrs.filter((mr) => mr?.author && typeof mr.author === 'object' && !isBotMr(mr));
    const usernamesByName = new Map();
    for (const { author } of listed) {
      const name = norm(author.name);
      if (!usernamesByName.has(name)) usernamesByName.set(name, new Set());
      usernamesByName.get(name).add(norm(author.username));
    }
    for (const mr of listed) {
      const name = String(mr.author.name ?? '').trim();
      if (name && usernamesByName.get(norm(name))?.size === 1) persons.set(mr, { name });
    }
    return persons;
  }

  /**
   * Fetches the pictures of the listed authors before the list is built: each
   * author once, all of them under one deadline for the whole list (a slow
   * lookup carries on in the background and is in the cache for the next list).
   */
  async prefetchMrsListAvatars(mrs) {
    if (!this.avatarService) return;
    try {
      const unique = new Map();
      for (const person of this.mrListAuthorPersons(mrs).values()) unique.set(person.name, person);
      await this.avatarService.avatarsFor([...unique.values()], { deadlineMs: MRS_LIST_AVATAR_DEADLINE_MS, size: MRS_LIST_AVATAR_SIZE });
    } catch (e) {
      log.warn(`profile picture lookup failed: ${e.message}`);
    }
  }

  /** Pack the listing into size-limited multi-MR cards, keeping sections and fallback text. */
  mrsListCards(listing, { images, ciIcons, avatars }) {
    const rows = listing.sections.flatMap((section) => section.rows);
    for (const row of rows) delete row.avatar;
    if (avatars) {
      for (const row of rows) {
        if (!row.avatarSlot) continue;
        const photo = row.authorPerson ? this.avatarService.peek(row.authorPerson, { size: MRS_LIST_AVATAR_SIZE }) : null;
        row.avatar = isImageDataUri(photo) ? photo : fallbackAvatar(row.authorPerson?.name ?? row.authorPerson);
      }
    }
    // Rows in display order: a card groups the rows of a section by project, so do the same here.
    const items = [];
    const edges = listing.sections.map(() => ({ first: null, last: null }));
    listing.sections.forEach((section, index) => {
      const projects = [...new Set(section.rows.map((row) => row.project || ''))];
      const ordered = [...section.rows].sort((x, y) => projects.indexOf(x.project || '') - projects.indexOf(y.project || ''));
      for (const row of ordered) items.push({ index, row });
      edges[index] = { first: ordered[0], last: ordered[ordered.length - 1] };
    });
    const continued = (heading) =>
      /\)\s*:?\s*$/.test(heading) ? heading.replace(/\)\s*:?\s*$/, ', continued):') : `${heading.replace(/:\s*$/, '')} (continued)`;
    const build = (chunk, part, withActions = false) => {
      const sections = [];
      for (const { index, row } of chunk) {
        if (sections.at(-1)?.index !== index) {
          const source = listing.sections[index];
          const starts = edges[index].first === row;
          sections.push({ index, heading: source.heading && !starts ? continued(source.heading) : source.heading, rows: [], note: null });
        }
        sections.at(-1).rows.push(row);
      }
      for (const section of sections) {
        if (section.rows.includes(edges[section.index].last)) section.note = listing.sections[section.index].note;
      }
      const markdown = this.renderMrsListing({ headline: listing.headline, sections });
      const actionRows = chunk.map(({ row }) => ({ ...row.multiMr, project: row.multiMr.fullProject }));
      const eligible = actionRows.filter((row) => row.state === 'open' && !row.draft && row.sha);
      const approveUrl = withActions && eligible.length && this.approveFlow?.batchLinkFor
        ? this.approveFlow.batchLinkFor(eligible, 'approve') : null;
      const openUrl = withActions && this.approveFlow?.batchLinkFor
        ? this.approveFlow.batchLinkFor(actionRows, 'open') : null;
      const mergeUrl = withActions ? this.batchMergeUrl(actionRows) : null;
      const card = buildMultiMrCard(sections.flatMap((section) => section.rows.map((row, index) => ({
        ...row.multiMr, showAuthorAvatar: Boolean(avatars && row.avatarSlot),
        avatars: row.avatar && row.multiMr.author ? { [row.multiMr.author]: row.avatar } : {},
        sectionHeading: index === 0 ? section.heading : null,
        sectionNote: index === section.rows.length - 1 ? section.note : null,
      }))), { fallbackText: markdown, images: images && ciIcons, listMode: true, headline: listing.headline, part, approveUrl, mergeUrl, openUrl });
      return card ? makeRichMessage(markdown, card) : null;
    };
    // The card label ("2/3") is measured at its widest, so the final numbers cannot overflow.
    const fits = (chunk) => {
      const message = build(chunk, [MRS_LIST_MAX_CARDS, MRS_LIST_MAX_CARDS]);
      return Boolean(message) && richMessageWireBytes(message) <= MAX_CARD_BYTES;
    };
    try {
      // One card when everything fits. Otherwise split along the sections (humans, then bots) first, and
      // only a section that is too large for one card on its own is split further.
      const pack = (breakAtSections) => {
        const out = [];
        let current = [];
        for (const item of items) {
          const newSection = breakAtSections && current.length > 0 && current.at(-1).index !== item.index;
          if (!newSection && fits([...current, item])) {
            current.push(item);
            continue;
          }
          if (current.length > 0) out.push(current);
          current = [item];
          const fallback = fallbackAvatar(item.row.authorPerson?.name ?? item.row.authorPerson);
          if (!fits(current) && item.row.avatar && item.row.avatar !== fallback) {
            item.row.avatar = fallback;
          }
          if (!fits(current) || out.length >= MRS_LIST_MAX_CARDS) return null;
        }
        if (current.length > 0) out.push(current);
        return out;
      };
      let chunks = pack(false);
      if (chunks && chunks.length > 1) chunks = pack(true) || chunks;
      if (!chunks) return null;
      const total = chunks.length;
      const messages = chunks.map((chunk, i) => build(chunk, total > 1 ? [i + 1, total] : null, true));
      if (messages.some((message) => !message || richMessageWireBytes(message) > MAX_CARD_BYTES)) return null;
      return makeRichMessageSequence(messages);
    } catch (e) {
      log(`building the /mrs list cards failed: ${e.message}`);
      return null;
    }
  }

  /** Render /mrs as multi-MR cards when enabled, otherwise as markdown. */
  formatMrsMessage(mrs, parsed = {}) {
    const listing = this.collectMrsListing(mrs, { ...parsed, rich: this.richMessages });
    const markdown = this.renderMrsListing(listing);
    if (!this.richMessages || listing.text) return markdown;
    // Heaviest form first: state glyphs and CI status icons, then the glyphs only, then emojis.
    const forms = [{ images: true, ciIcons: true }, { images: true, ciIcons: false }, { images: false, ciIcons: false }];
    const hasSlots = Boolean(this.avatarService) && !this.suppressAvatars && listing.sections.some((s) => s.rows.some((r) => r.avatarSlot));
    for (const avatars of hasSlots ? [true, false] : [false]) {
      for (const form of forms) {
        const message = this.mrsListCards(listing, { ...form, avatars });
        if (message) {
          if (hasSlots && !avatars) log('the /mrs list is too large for author pictures, sending it without them');
          return message;
        }
      }
    }
    return markdown;
  }

  async executeCachedCommand(event, { name, getOrFetch, getCached, errorLabel }) {
    log(`Executing /${name} in ${event.conversationId}...`);
    try {
      const cacheObj = this[`${name}Cache`];
      const cached = typeof getCached === 'function' ? getCached() : cacheObj?.text;
      if (cached) {
        // 1. Output the cached message immediately
        const replyRes = await sendReply(event.conversationId, event, cached);
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});

        // 2. Start a fresh background fetch and update the message if it differs
        (async () => {
          try {
            const freshText = await getOrFetch({ force: true });
            if (freshText && JSON.stringify(freshText) !== JSON.stringify(cached) && replyRes?.ok && replyRes.value) {
              const serverMsgId = replyRes.value.timestamp || replyRes.value.messageId;
              log(`Updating /${name} reply (msg ${serverMsgId}) in ${event.conversationId} with fresh data`);
              await updateReply(event.conversationId, serverMsgId, event, freshText);
            }
          } catch (err) {
            log(`Background refresh for /${name} failed: ${err.message}`);
          }
        })();
        return;
      }

      // No cache yet: fetch synchronously
      const freshText = await getOrFetch({ force: true });
      await sendReply(event.conversationId, event, freshText);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
    } catch (err) {
      log(`${errorLabel} failed: ${err.message}`);
      await sendReply(
        event.conversationId,
        event,
        `❌ Failed to fetch ${errorLabel.toLowerCase()}: ${err.message}`
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    }
  }

  async executeMrsCommand(event, args = []) {
    const parsed = parseMrsArgs(args, event, this.userDirectory);
    await this.executeCachedCommand(event, {
      name: 'mrs',
      getCached: () => (this.mrsCache.data ? this.formatMrsMessage(this.mrsCache.data, parsed) : null),
      getOrFetch: (opts) => this.getOrFetchMrsText({ ...opts, ...parsed }),
      errorLabel: 'Group MRs lookup',
    });
  }

  async getOrFetchAlertsData({ force = false } = {}) {
    if (!this.opsgenie?.isConfigured()) {
      return {
        onCallAlerts: [],
        supportAlerts: [],
        onCallError: 'OpsGenie not configured',
        supportError: 'OpsGenie not configured',
      };
    }
    const now = Date.now();
    if (!force && this.alertsCache.data && now - this.alertsCache.timestamp < this.cacheTtlMs) {
      return this.alertsCache.data;
    }
    if (this.alertsCache.loading) {
      return await this.alertsCache.loading;
    }

    this.alertsCache.loading = (async () => {
      try {
        const data = await this.opsgenie.getAllOpenAlerts();
        this.alertsCache.data = data;
        this.alertsCache.timestamp = Date.now();
        return data;
      } catch (err) {
        if (this.alertsCache.data) {
          log(`Failed to refresh /alerts cache (${err.message}), serving stale cache`);
          return this.alertsCache.data;
        }
        throw err;
      } finally {
        this.alertsCache.loading = null;
      }
    })();

    return await this.alertsCache.loading;
  }

  async getOrFetchAlertsText({ force = false, mode = 'all' } = {}) {
    const data = await this.getOrFetchAlertsData({ force });
    return this.formatAlertsMessage(data, mode);
  }

  /** The /alerts reply: regular markdown, or with rich messages the alerts card. */
  formatAlertsMessage(data, mode = 'all') {
    return this.richCommandMessage(formatAlertsText(data, mode, { rich: this.richMessages }), {
      service: 'opsgenie',
      kind: 'Alerts',
    });
  }

  async executeAlertsCommand(event, args = []) {
    if (!this.opsgenie?.isConfigured()) {
      await sendReply(event.conversationId, event, '❌ OpsGenie integration is not configured.');
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    const sub = (args[0] || '').toLowerCase().replace(/^-+/, '');
    let mode = 'all';
    if (sub === 'oncall' || sub === 'on-call' || sub === 'call') {
      mode = 'oncall';
    } else if (sub === 'support' || sub === 'sup') {
      mode = 'support';
    }

    await this.executeCachedCommand(event, {
      name: 'alerts',
      getCached: () => (this.alertsCache.data ? this.formatAlertsMessage(this.alertsCache.data, mode) : null),
      getOrFetch: (opts) => this.getOrFetchAlertsText({ ...opts, mode }),
      errorLabel: 'OpsGenie alerts lookup',
    });
  }

  async getOrFetchSprintText({ force = false } = {}) {
    if (!this.jira?.isConfigured()) {
      return '❌ Jira integration is not configured.';
    }
    const now = Date.now();
    if (!force && this.sprintCache.text && now - this.sprintCache.timestamp < this.cacheTtlMs) {
      return this.sprintCache.text;
    }
    if (this.sprintCache.loading) {
      return await this.sprintCache.loading;
    }

    this.sprintCache.loading = (async () => {
      try {
        const { total, inProgress, inReview, todo } = await this.jira.getActiveSprintTasks();
        if (total === 0) {
          const text = '🏃 No active sprint tasks found.';
          this.sprintCache.text = text;
          this.sprintCache.timestamp = Date.now();
          return text;
        }

        const formatTaskLine = (t) => {
          const keyRef = t.url ? `[${t.key}](${t.url})` : `**${t.key}**`;
          const mention = this.userDirectory.formatMention(t.assignee);
          return `- ${keyRef}: ${t.summary} (${mention})`;
        };

        const allTasks = [...inProgress, ...inReview, ...todo];
        for (const t of allTasks) {
          if (t.assignee && t.assignee.toLowerCase() !== 'unassigned') {
            this.userDirectory.resolveUser(t.assignee).catch(() => {});
          }
        }

        const sections = [];
        if (inProgress.length > 0) {
          sections.push(`**In Progress** (${inProgress.length}):\n${inProgress.map(formatTaskLine).join('\n')}`);
        }

        if (inReview.length > 0) {
          sections.push(`**In Review** (${inReview.length}):\n${inReview.map(formatTaskLine).join('\n')}`);
        }

        if (todo.length > 0) {
          sections.push(`**To Do** (${todo.length}):\n${todo.map(formatTaskLine).join('\n')}`);
        }

        const text = this.richCommandMessage(
          `🏃 **Current Sprint Tasks** (${total} active):\n\n${sections.join('\n\n')}`,
          { service: 'jira', kind: 'Sprint' }
        );
        this.sprintCache.text = text;
        this.sprintCache.timestamp = Date.now();
        return text;
      } catch (err) {
        if (this.sprintCache.text) {
          log(`Failed to refresh /sprint cache (${err.message}), serving stale cache`);
          return this.sprintCache.text;
        }
        throw err;
      } finally {
        this.sprintCache.loading = null;
      }
    })();

    return await this.sprintCache.loading;
  }

  async executeSprintCommand(event) {
    if (!this.jira?.isConfigured()) {
      await sendReply(
        event.conversationId,
        event,
        '❌ Jira integration is not configured.'
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    await this.executeCachedCommand(event, {
      name: 'sprint',
      getOrFetch: (opts) => this.getOrFetchSprintText(opts),
      errorLabel: 'Sprint tasks lookup',
    });
  }

  async getOrFetchMeetingsText({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.meetingsCache.text && now - this.meetingsCache.timestamp < this.cacheTtlMs) {
      return this.meetingsCache.text;
    }
    if (this.meetingsCache.loading) {
      return await this.meetingsCache.loading;
    }

    this.meetingsCache.loading = (async () => {
      try {
        const nowDate = new Date();
        const endOfWeek = new Date(nowDate);
        const day = endOfWeek.getDay();
        const diffToSunday = (7 - day) % 7;
        endOfWeek.setDate(endOfWeek.getDate() + diffToSunday);
        endOfWeek.setHours(23, 59, 59, 999);

        let res = await getCalendarView({
          startDate: nowDate.toISOString(),
          endDate: endOfWeek.toISOString(),
          limit: 50,
        });

        if (!res.ok) {
          throw new Error(res.error?.message || 'Calendar view request failed');
        }

        let meetings = (res.value?.meetings || []).filter(
          (m) => m.myResponse !== 'Declined'
        );

        let isNextWeek = false;
        if (meetings.length === 0) {
          // No more meetings for the rest of this week -> fetch next week's meetings
          const nextWeekStart = new Date(endOfWeek.getTime() + 1); // Next Monday 00:00:00.000
          const nextWeekEnd = new Date(nextWeekStart);
          nextWeekEnd.setDate(nextWeekEnd.getDate() + 6);
          nextWeekEnd.setHours(23, 59, 59, 999);

          const nextRes = await getCalendarView({
            startDate: nextWeekStart.toISOString(),
            endDate: nextWeekEnd.toISOString(),
            limit: 50,
          });

          if (nextRes.ok) {
            meetings = (nextRes.value?.meetings || []).filter((m) => m.myResponse !== 'Declined');
            isNextWeek = true;
          }
        }

        let text;
        if (meetings.length === 0) {
          text = '📅 No upcoming meetings scheduled for this week or next week.';
        } else {
          meetings.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

          const byDate = new Map();
          for (const m of meetings) {
            const start = new Date(m.startTime);
            const dateKey = start.toLocaleDateString('en-GB', {
              weekday: 'long',
              month: 'short',
              day: 'numeric',
              timeZone: 'Europe/Berlin',
            });
            if (!byDate.has(dateKey)) {
              byDate.set(dateKey, []);
            }
            byDate.get(dateKey).push(m);
          }

          const sections = [];
          for (const [dateStr, dayMeetings] of byDate.entries()) {
            const lines = [`**${dateStr}**:`];
            for (const m of dayMeetings) {
              const startStr = new Date(m.startTime).toLocaleTimeString('en-GB', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Europe/Berlin',
              });
              const endStr = new Date(m.endTime).toLocaleTimeString('en-GB', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Europe/Berlin',
              });
              const organizer = m.organizer?.name ? ` _(${m.organizer.name})_` : '';
              const link = m.joinUrl || (m.threadId ? `https://teams.microsoft.com/l/chat/${encodeURIComponent(m.threadId)}/0` : null);
              const subjectRef = link ? `[${m.subject}](${link})` : `**${m.subject}**`;
              lines.push(`- ${startStr} - ${endStr}: ${subjectRef}${organizer}`);
            }
            sections.push(lines.join('\n'));
          }

          const header = isNextWeek
            ? '📅 **Meetings for next week** (none remaining this week)'
            : '📅 **Meetings for the rest of the week**';

          text = `${header} (${meetings.length}):\n\n${sections.join('\n\n')}`;
        }

        const message = this.richCommandMessage(text, { service: 'calendar', kind: 'Meetings' });
        this.meetingsCache.text = message;
        this.meetingsCache.timestamp = Date.now();
        return message;
      } catch (err) {
        if (this.meetingsCache.text) {
          log(`Failed to refresh /meetings cache (${err.message}), serving stale cache`);
          return this.meetingsCache.text;
        }
        throw err;
      } finally {
        this.meetingsCache.loading = null;
      }
    })();

    return await this.meetingsCache.loading;
  }

  async executeMeetingsCommand(event) {
    await this.executeCachedCommand(event, {
      name: 'meetings',
      getOrFetch: (opts) => this.getOrFetchMeetingsText(opts),
      errorLabel: 'Calendar meetings lookup',
    });
  }

  async executeExecCommand(event, args) {
    const cmd = args.join(' ').trim();
    const trollUser = this.config.teams?.troll_user;
    const senderMri = event.fromMri || '';
    const isTroll = trollUser && (senderMri === trollUser || senderMri.endsWith(trollUser.split(':').pop()));

    log(`Executing /exec from ${event.from || senderMri} (troll=${Boolean(isTroll)}) in ${event.conversationId}: ${cmd}`);

    if (isTroll) {
      const emojis = ['🤡', '🥑', '👾', '🚀', '🍄', '🦖', '🦥', '🌯', '🎪', '🍕', '🧨', '👻', '🦄', '🍹', '🎲', '🧶'];
      const shuffled = [...emojis].sort(() => 0.5 - Math.random());
      const selected = shuffled.slice(0, 3).join(' ');
      await sendReply(event.conversationId, event, `${selected}: command not found`);
      this.setCommandReaction(event.conversationId, event.messageId, 'like').catch(() => {});
      return;
    }

    if (!cmd) {
      await sendReply(event.conversationId, event, '`$ `\n\n```\n[exec] No command specified\n```');
    } else {
      await sendReply(
        event.conversationId,
        event,
        `\`$ ${escapeHtml(cmd)}\`\n\n\`\`\`\n[exec] Process finished with exit code 0\n\`\`\``
      );
    }
    this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
  }

  isAdmin(event) {
    if (!event) return false;
    const senderOid = extractUserOid(event.fromMri || event.sender?.mri);
    if (senderOid) {
      if (this.selfOid && senderOid === this.selfOid) {
        return true;
      }
      if (this.adminOids && this.adminOids.has(senderOid)) {
        return true;
      }
    }
    if (this.selfMri) {
      const rawMri = String(event.fromMri || event.sender?.mri || '').trim().toLowerCase();
      const selfMriNorm = this.selfMri.toLowerCase().trim();
      if (rawMri && rawMri === selfMriNorm) {
        return true;
      }
    }
    return false;
  }

  respondNotPrivileged(event) {
    const user = event.from || event.sender?.displayName || 'user';
    return `\`\`\`\n${user} is not in the sudoers file.  This incident will be reported.\n\`\`\``;
  }

  async executeAdminCommand(event, args = []) {
    if (!this.isAdmin(event)) {
      log.warn(`Unauthorized /sudo attempt from ${event.from || event.fromMri} in ${event.conversationId}`);
      await sendReply(event.conversationId, event, this.respondNotPrivileged(event));
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    const sub = (args[0] || '').toLowerCase().trim();
    if (sub === 'restart') {
      await this.executeRestartCommand(event);
    } else if (sub === 'reauth' || sub === 'refresh') {
      await this.executeReauthCommand(event);
    } else if (sub === 'status') {
      await this.executeAdminStatusCommand(event);
    } else if (sub === 'glab' || sub === 'gitlab' || sub === 'token') {
      await this.executeRenewGitLabTokenCommand(event);
    } else if (sub === 'renew' || sub === 'rotate') {
      await this.executeRenewGitLabTokenCommand(event);
    } else if (sub === 'kick') {
      await this.executeKickCommand(event, args.slice(1));
    } else if (sub === 'ban') {
      await this.executeBanCommand(event, args.slice(1));
    } else if (sub === 'unban') {
      await this.executeUnbanCommand(event, args.slice(1));
    } else if (sub === 'bans') {
      await this.executeBansCommand(event);
    } else {
      const text =
        '🔧 **teams-live sudo commands**:\n\n' +
        '- `/sudo restart`: Restarts the teams-live daemon.\n' +
        '- `/sudo reauth` (or `/sudo refresh`): Forces token refresh and shows status.\n' +
        '- `/sudo status`: Shows service runtime metrics, memory, and token auth health.\n' +
        '- `/sudo glab renew` (or `/sudo renew glab`, `/sudo token renew`): Rotates the GitLab personal access token and saves to writable override if needed.\n' +
        '- `/sudo kick <nick> [reason]`: Ejects a user from the channel.\n' +
        '- `/sudo ban <nick>`: Bans a user (bot ignores messages and only reacts with ⛔).\n' +
        '- `/sudo unban <nick>`: Unbans a user.\n' +
        '- `/sudo bans` (or `/sudo ban list`): Lists banned users.\n\n' +
        '_Alias: `/admin`_';
      await sendReply(event.conversationId, event, text);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
    }
  }

  async executeAdminStatusCommand(event) {
    log(`Executing admin /status in ${event.conversationId}...`);
    const uptimeSec = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSec / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const seconds = uptimeSec % 60;
    const uptimeStr = `${hours > 0 ? `${hours}h ` : ''}${minutes}m ${seconds}s`;
    const memRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const heapUsed = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

    const convCount = this.watchedConversations.size;
    const watchedMrsCount = this.watched.size;
    const completedCount = this.completedMessages.size;

    const conn = await this.getConnectorsStatus();

    const teamsIcon = conn.teams.status === 'ok' ? '🟢' : '❌';
    const glIcon = conn.gitlab.status === 'ok' ? '🟢' : (conn.gitlab.status === 'unconfigured' ? '⚪' : '❌');
    const jiraIcon = conn.jira.status === 'ok' ? '🟢' : (conn.jira.status === 'unconfigured' ? '⚪' : '❌');
    const confIcon = conn.confluence?.status === 'ok' ? '🟢' : (conn.confluence?.status === 'unconfigured' ? '⚪' : '❌');
    const ogIcon = conn.opsgenie.status === 'ok' ? '🟢' : (conn.opsgenie.status === 'unconfigured' ? '⚪' : '❌');
    const haIcon = conn.homeassistant?.status === 'ok' ? '🟢' : (conn.homeassistant?.status === 'unconfigured' ? '⚪' : '❌');
    const ssIcon = conn.screenshot?.status === 'ok' ? '🟢' : (conn.screenshot?.status === 'unconfigured' ? '⚪' : '❌');

    const text =
      '🔧 **teams-live status (sudo)**:\n\n' +
      `- ⏱️ **Uptime**: ${uptimeStr} (PID ${process.pid})\n` +
      `- 💾 **Memory**: ${memRss} MB RSS (${heapUsed} MB Heap)\n` +
      `- 💬 **Watched Channels**: ${convCount}\n` +
      `- 👀 **Active MR Watchers**: ${watchedMrsCount}\n` +
      `- ⚡ **Precompute Cache**:\n` +
      this.getPrecomputeCacheLines().join('\n') + '\n' +
      `- 📬 **Completed Messages**: ${completedCount}\n\n` +
      '🔌 **Connectors**:\n' +
      `- 💬 **Microsoft Teams**: ${teamsIcon} ${conn.teams.status === 'ok' ? 'Connected' : 'Disconnected'}\n` +
      `  - **User**: ${conn.teams.user}\n` +
      `  - **Status**: ${conn.teams.details}\n` +
      `- 🦊 **GitLab**: ${glIcon} ${conn.gitlab.status === 'ok' ? 'Connected' : (conn.gitlab.status === 'unconfigured' ? 'Not configured' : 'Auth Expired / Error')}\n` +
      `  - **Host**: \`${conn.gitlab.host}\`${conn.gitlab.group ? ` (group: \`${conn.gitlab.group}\`)` : ''}\n` +
      (conn.gitlab.webhook ? `  - **Webhook**: ${conn.gitlab.webhook}\n` : '') +
      (conn.gitlab.webhookLastReceived ? `  - **Last Webhook**: ${conn.gitlab.webhookLastReceived}\n` : '') +
      (conn.gitlab.configured ? `  - **User**: ${conn.gitlab.user}\n` : '') +
      (conn.gitlab.tokenExpiry ? `  - **Token**: ${conn.gitlab.tokenExpiry}\n` : '') +
      (conn.gitlab.tokenOverride ? `  - **Token Override**: ⚠️ Loaded from \`${conn.gitlab.tokenOverride}\`\n` : '') +
      (conn.gitlab.error ? `  - **Error**: \`${conn.gitlab.error}\`\n` : '') +
      `- 📋 **Jira**: ${jiraIcon} ${conn.jira.status === 'ok' ? 'Connected' : (conn.jira.status === 'unconfigured' ? 'Not configured' : 'Auth Expired / Error')}\n` +
      (conn.jira.configured ? `  - **URL**: \`${conn.jira.url}\` (project: \`${conn.jira.project}\`)\n` +
                              `  - **User**: ${conn.jira.user}\n` : '') +
      (conn.jira.error ? `  - **Error**: \`${conn.jira.error}\`\n` : '') +
      `- 📄 **Confluence**: ${confIcon} ${conn.confluence?.status === 'ok' ? 'Connected' : (conn.confluence?.status === 'unconfigured' ? 'Not configured' : 'Auth Expired / Error')}\n` +
      (conn.confluence?.configured ? `  - **URL**: \`${conn.confluence.url}\`\n` +
                                     `  - **User**: ${conn.confluence.user}\n` : '') +
      (conn.confluence?.error ? `  - **Error**: \`${conn.confluence.error}\`\n` : '') +
      `- 🚨 **OpsGenie**: ${ogIcon} ${conn.opsgenie.status === 'ok' ? 'Connected' : (conn.opsgenie.status === 'unconfigured' ? 'Not configured' : 'Auth Expired / Error')}\n` +
      (conn.opsgenie.configured ? `  - **Endpoint**: ${conn.opsgenie.endpoint}\n` +
                                  `  - **Keys**: On-Call ${conn.opsgenie.onCall ? '✅' : '❌'} | Support ${conn.opsgenie.support ? '✅' : '❌'}\n` : '') +
      (conn.opsgenie.error ? `  - **Error**: \`${conn.opsgenie.error}\`\n` : '') +
      `- 🏠 **Home Assistant (HR works)**: ${haIcon} ${conn.homeassistant?.status === 'ok' ? 'Connected' : (conn.homeassistant?.status === 'unconfigured' ? 'Not configured' : 'Auth Expired / Error')}\n` +
      (conn.homeassistant?.configured ? `  - **URL**: \`${conn.homeassistant.url}\`\n` +
                                        `  - **Cache**: ${conn.homeassistant.details}\n` : '') +
      (conn.homeassistant?.error ? `  - **Error**: \`${conn.homeassistant.error}\`\n` : '') +
      `- 📸 **browser-daemon (screenshot)**: ${ssIcon} ${conn.screenshot?.status === 'ok' ? 'Connected' : (conn.screenshot?.status === 'unconfigured' ? 'Not configured' : 'Error')}\n` +
      (conn.screenshot?.configured ? `  - **URL**: \`${conn.screenshot.url}\`\n` : '') +
      (conn.screenshot?.error ? `  - **Error**: \`${conn.screenshot.error}\`\n` : '');

    await sendReply(event.conversationId, event, text);
    this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
  }

  async executeRestartCommand(event) {
    if (!this.isAdmin(event)) {
      log.warn(`Unauthorized /restart attempt from ${event.from || event.fromMri} in ${event.conversationId}`);
      await sendReply(event.conversationId, event, this.respondNotPrivileged(event));
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    log(`Admin /restart issued by ${event.from || event.fromMri} in ${event.conversationId}`);
    await sendReply(
      event.conversationId,
      event,
      '🔄 **Restarting teams-live daemon...** Systemd will restore the service momentarily.'
    );
    this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});

    setTimeout(() => {
      log('Exiting process for systemd restart...');
      process.exit(0);
    }, 1000);
  }

  async executeReauthCommand(event) {
    if (!this.isAdmin(event)) {
      log.warn(`Unauthorized /reauth attempt from ${event.from || event.fromMri} in ${event.conversationId}`);
      await sendReply(event.conversationId, event, this.respondNotPrivileged(event));
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    log(`Admin /reauth issued by ${event.from || event.fromMri} in ${event.conversationId}`);
    try {
      await this.authManager.ensureValidAuth();
      const status = getMessageAuthStatus();
      const text =
        '🔑 **Teams authentication refreshed successfully!**\n\n' +
        `- **Active**: ${status.hasToken ? '✅ Yes' : '❌ No'}\n` +
        `- **Minutes Remaining**: ~${status.minutesRemaining ?? 'unknown'}m\n` +
        `- **Expires**: \`${status.expiresAt || 'unknown'}\``;
      await sendReply(event.conversationId, event, text);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
    } catch (err) {
      log(`Admin /reauth failed: ${err.message}`);
      await sendReply(event.conversationId, event, `❌ Manual reauth failed: ${err.message}`);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    }
  }

  async renewGitLabFallbackToken(index, { expiresAt = null } = {}) {
    const source = this.config.gitlab?.fallback_token_sources?.[index - 1];
    if (!source) throw new Error(`No configured GitLab fallback token at position ${index}`);
    // A token rotated earlier but never saved is saved first: rotating again would revoke it.
    let rotated = this.unsavedFallbackTokens.get(index);
    if (!rotated) {
      rotated = await this.gitlab.rotateToken({ tokenIndex: index, expiresAt });
      if (!rotated?.token) throw new Error('GitLab token rotation response did not include a new token');
      // The old token no longer works: use the new one right away, whatever happens to the disk.
      this.config.gitlab.fallback_tokens[index - 1] = rotated.token;
      this.unsavedFallbackTokens.set(index, rotated);
    }
    try {
      persistFallbackToken(source.override, rotated.token);
    } catch (error) {
      if (error.pendingPath) {
        // Durable in the pending file; the next start loads it.
        this.unsavedFallbackTokens.delete(index);
        log.warn(`GitLab fallback token ${index} saved to ${error.pendingPath} only: ${error.message}`);
        return { rotated, savedPath: error.pendingPath, isReadOnlySecret: true };
      }
      const failure = new Error(
        `GitLab fallback token ${index} was rotated but could not be saved (${error.message}); ` +
        'the new token is only kept in memory and saving is retried'
      );
      failure.rotatedUnsaved = true;
      throw failure;
    }
    this.unsavedFallbackTokens.delete(index);
    return { rotated, savedPath: source.override, isReadOnlySecret: true };
  }

  /**
   * Rotates the primary GitLab token and saves it. Concurrent calls share one rotation: a
   * second rotation would revoke the token the first one just issued.
   */
  async renewGitLabToken(options = {}) {
    if (!this.primaryRenewalInFlight) {
      this.primaryRenewalInFlight = this.performGitLabTokenRenewal(options).finally(() => {
        this.primaryRenewalInFlight = null;
      });
    }
    return this.primaryRenewalInFlight;
  }

  async performGitLabTokenRenewal({ reason = 'manual', expiresAt = null } = {}) {
    if (!this.gitlab?.rotateToken) {
      throw new Error('GitLab client is not configured or does not support token rotation');
    }

    // A token rotated earlier but never saved is saved first: rotating again would revoke it.
    let rotated = this.unsavedPrimaryToken;
    if (rotated) {
      log(`Saving the previously rotated GitLab personal access token (reason: ${reason})...`);
    } else {
      log(`Rotating GitLab personal access token (reason: ${reason})...`);
      rotated = await this.gitlab.rotateToken({ expiresAt });
      if (!rotated?.token) {
        throw new Error('GitLab token rotation response did not include a new token');
      }
      // The old token no longer works: use the new one right away, whatever happens to the disk.
      if (this.config.gitlab) this.config.gitlab.token = rotated.token;
      this.gitlab.token = rotated.token;
      this.unsavedPrimaryToken = rotated;
    }

    const homeDir = process.env.HOME;
    const baseDir =
      (homeDir && homeDir !== '/' && homeDir !== '/root' ? homeDir : null) ||
      this.config.gitlab?.state_dir ||
      process.env.XDG_STATE_HOME ||
      path.join(process.cwd(), 'state');
    const defaultOverridePath = path.join(baseDir, 'overrides', 'gitlab-token');
    const configuredPath = this.config.gitlab?.token_file;
    const loadedOverridePath =
      this.config.gitlab?.is_token_override && this.config.gitlab?.override_token_path
        ? this.config.gitlab.override_token_path
        : null;

    // The first target that accepts the token wins; the override file is the last resort.
    const overridePath = loadedOverridePath || defaultOverridePath;
    const targets = [];
    if (!loadedOverridePath && configuredPath) targets.push({ path: configuredPath, inPlace: true });
    targets.push({ path: overridePath });

    let savedPath;
    try {
      savedPath = persistGitLabToken(rotated.token, {
        pendingPath: fallbackTokenPendingPath(overridePath),
        targets,
      });
    } catch (error) {
      if (!error.pendingPath) {
        const failure = new Error(
          `GitLab token was rotated but could not be saved (${error.message}); ` +
          'the new token is only kept in memory and saving is retried'
        );
        failure.rotatedUnsaved = true;
        throw failure;
      }
      // Durable in the pending file; the next start loads it.
      log.warn(`GitLab token saved to ${error.pendingPath} only: ${error.message}`);
      this.unsavedPrimaryToken = null;
      this.afterGitLabTokenRotation();
      return { rotated, savedPath: error.pendingPath, isReadOnlySecret: true };
    }
    this.unsavedPrimaryToken = null;

    const isReadOnlySecret = savedPath !== configuredPath;
    if (isReadOnlySecret && this.config.gitlab) {
      this.config.gitlab.is_token_override = true;
      this.config.gitlab.override_token_path = savedPath;
    }

    log(`GitLab personal access token successfully rotated and saved to ${savedPath} (isOverride=${isReadOnlySecret}, new expiry=${rotated.expires_at})`);
    this.afterGitLabTokenRotation();

    return {
      rotated,
      savedPath,
      isReadOnlySecret,
    };
  }

  afterGitLabTokenRotation() {
    this.lastGitLabExpiryWarningAt = 0;
    this.pendingTokenRenewalMessageIds.clear();
    this.saveState();
  }

  async executeRenewGitLabTokenCommand(event) {
    if (!this.isAdmin(event)) {
      log.warn(`Unauthorized GitLab token renewal attempt from ${event.from || event.fromMri} in ${event.conversationId}`);
      await sendReply(event.conversationId, event, this.respondNotPrivileged(event));
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    log(`Admin GitLab token renewal requested by ${event.from || event.fromMri} in ${event.conversationId}`);
    await this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.pending).catch(() => {});

    try {
      let renewal;
      let primaryError;
      try {
        renewal = await this.renewGitLabToken({ reason: 'admin_command' });
      } catch (error) {
        primaryError = error;
      }
      const fallbackResults = [];
      let fallbackFailed = false;
      for (let index = 1; index <= (this.config.gitlab?.fallback_token_sources?.length || 0); index++) {
        try {
          await this.renewGitLabFallbackToken(index);
          fallbackResults.push(`- Fallback ${index}: renewed`);
        } catch (error) {
          fallbackFailed = true;
          fallbackResults.push(`- Fallback ${index}: failed (${error.message})`);
        }
      }
      await this.setCommandReaction(event.conversationId, event.messageId, primaryError || fallbackFailed ? COMMAND_REACTIONS.failure : COMMAND_REACTIONS.success).catch(() => {});
      if (primaryError) {
        const details = [`Primary: failed (${primaryError.message})`, ...fallbackResults].join('\n');
        await sendReply(event.conversationId, event, `❌ **GitLab token renewal incomplete**\n\n${details}`);
        return;
      }

      let text =
        '✅ **GitLab Personal Access Token Renewed Successfully!**\n\n' +
        `- **New Expiry**: ${renewal.rotated?.expires_at || 'unknown'}\n`;

      if (renewal.isReadOnlySecret) {
        text +=
          `- **Saved to Override**: \`${renewal.savedPath}\`\n\n` +
          '⚠️ **Action Required**: The configured secret path (`' + (this.config.gitlab?.token_file || 'read-only') + '`) is read-only (e.g. deployed via SOPS/NixOS).\n' +
          'Please update the secret in your host configuration (`nixos-config-private`) so future rebuilds don\'t revert to the old token:\n' +
          `\`cat ${renewal.savedPath}\`\n` +
          'The override will be loaded automatically on startup until then.';
      } else {
        text += `- **Saved to**: \`${renewal.savedPath}\``;
      }

      if (fallbackResults.length) text += `\n\n${fallbackResults.join('\n')}`;
      await sendReply(event.conversationId, event, text);
    } catch (err) {
      log(`GitLab token renewal failed: ${err.message}`);
      await this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      await sendReply(event.conversationId, event, `❌ Failed to rotate GitLab token: ${err.message}`);
    }
  }

  /** Whole days until a GitLab token's `expires_at` date ends, or null when it is not a usable date. */
  gitLabTokenDaysLeft(expiresAt) {
    const days = Math.ceil((new Date(`${expiresAt}T23:59:59Z`).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    return Number.isFinite(days) ? days : null;
  }

  /** The fallback tokens are checked on their own: a missing or failing primary token never skips them. */
  async checkGitLabFallbackTokenExpiry() {
    for (let index = 1; index <= (this.config.gitlab?.fallback_token_sources?.length || 0); index++) {
      try {
        const retrying = this.unsavedFallbackTokens.has(index);
        let days = null;
        if (!retrying) {
          const info = await this.gitlab.getTokenInfo({ tokenIndex: index });
          if (!info?.expires_at) continue;
          days = this.gitLabTokenDaysLeft(info.expires_at);
          if (days === null) {
            log.warn(`GitLab fallback token ${index} has an unusable expiry date`);
            continue;
          }
        }
        if (retrying || days <= 3) {
          await this.renewGitLabFallbackToken(index);
          const adminConv = this.getAdminConversationId();
          if (adminConv) await sendDirectMessage(adminConv, `🔄 GitLab fallback token ${index} was automatically renewed. Update its configured secret from its override file.`);
        } else if (days <= 10) {
          log.warn(`GitLab fallback token ${index} expires in ${days} days`);
        }
      } catch (error) {
        log.warn(`GitLab fallback token ${index} expiry check or renewal failed: ${error.message}`);
        if (error.rotatedUnsaved) {
          const adminConv = this.getAdminConversationId();
          if (adminConv) await sendDirectMessage(adminConv, `🚨 ${error.message}`).catch(() => {});
        }
      }
    }
  }

  /** Saves a primary token that was rotated but not saved; true when the expiry check can go on. */
  async saveUnsavedGitLabToken() {
    if (!this.unsavedPrimaryToken) return true;
    const adminConv = this.getAdminConversationId();
    try {
      const renewal = await this.renewGitLabToken({ reason: 'save_retry' });
      if (adminConv) {
        await sendDirectMessage(
          adminConv,
          `🔄 The rotated GitLab token is now saved to \`${renewal.savedPath}\`. Update its configured secret from that file.`
        ).catch(() => {});
      }
      return true;
    } catch (error) {
      log.warn(`Saving the rotated GitLab token failed again: ${error.message}`);
      if (adminConv) await sendDirectMessage(adminConv, `🚨 ${error.message}`).catch(() => {});
      return false;
    }
  }

  async checkGitLabTokenExpiryAndAutoRenew() {
    if (!(await this.saveUnsavedGitLabToken())) return;
    if (!this.gitlab?.getTokenInfo) return;
    await this.checkGitLabFallbackTokenExpiry();
    if (!this.gitlab.token) return;
    try {
      const tokenData = await this.gitlab.getTokenInfo();
      if (!tokenData || !tokenData.expires_at) return;

      const expireDate = new Date(`${tokenData.expires_at}T23:59:59Z`);
      const now = new Date();
      const diffMs = expireDate.getTime() - now.getTime();
      const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

      log(`GitLab token expiry check: expires on ${tokenData.expires_at} (~${diffDays} days remaining)`);

      const adminConv = this.getAdminConversationId();

      // Case 1: <= 3 days remaining -> Auto-renew!
      if (diffDays <= 3) {
        log(`GitLab token expires in ${diffDays} days (<= 3d), triggering auto-renewal...`);
        try {
          const renewal = await this.renewGitLabToken({ reason: `auto_renew_${diffDays}d` });
          if (adminConv) {
            let msg =
              '🔄 **GitLab Personal Access Token Auto-Renewed**\n\n' +
              `The GitLab personal access token was expiring in **${diffDays} day${diffDays === 1 ? '' : 's'}** (${tokenData.expires_at}) and has been automatically rotated.\n\n` +
              `- **New Expiry**: ${renewal.rotated?.expires_at || 'unknown'}\n`;

            if (renewal.isReadOnlySecret) {
              msg +=
                `- **Stored in Override**: \`${renewal.savedPath}\`\n\n` +
                '⚠️ **Action Required**: The configured secret path (`' + (this.config.gitlab?.token_file || 'read-only') + '`) is read-only (e.g. deployed via SOPS/NixOS).\n' +
                'Please update the secret in your host configuration (`nixos-config-private`) so future deployments use the new token:\n' +
                `\`cat ${renewal.savedPath}\`\n` +
                'The override file will keep GitLab working across restarts until then.';
            } else {
              msg += `- **Saved to**: \`${renewal.savedPath}\``;
            }

            await sendDirectMessage(adminConv, msg);
          }
          return;
        } catch (err) {
          log(`GitLab token auto-renewal failed: ${err.message}`);
          if (adminConv && err.rotatedUnsaved) {
            await sendDirectMessage(adminConv, `🚨 ${err.message}`).catch(() => {});
          } else if (adminConv) {
            const alertMsg =
              '🚨 **GitLab Token Auto-Renewal Failed!**\n\n' +
              `The GitLab token expires in **${diffDays} day${diffDays === 1 ? '' : 's'}** (${tokenData.expires_at}), but auto-renewal failed:\n` +
              `\`${err.message}\`\n\n` +
              'Please renew manually using `/sudo glab renew`.';
            await sendDirectMessage(adminConv, alertMsg);
          }
          return;
        }
      }

      // Case 2: <= 10 days remaining -> Warning notification to admin!
      if (diffDays <= 10) {
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        if (this.lastGitLabExpiryWarningAt && Date.now() - this.lastGitLabExpiryWarningAt < ONE_DAY_MS) {
          log('Skipping GitLab token expiry warning: last alert was sent < 24h ago');
          return;
        }

        if (adminConv) {
          log.warn(`GitLab token expires in ${diffDays} days (< 10d), sending warning to admin ${adminConv}...`);
          const warningMsg =
            '⚠️ **GitLab Personal Access Token Expiry Warning**\n\n' +
            `The GitLab personal access token will expire in **${diffDays} day${diffDays === 1 ? '' : 's'}** (${tokenData.expires_at}).\n\n` +
            'You can renew it now:\n' +
            '- Run command: `/sudo glab renew`\n' +
            '- Or **react to this message with a 👍 (thumbs up)** emoji to renew automatically!';

          const res = await sendDirectMessage(adminConv, warningMsg);
          this.lastGitLabExpiryWarningAt = Date.now();
          if (res?.ok && res.value) {
            for (const id of [res.value.id, res.value.messageId, res.value.timestamp]) {
              if (id) this.pendingTokenRenewalMessageIds.add(String(id));
            }
          }
          this.saveState();
        }
      }
    } catch (err) {
      log(`Error checking GitLab token expiry: ${err.message}`);
    }
  }

  isSelfOrAdmin(target, event) {
    if (!target) return true;
    const normalized = String(target).toLowerCase().trim().replace(/^@/, '');
    if (['me', 'myself', 'self'].includes(normalized)) {
      return true;
    }

    const targetOid = extractUserOid(target);
    if (targetOid) {
      if (this.selfOid && targetOid === this.selfOid) return true;
      if (this.adminOids && this.adminOids.has(targetOid)) return true;
    }

    const senderMri = String(event?.fromMri || event?.sender?.mri || '').toLowerCase().trim();
    const senderOid = extractUserOid(senderMri);
    if (senderOid && targetOid && senderOid === targetOid) {
      return true;
    }
    if (senderMri && (normalized === senderMri || senderMri.includes(normalized) || normalized.includes(senderMri))) {
      return true;
    }

    if (this.selfMri) {
      const selfMriNorm = this.selfMri.toLowerCase().trim();
      if (normalized === selfMriNorm || selfMriNorm.includes(normalized) || normalized.includes(selfMriNorm)) {
        return true;
      }
    }

    const resolved = this.userDirectory?.findUser(target);
    if (resolved) {
      const resOid = extractUserOid(resolved.mri || resolved.id);
      if (resOid) {
        if (this.selfOid && resOid === this.selfOid) return true;
        if (this.adminOids && this.adminOids.has(resOid)) return true;
      }
      if (this.selfMri && resolved.mri && resolved.mri.toLowerCase() === this.selfMri.toLowerCase()) {
        return true;
      }
    }

    return false;
  }

  isUserBanned(from, fromMri) {
    if (!this.bannedUsers || this.bannedUsers.size === 0) return false;
    const rawFrom = String(from || '').trim().toLowerCase();
    const rawMri = String(fromMri || '').trim().toLowerCase();
    if (!rawFrom && !rawMri) return false;

    for (const [key, ban] of this.bannedUsers.entries()) {
      const banTarget = String(ban.target || key).toLowerCase().trim().replace(/^@/, '');
      const banName = String(ban.name || '').toLowerCase().trim().replace(/^@/, '');
      const banMri = String(ban.mri || '').toLowerCase().trim();

      if (rawMri && banMri && rawMri === banMri) return true;
      if (rawMri && (rawMri === banTarget || rawMri.endsWith(banTarget))) return true;
      if (rawFrom && (rawFrom === banTarget || rawFrom === banName)) return true;
      if (banTarget && rawFrom) {
        const words = rawFrom.split(/\s+/);
        if (words.includes(banTarget) || (banName && words.includes(banName))) return true;
      }
    }
    return false;
  }

  async resolveTargetUser(query) {
    if (!query) return null;
    const clean = String(query).trim().replace(/^@+/, '');
    if (!clean) return null;

    if (this.userDirectory) {
      try {
        const user = await this.userDirectory.resolveUser(clean);
        if (user) {
          return {
            name: user.displayName || clean,
            mri: user.mri && !user.mri.startsWith('user:') ? user.mri : null,
          };
        }
      } catch (err) {
        log(`Error resolving user "${clean}" in userDirectory: ${err.message}`);
      }
    }

    if (this.userInteractions) {
      const cleanLower = clean.toLowerCase();
      for (const u of this.userInteractions.values()) {
        const userName = String(u.name || '').toLowerCase();
        const userMri = String(u.mri || '').toLowerCase();
        if (userName === cleanLower || userMri === cleanLower || (userName && userName.includes(cleanLower))) {
          return {
            name: u.name || clean,
            mri: u.mri || null,
          };
        }
      }
    }

    return null;
  }

  async resolveTargetWithReason(args = []) {
    const full = args.join(' ').trim();
    if (!full) return { target: '', resolved: null, reason: '' };

    // 1. Try full string first (e.g. "@Jane Doe" or "Jane Doe" or "jane")
    const resolved = await this.resolveTargetUser(full);
    if (resolved) {
      return { target: full, resolved, reason: '' };
    }

    // 2. If multi-word and not resolved, try prefixes from longest to shortest for reason suffix
    if (args.length > 1) {
      for (let i = args.length - 1; i >= 1; i--) {
        const candidate = args.slice(0, i).join(' ').trim();
        const found = await this.resolveTargetUser(candidate);
        if (found) {
          return {
            target: candidate,
            resolved: found,
            reason: args.slice(i).join(' ').trim(),
          };
        }
      }
    }

    return { target: full, resolved: null, reason: '' };
  }

  async executeBanCommand(event, args = []) {
    const rawTarget = args.join(' ').trim();
    if (!rawTarget || rawTarget.toLowerCase() === 'list') {
      return await this.executeBansCommand(event);
    }

    if (this.isSelfOrAdmin(rawTarget, event)) {
      await sendReply(event.conversationId, event, '❌ You cannot ban yourself.');
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    const { target, resolved, reason } = await this.resolveTargetWithReason(args);
    if (!resolved) {
      await sendReply(event.conversationId, event, `❌ Could not find user **${escapeHtml(rawTarget)}**.`);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    if (
      this.isSelfOrAdmin(target, event) ||
      this.isSelfOrAdmin(resolved.name, event) ||
      (resolved.mri && this.isSelfOrAdmin(resolved.mri, event))
    ) {
      await sendReply(event.conversationId, event, '❌ You cannot ban yourself.');
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    const cleanTarget = target.replace(/^@/, '');
    const cleanLower = cleanTarget.toLowerCase();
    const resolvedNameLower = (resolved.name || '').toLowerCase();
    const resolvedMriLower = (resolved.mri || '').toLowerCase();

    // Check if already banned
    for (const [key, ban] of this.bannedUsers.entries()) {
      const banTarget = String(ban.target || key).toLowerCase().replace(/^@/, '');
      const banName = String(ban.name || '').toLowerCase().replace(/^@/, '');
      const banMri = String(ban.mri || '').toLowerCase();
      if (
        cleanLower === banTarget ||
        cleanLower === banName ||
        (banMri && cleanLower === banMri) ||
        (resolvedNameLower && (resolvedNameLower === banName || resolvedNameLower === banTarget)) ||
        (resolvedMriLower && banMri && resolvedMriLower === banMri)
      ) {
        await sendReply(event.conversationId, event, `⚠️ **${escapeHtml(ban.name || ban.target)}** is already banned.`);
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.warning).catch(() => {});
        return;
      }
    }

    const banKey = (resolved.mri || resolved.name || cleanTarget).toLowerCase().replace(/^@/, '');
    const banRecord = {
      target: cleanTarget,
      name: resolved.name,
      mri: resolved.mri || undefined,
      bannedAt: Date.now(),
      bannedBy: event.from || 'Admin',
      reason: reason || undefined,
    };

    this.bannedUsers.set(banKey, banRecord);
    this.saveState();

    log(`Banned user ${resolved.name} (${resolved.mri || 'no-mri'}) by ${event.from} in ${event.conversationId}`);
    await sendReply(
      event.conversationId,
      event,
      `🔨 **${escapeHtml(resolved.name)}** was banned from the conversation. All future messages will be rejected with ⛔.`
    );
    this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
  }

  async executeUnbanCommand(event, args = []) {
    const target = args.join(' ').trim();
    if (!target) {
      await sendReply(event.conversationId, event, '❌ Usage: `/sudo unban <nick>`');
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    const cleanLower = target.replace(/^@/, '').toLowerCase();
    let foundKey = null;
    let foundBan = null;

    for (const [key, ban] of this.bannedUsers.entries()) {
      const banTarget = String(ban.target || key).toLowerCase().replace(/^@/, '');
      const banName = String(ban.name || '').toLowerCase().replace(/^@/, '');
      const banMri = String(ban.mri || '').toLowerCase();
      if (
        cleanLower === banTarget ||
        cleanLower === banName ||
        (banMri && cleanLower === banMri) ||
        banName.includes(cleanLower) ||
        banTarget.includes(cleanLower)
      ) {
        foundKey = key;
        foundBan = ban;
        break;
      }
    }

    if (!foundKey) {
      await sendReply(event.conversationId, event, `❌ User **${escapeHtml(target)}** is not in the ban list.`);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    this.bannedUsers.delete(foundKey);
    this.saveState();

    log(`Unbanned user ${foundBan.name || foundBan.target} by ${event.from} in ${event.conversationId}`);
    await sendReply(
      event.conversationId,
      event,
      `✅ **${escapeHtml(foundBan.name || foundBan.target)}** was unbanned.`
    );
    this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
  }

  async executeBansCommand(event) {
    log(`Listing banned users in ${event.conversationId}...`);
    if (!this.bannedUsers || this.bannedUsers.size === 0) {
      await sendReply(
        event.conversationId,
        event,
        '📋 **Banned users**:\n\n_No users are currently banned._'
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
      return;
    }

    const lines = [`📋 **Banned users** (${this.bannedUsers.size}):\n`];
    for (const ban of this.bannedUsers.values()) {
      const dateStr = ban.bannedAt ? new Date(ban.bannedAt).toLocaleDateString('sv-SE') : '';
      const mriStr = ban.mri ? ` (\`${ban.mri}\`)` : '';
      const byStr = ban.bannedBy ? ` by ${escapeHtml(ban.bannedBy)}` : '';
      const datePart = dateStr ? ` on ${dateStr}` : '';
      lines.push(`- ⛔ **${escapeHtml(ban.name || ban.target)}**${mriStr}${byStr}${datePart}`);
    }

    lines.push('\n_Use `/sudo unban <nick>` to remove a ban._');
    await sendReply(event.conversationId, event, lines.join('\n'));
    this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
  }

  async executeKickCommand(event, args = []) {
    const rawTarget = args.join(' ').trim();
    if (!rawTarget) {
      await sendReply(event.conversationId, event, '❌ Usage: `/sudo kick <nick>`');
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    if (this.isSelfOrAdmin(rawTarget, event)) {
      await sendReply(event.conversationId, event, '❌ You cannot kick yourself.');
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    const { target, resolved, reason } = await this.resolveTargetWithReason(args);
    if (!resolved) {
      await sendReply(event.conversationId, event, `❌ Could not find user **${escapeHtml(rawTarget)}**.`);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    if (
      this.isSelfOrAdmin(target, event) ||
      this.isSelfOrAdmin(resolved.name, event) ||
      (resolved.mri && this.isSelfOrAdmin(resolved.mri, event))
    ) {
      await sendReply(event.conversationId, event, '❌ You cannot kick yourself.');
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    const targetName = resolved.name || target.replace(/^@/, '');
    log(`Executing /kick for ${targetName} (${resolved.mri || 'no-mri'}) in ${event.conversationId}...`);
    const reasonSuffix = reason ? ` (${escapeHtml(reason)})` : '';
    await sendReply(
      event.conversationId,
      event,
      `👢 *${escapeHtml(targetName)} was kicked from the conversation.*${reasonSuffix}`
    );
    this.setCommandReaction(event.conversationId, event.messageId, 'like').catch(() => {});
  }

  async executeMarcoCommand(event) {
    const sender = event.from || 'friend';
    log(`Executing /marco from ${sender} in ${event.conversationId}...`);
    await sendReply(event.conversationId, event, `🏊 **POLO!**`);
    this.setCommandReaction(event.conversationId, event.messageId, 'like').catch(() => {});
  }

  async executeSnakeCommand(event) {
    const { conversationId } = event;
    log(`Executing /snake in ${conversationId}...`);

    // One game at a time across all conversations: the edit rate limit is per account
    if (this.snakeRunning) {
      await sendReply(conversationId, event, '🐍 A snake game is already running, try again in a minute.');
      this.setCommandReaction(conversationId, event.messageId, COMMAND_REACTIONS.warning).catch(() => {});
      return;
    }

    this.snakeRunning = true;
    const game = new SnakeGame();
    const sent = await sendReply(conversationId, event, game.render());
    const serverMessageId = sent.ok ? sent.value?.timestamp : null;
    if (!serverMessageId) {
      this.snakeRunning = false;
      log(`/snake: sending the first frame failed: ${sent.error?.message}`);
      this.setCommandReaction(conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    // Animate in the background so the event loop keeps handling other messages
    this.playSnake(game, event, serverMessageId)
      .catch((err) => log(`/snake: ${err.message}`))
      .finally(() => {
        this.snakeRunning = false;
      });
  }

  async playSnake(game, event, serverMessageId) {
    const { conversationId } = event;
    let failures = 0;
    for (let i = 0; i < SNAKE_FRAMES && !game.dead && failures < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, SNAKE_FRAME_DELAY_MS));
      game.step();
      const res = await updateReply(conversationId, serverMessageId, event, game.render(game.dead ? 'GAME OVER' : ''));
      if (!res.ok) {
        failures++;
        log(`/snake: edit failed: ${res.error?.message}`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    await updateReply(conversationId, serverMessageId, event, game.render(game.dead ? 'GAME OVER' : 'fin'));
    this.setCommandReaction(conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
  }

  /** The plain-text leaderboard (regular mode, and the fallback copy of the card). */
  formatLeaderboardMarkdown(sortedUsers) {
    if (sortedUsers.length === 0) return '🏆 **Bot Interaction Leaderboard**:\n\n_No interactions recorded yet._';
    const medals = ['🥇', '🥈', '🥉'];
    const lines = sortedUsers.map((u, i) => {
      const rankBadge = i < medals.length ? medals[i] : `\`#${i + 1}\``;
      const topCmds = Object.entries(u.commands || {})
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([cmd, cnt]) => `${cmd} (${cnt})`)
        .join(', ');
      const cmdBreakdown = topCmds ? ` _(top: ${topCmds})_` : '';
      return `${rankBadge} **${u.name}**: ${u.count} interaction${u.count === 1 ? '' : 's'}${cmdBreakdown}`;
    });
    return `🏆 **Bot Interaction Leaderboard**:\n\n${lines.join('\n')}`;
  }

  /**
   * The leaderboard as a card with profile pictures. Pictures go to the best
   * ranked users first and only as many as fit the wire limit (the card itself
   * is small, so unlike a list there is usually room for all of them).
   */
  leaderboardMessage(sortedUsers) {
    const markdown = this.formatLeaderboardMarkdown(sortedUsers.slice(0, LEADERBOARD_MAX_ENTRIES));
    // Every user counts towards the totals; only the top ones are shown (and get a picture).
    const entries = sortedUsers.map((u, i) => ({
      name: u.name,
      count: u.count,
      commands: u.commands,
      avatar:
        i >= LEADERBOARD_MAX_ENTRIES || this.suppressAvatars || !this.avatarService
          ? undefined
          : this.avatarService.peekOrPlaceholder({ name: u.name, mri: u.mri }, { size: leaderboardAvatarSize(i) }),
    }));
    const build = (withPictures) =>
      buildLeaderboardCard({ entries: entries.map((e, i) => (i < withPictures ? e : { ...e, avatar: undefined })), fallbackText: markdown });
    const message = (withPictures) => makeRichMessage(markdown, build(withPictures));
    try {
      const pictures = entries.filter((e) => e.avatar).length;
      // Fewer pictures until the card fits, starting from the lowest rank.
      for (let k = Math.min(entries.length, LEADERBOARD_MAX_ENTRIES); k >= 0; k -= 1) {
        const candidate = message(k);
        if (richMessageWireBytes(candidate) <= MAX_CARD_BYTES) {
          if (k < pictures) log(`Leaderboard card too large with pictures, showing the first ${k}`);
          return candidate;
        }
      }
    } catch (e) {
      log(`building the leaderboard card failed, using plain text: ${e.message}`);
    }
    return markdown;
  }

  /** Fetches the pictures of the ranked users (bounded, cached, one deadline for all). */
  async prefetchLeaderboardAvatars(sortedUsers) {
    if (!this.avatarService) return;
    try {
      const top = sortedUsers.slice(0, LEADERBOARD_MAX_ENTRIES);
      const bySize = new Map();
      top.forEach((u, i) => {
        const size = leaderboardAvatarSize(i);
        if (!bySize.has(size)) bySize.set(size, []);
        bySize.get(size).push({ name: u.name, mri: u.mri });
      });
      await Promise.all([...bySize].map(([size, people]) => this.avatarService.avatarsFor(people, { size, deadlineMs: MRS_LIST_AVATAR_DEADLINE_MS })));
    } catch (e) {
      log.warn(`profile picture lookup failed: ${e.message}`);
    }
  }

  async executeLeaderboardCommand(event) {
    log(`Executing /leaderboard in ${event.conversationId}...`);
    const users = [...(this.userInteractions?.values() ?? [])];
    let reply;
    if (this.richMessages) {
      // The card ranks ties by name; rank here the same way so a picture goes with its row.
      const ranked = rankLeaderboard(users).ranked;
      await this.prefetchLeaderboardAvatars(ranked);
      reply = this.leaderboardMessage(ranked);
    } else {
      reply = this.formatLeaderboardMarkdown(users.sort((a, b) => (b.count || 0) - (a.count || 0)));
    }
    await sendReply(event.conversationId, event, reply);
    this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
  }

  async executeAboutCommand(event) {
    log(`Executing /about in ${event.conversationId}...`);
    await sendReply(event.conversationId, event, ABOUT_TEXT);
    this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
  }

  /** Whether an optional command family (a catalogue entry that `requires` it) is available. */
  hasHelpFeature(feature) {
    return Boolean(this.helpFeatures?.has?.(feature));
  }

  /**
   * The help as cards: the commands grouped by domain (see card-help.mjs). One
   * card when it fits the wire limit, else whole domains packed into as few
   * cards as possible, in order. Returns null when no card can carry it (the
   * caller then sends the plain markdown, which is split like any text).
   */
  helpMessages(category, markdown) {
    const match = findHelpCategory(category);
    if (match === undefined) return null;
    const has = (feature) => this.hasHelpFeature(feature);
    const shown = availableHelpCategories(match ? [match] : COMMAND_CATEGORIES, has);
    if (shown.length === 0) return null;
    const single = Boolean(match);
    // Each card carries the plain markdown of its own domains as its fallback text; the notes go
    // under the last one. A group is measured with the notes, so the last card surely fits.
    const message = (categories, part, withNotes) => {
      const fallbackText = single ? markdown : helpMarkdown(categories, { notes: withNotes });
      return makeRichMessage(fallbackText, buildHelpCard(categories, { part, single, notes: single || !withNotes ? [] : HELP_NOTES, fallbackText }));
    };
    // The longest part label ("Help 10/10") and the notes are included, so the real cards surely fit.
    const fits = (categories) => richMessageWireBytes(message(categories, [10, 10], true)) <= MAX_CARD_BYTES;
    try {
      const groups = splitHelpCategories(shown, fits);
      if (!groups) return null;
      return groups.map((categories, i) => message(categories, [i + 1, groups.length], i === groups.length - 1));
    } catch (e) {
      log(`building the help card failed, using plain text: ${e.message}`);
      return null;
    }
  }

  async executeHelpCommand(event, args = []) {
    log(`Executing /help in ${event.conversationId}...`);
    const category = args[0] || null;
    const text = buildHelpText(category, (feature) => this.hasHelpFeature(feature));
    const cards = this.richMessages ? this.helpMessages(category, text) : null;
    if (cards) {
      for (const [index, card] of cards.entries()) {
        await sendReply(event.conversationId, event, card, index === 0 ? {} : { noUpdate: true });
      }
    } else {
      await sendReply(event.conversationId, event, text);
    }
    this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
  }

  async executeOnCallCommand(event) {
    if (!this.opsgenie?.isConfigured()) {
      await sendReply(event.conversationId, event, '❌ OpsGenie integration is not configured.');
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    try {
      let onCallDuty = this.alertsCache.data?.onCallDuty;
      let supportDuty = this.alertsCache.data?.supportDuty;
      const now = Date.now();

      if (!onCallDuty || !supportDuty || now - this.alertsCache.timestamp > this.cacheTtlMs) {
        const [onCallRes, supportRes] = await Promise.all([
          this.opsgenie.fetchOnDuty(this.opsgenie.onCallKey, this.opsgenie.onCallScheduleId).catch(() => []),
          this.opsgenie.fetchOnDuty(this.opsgenie.supportKey, this.opsgenie.supportScheduleId).catch(() => []),
        ]);
        onCallDuty = onCallRes;
        supportDuty = supportRes;
      }

      const onCallPerson = formatOnDuty(onCallDuty);
      const supportPerson = formatOnDuty(supportDuty);

      const text =
        '📞 **On-Call Responders**\n\n' +
        `- 🚨 **CKS Platform**: **${onCallPerson}**\n` +
        `- 💼 **Support Queue**: **${supportPerson}**`;

      // The responders with their pictures, looked up by the address OpsGenie knows (the name derived from it may
      // be spelled differently from the Teams one, e.g. without umlauts).
      const responders = (list) =>
        (Array.isArray(list) ? list : []).map((p) => ({ name: humanizeRecipient(p), email: String(p).includes('@') ? String(p) : undefined })).filter((p) => p.name);
      const queues = [
        { label: 'CKS Platform', people: responders(onCallDuty) },
        { label: 'Support Queue', people: responders(supportDuty) },
      ];
      let avatars = {};
      if (this.richMessages && this.avatarService && !this.suppressAvatars) {
        try {
          avatars = await this.avatarService.avatarsFor(queues.flatMap((q) => q.people));
        } catch {
          avatars = {};
        }
      }
      // Initials for a responder without a photo (as on the dashboard), so every row has a picture.
      if (this.richMessages && this.avatarService && !this.suppressAvatars) {
        for (const p of queues.flatMap((q) => q.people)) {
          if (!isImageDataUri(avatars[p.name])) avatars[p.name] = fallbackAvatar(p.name);
        }
      }
      const message = this.richMessage(text, () =>
        buildOnCallCard({ queues: queues.map((q) => ({ label: q.label, people: q.people.map((p) => p.name), avatars })), fallbackText: text })
      );

      await sendReply(event.conversationId, event, message);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
    } catch (err) {
      log(`Failed to execute /oncall: ${err.message}`);
      await sendReply(event.conversationId, event, `❌ Failed to fetch on-call responders: ${err.message}`);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    }
  }

  async findTargetIssueKey(event, args) {
    const argStr = args.join(' ').trim();
    const argMatch = argStr.match(/\b([a-zA-Z][a-zA-Z0-9]+-\d+)\b/);
    if (argMatch) return argMatch[1].toUpperCase();

    const html = event.rawHtml || event.content || '';
    const quoteMatch = html.match(/\b([a-zA-Z][a-zA-Z0-9]+-\d+)\b/);
    if (quoteMatch) return quoteMatch[1].toUpperCase();

    try {
      const thread = await getThreadMessages(event.conversationId, { limit: 10 });
      for (const msg of thread) {
        if (msg.messageId === event.messageId) continue;
        const text = msg.content || msg.text || '';
        const m = text.match(/\b([a-zA-Z][a-zA-Z0-9]+-\d+)\b/);
        if (m) return m[1].toUpperCase();
      }
    } catch (err) {
      log(`Failed to search thread for Jira issue: ${err.message}`);
    }

    return null;
  }

  async executeIssueCommand(event, args) {
    if (!this.jira?.isConfigured()) {
      await sendReply(event.conversationId, event, '❌ Jira integration is not configured.');
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    const key = await this.findTargetIssueKey(event, args);
    if (!key) {
      await sendReply(
        event.conversationId,
        event,
        '❌ No Jira issue key found. Usage: `/issue <KEY>` (or reply to a message containing a ticket key like `CKS-1234`).'
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.warning).catch(() => {});
      return;
    }

    try {
      const issue = await this.jira.getIssue(key);
      await this.prefetchAvatars(issue);
      const text = this.richMessage(this.formatJiraIssueMessage(issue), () =>
        buildJiraIssueCard({ ...issue, avatars: this.cardAvatars(issue), profiles: this.cardProfiles(issue) })
      );
      await sendReply(event.conversationId, event, text);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
    } catch (err) {
      log(`Failed to fetch Jira issue ${key}: ${err.message}`);
      await sendReply(event.conversationId, event, `❌ Failed to fetch Jira issue **${key}**: ${err.message}`);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    }
  }

  async executeConfluenceCommand(event, args) {
    if (!this.confluence || !this.confluence.isConfigured()) {
      await sendReply(event.conversationId, event, '❌ Confluence is not configured.');
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    let target = (Array.isArray(args) ? args.join(' ') : String(args || '')).trim();
    if (!target && event.replyToId) {
      try {
        const parentMsg = await this.fetchMessageContent(event.conversationId, event.replyToId);
        if (parentMsg) {
          const links = this.confluence.findPageLinks(parentMsg, { allowQuotes: true });
          if (links.length > 0) {
            target = links[0].target || links[0].url || links[0].id;
          }
        }
      } catch (err) {
        log(`Failed to search reply parent for Confluence doc: ${err.message}`);
      }
    }

    if (!target) {
      await sendReply(
        event.conversationId,
        event,
        '❌ No Confluence link or page ID provided. Usage: `/doc <URL|ID>` (or reply to a message containing a Confluence link).'
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.warning).catch(() => {});
      return;
    }

    try {
      const page = await this.confluence.getPage(target);
      if (!page) {
        await sendReply(event.conversationId, event, `❌ Confluence page not found: ${typeof target === 'object' ? target.title || target.id : target}`);
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
        return;
      }

      const text = this.richMessage(this.formatConfluencePageMessage(page), () => buildConfluencePageCard(page));
      await sendReply(event.conversationId, event, text);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
    } catch (err) {
      log(`Failed to fetch Confluence page ${typeof target === 'object' ? JSON.stringify(target) : target}: ${err.message}`);
      await sendReply(event.conversationId, event, `❌ Failed to fetch Confluence page: ${err.message}`);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    }
  }

  async executeRetryCommand(event, args) {
    const mrs = await this.findTargetMrsForCommand(event, args);
    if (!mrs || mrs.length === 0) {
      await sendReply(
        event.conversationId,
        event,
        '❌ No merge request found. Please provide an MR link, shorthand (e.g. `workload-clusters!596`), or reply to an MR message.'
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    const mrRef = mrs[0];
    const project = mrRef.project;
    const iid = mrRef.iid;
    const mrUrl = mrRef.url || this.gitlab.mrLink(project, iid);
    let titleText = '';
    try {
      const mrState = await this.gitlab.getMrStatus(project, iid);
      if (mrState?.title) titleText = `: **${mrState.title}**`;
    } catch {}

    try {
      const pipeline = await this.gitlab.getLatestPipeline(project, iid);
      if (!pipeline) {
        await sendReply(event.conversationId, event, `❌ No pipeline found for [${project}!${iid}](${mrUrl})${titleText}.`);
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
        return;
      }

      if (pipeline.status !== 'failed' && pipeline.status !== 'canceled') {
        await sendReply(
          event.conversationId,
          event,
          `ℹ️ Latest pipeline [#${pipeline.id}](${pipeline.web_url}) for [${project}!${iid}](${mrUrl})${titleText} is in state **${pipeline.status}** (nothing to retry).`
        );
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.warning).catch(() => {});
        return;
      }

      await this.gitlab.retryPipeline(project, pipeline.id);
      await sendReply(
        event.conversationId,
        event,
        `🔁 **Retried failed jobs** on pipeline [#${pipeline.id}](${pipeline.web_url}) for [${project}!${iid}](${mrUrl})${titleText} (status: **${pipeline.status}** ➔ **running**).`
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
    } catch (err) {
      log(`Failed to retry pipeline for ${project}!${iid}: ${err.message}`);
      await sendReply(event.conversationId, event, `❌ Failed to retry pipeline: ${err.message}`);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    }
  }

  async executeCiCommand(event, args) {
    const directSearch = [stripTruncatedUrlText(args.join(' '), event), buildMessageSearchText(event, { includeQuotes: true })]
      .filter(Boolean)
      .join(' ');
    const pipeLinks = this.gitlab.findPipelineLinks(directSearch, { allowQuotes: true });
    const jobLinks = this.gitlab.findJobLinks(directSearch, { allowQuotes: true });

    if (pipeLinks.length > 0 || jobLinks.length > 0) {
      let project;
      let pipelineId;
      let targetRef = '';
      if (pipeLinks.length > 0) {
        project = pipeLinks[0].project;
        pipelineId = pipeLinks[0].pipelineId;
      } else {
        project = jobLinks[0].project;
        try {
          const jobData = await this.gitlab.getJob(project, jobLinks[0].jobId);
          pipelineId = jobData?.pipeline?.id || jobData?.pipeline_id;
          targetRef = ` (from Job #${jobLinks[0].jobId})`;
        } catch (err) {
          log(`Failed to fetch job ${jobLinks[0].jobId}: ${err.message}`);
        }
      }

      if (pipelineId) {
        try {
          const pipeline = await this.gitlab.getPipeline(project, pipelineId);
          const jobs = await this.gitlab.getPipelineJobs(project, pipelineId).catch(() => []);
          const statusIcon = getCiStatusEmoji(pipeline.status);
          const durationStr = pipeline.duration ? ` (${formatDuration(pipeline.duration)})` : '';
          const projectRef = project.split('/').pop() || project;
          const pipeUrl = pipeline.web_url || this.gitlab.pipelineLink(project, pipelineId);
          const mr = await this.gitlab.getMrForPipeline(project, pipeline).catch(() => null);
          const lines = [
            `🏗️ **Pipeline [#${pipeline.id} (${projectRef})](${pipeUrl})**: ${statusIcon} **${pipeline.status}**${durationStr}${targetRef}`,
            `• **Ref**: \`${pipeline.ref}\``,
          ];
          if (mr) {
            lines.push(`• **Merge Request**: [!${mr.iid} (${mr.title || mr.project})](${mr.web_url})`);
          }
          const failedJobs = jobs.filter((j) => j.status === 'failed');
          const runningJobs = jobs.filter((j) => j.status === 'running' || j.status === 'pending');
          if (failedJobs.length > 0) {
            lines.push(`\n**Failed Jobs** (${failedJobs.length}):`);
            for (const job of failedJobs.slice(0, 10)) {
              const jobDur = job.duration ? ` — ${formatDuration(job.duration)}` : '';
              lines.push(`- ❌ [${job.name}](${job.web_url}) (\`stage: ${job.stage}\`${jobDur})`);
            }
            if (failedJobs.length > 10) lines.push(`- _...and ${failedJobs.length - 10} more_`);
          } else if (runningJobs.length > 0) {
            lines.push(`\n**Active Jobs** (${runningJobs.length}):`);
            for (const job of runningJobs.slice(0, 8)) {
              lines.push(`- ⏳ [${job.name}](${job.web_url}) (\`stage: ${job.stage}\`)`);
            }
          } else if (pipeline.status === 'success' || pipeline.status === 'passed') {
            lines.push(`\n✅ All ${jobs.length} jobs completed successfully.`);
          }
          await sendReply(
            event.conversationId,
            event,
            this.richCommandMessage(lines.join('\n'), {
              service: 'gitlab',
              kind: 'Pipeline',
            })
          );
          this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
          return;
        } catch (err) {
          log(`Failed to fetch pipeline ${pipelineId}: ${err.message}`);
          await sendReply(event.conversationId, event, `❌ Failed to fetch pipeline #${pipelineId}: ${err.message}`);
          this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
          return;
        }
      }
    }

    const mrs = await this.findTargetMrsForCommand(event, args);
    if (!mrs || mrs.length === 0) {
      await sendReply(
        event.conversationId,
        event,
        '❌ No merge request, pipeline, or job found. Please provide a link, shorthand, or reply to a message.'
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
      return;
    }

    const mrRef = mrs[0];
    const project = mrRef.project;
    const iid = mrRef.iid;
    const mrUrl = mrRef.url || this.gitlab.mrLink(project, iid);
    let titleText = '';
    try {
      const mrState = await this.gitlab.getMrStatus(project, iid);
      if (mrState?.title) titleText = `: **${mrState.title}**`;
    } catch {}

    try {
      const pipeline = await this.gitlab.getLatestPipeline(project, iid);
      if (!pipeline) {
        await sendReply(event.conversationId, event, `❌ No pipeline found for [${project}!${iid}](${mrUrl})${titleText}.`);
        this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
        return;
      }

      const jobs = await this.gitlab.getPipelineJobs(project, pipeline.id).catch(() => []);
      const statusIcons = {
        success: '✅',
        passed: '✅',
        failed: '❌',
        running: '⏳',
        pending: '⏳',
        canceled: '⏹️',
        skipped: '⏭️',
        manual: '⚙️',
      };
      const statusIcon = statusIcons[pipeline.status] || '⚠️';

      const durationStr = pipeline.duration ? ` (${formatDuration(pipeline.duration)})` : '';
      const lines = [
        `🏗️ **Pipeline [#${pipeline.id}](${pipeline.web_url})**: ${statusIcon} **${pipeline.status}**${durationStr}`,
        `• **Target**: [${project}!${iid}](${mrUrl})${titleText} (ref: \`${pipeline.ref}\`)`,
      ];

      const failedJobs = jobs.filter((j) => j.status === 'failed');
      const runningJobs = jobs.filter((j) => j.status === 'running' || j.status === 'pending');

      if (failedJobs.length > 0) {
        lines.push(`\n**Failed Jobs** (${failedJobs.length}):`);
        for (const job of failedJobs.slice(0, 10)) {
          const jobDur = job.duration ? ` — ${formatDuration(job.duration)}` : '';
          lines.push(`- ❌ [${job.name}](${job.web_url}) (\`stage: ${job.stage}\`${jobDur})`);
        }
        if (failedJobs.length > 10) {
          lines.push(`- _...and ${failedJobs.length - 10} more_`);
        }
      } else if (runningJobs.length > 0) {
        lines.push(`\n**Active Jobs** (${runningJobs.length}):`);
        for (const job of runningJobs.slice(0, 8)) {
          lines.push(`- ⏳ [${job.name}](${job.web_url}) (\`stage: ${job.stage}\`)`);
        }
      } else if (pipeline.status === 'success' || pipeline.status === 'passed') {
        lines.push(`\n✅ All ${jobs.length} jobs completed successfully.`);
      }

      await sendReply(
        event.conversationId,
        event,
        this.richCommandMessage(lines.join('\n'), {
          service: 'gitlab',
          kind: 'Pipeline',
        })
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
    } catch (err) {
      log(`Failed to fetch CI status for ${project}!${iid}: ${err.message}`);
      await sendReply(event.conversationId, event, `❌ Failed to fetch CI pipeline: ${err.message}`);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    }
  }

  async executeStandupCommand(event) {
    const rawSender = event.from || event.sender?.displayName || 'User';
    log(`Executing /standup for ${rawSender} in ${event.conversationId}...`);

    const nameTokens = rawSender
      .toLowerCase()
      .split(/[\s,.-]+/)
      .filter((t) => t.length > 2);

    const matchesSender = (name) => {
      if (!name) return false;
      const lower = name.toLowerCase();
      if (lower.includes(rawSender.toLowerCase()) || rawSender.toLowerCase().includes(lower)) return true;
      return nameTokens.some((token) => lower.includes(token));
    };

    try {
      const [sprintData, groupMrs] = await Promise.all([
        this.jira?.isConfigured() ? this.jira.getActiveSprintTasks().catch(() => null) : null,
        this.gitlab?.group ? this.gitlab.getGroupMrs().catch(() => []) : [],
      ]);

      const myTasks = [];
      if (sprintData) {
        for (const list of [sprintData.inProgress, sprintData.inReview, sprintData.todo]) {
          for (const item of list) {
            if (matchesSender(item.assignee)) {
              myTasks.push(item);
            }
          }
        }
      }

      const myAuthoredMrs = [];
      const myReviewMrs = [];
      for (const mr of groupMrs) {
        const authorMatch = matchesSender(mr.author?.name) || matchesSender(mr.author?.username);
        if (authorMatch) {
          myAuthoredMrs.push(mr);
        } else if (Array.isArray(mr.reviewers) && mr.reviewers.some((r) => matchesSender(r.name) || matchesSender(r.username))) {
          myReviewMrs.push(mr);
        }
      }

      const sections = [`🌅 **Standup Summary for ${rawSender}**`];

      if (myTasks.length > 0) {
        const lines = [`\n📋 **Active Jira Tasks** (${myTasks.length}):`];
        for (const t of myTasks) {
          const sLower = t.status.toLowerCase();
          const sIcon = sLower.includes('review') ? '🟣' : sLower.includes('progress') ? '🟡' : '⚪';
          lines.push(`- ${sIcon} **${t.status}**: [${t.key}](${t.url}) - ${escapeHtml(t.summary)}`);
        }
        sections.push(lines.join('\n'));
      } else {
        sections.push('\n📋 **Jira Tasks**: _None assigned in active sprint_');
      }

      if (myAuthoredMrs.length > 0 || myReviewMrs.length > 0) {
        const lines = [`\n🦊 **GitLab Merge Requests**:`];
        for (const mr of myAuthoredMrs) {
          const ref = mr.references?.full || mr.title;
          lines.push(`- ✏️ **Author**: [${ref}](${mr.web_url}) - ${escapeHtml(mr.title)}`);
        }
        for (const mr of myReviewMrs) {
          const ref = mr.references?.full || mr.title;
          lines.push(`- 🔍 **Reviewer**: [${ref}](${mr.web_url}) - ${escapeHtml(mr.title)}`);
        }
        sections.push(lines.join('\n'));
      } else {
        sections.push('\n🦊 **GitLab MRs**: _No open MRs as author or reviewer_');
      }

      await sendReply(
        event.conversationId,
        event,
        this.richCommandMessage(sections.join('\n'), { service: 'standup', kind: 'Summary' })
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.success).catch(() => {});
    } catch (err) {
      log(`Failed to execute /standup: ${err.message}`);
      await sendReply(event.conversationId, event, `❌ Failed to generate standup summary: ${err.message}`);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    }
  }

  async executeFlipCommand(event) {
    const outcome = Math.random() < 0.5 ? 'Heads' : 'Tails';
    await sendReply(event.conversationId, event, `🪙 **${outcome}!**`);
    this.setCommandReaction(event.conversationId, event.messageId, 'like').catch(() => {});
  }

  async executeRollCommand(event, args) {
    const spec = parseDiceArgs(args);
    if (!spec) {
      await sendReply(event.conversationId, event, DICE_USAGE);
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.warning).catch(() => {});
      return;
    }
    log(`Executing /dice (${spec.mode}) in ${event.conversationId}...`);
    const result = spec.mode === 'pick' ? pickOption(spec.options) : rollDice(spec);
    const who = String(event.from ?? '').trim();
    const markdown = formatDiceMarkdown(result, who);
    let reply = markdown;
    if (this.richMessages) {
      try {
        reply = makeRichMessage(markdown, buildDiceCard(result, { who, fallbackText: markdown }));
      } catch (e) {
        log(`building the dice card failed, using plain text: ${e.message}`);
      }
    }
    await sendReply(event.conversationId, event, reply);
    this.setCommandReaction(event.conversationId, event.messageId, 'like').catch(() => {});
  }

  async executePollCommand(event, args) {
    const parsed = parsePollArgs(args);
    if (!parsed) {
      await sendReply(
        event.conversationId,
        event,
        '📊 Usage: `/poll "Question" "Option 1" "Option 2"` (or `/poll Should we deploy?`)'
      );
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.warning).catch(() => {});
      return;
    }

    const { question, options } = parsed;
    const isYesNo = options.length === 2 && options[0].toLowerCase() === 'yes' && options[1].toLowerCase() === 'no';

    const EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    const lines = [`📊 **Poll: ${escapeHtml(question)}**\n`];

    if (isYesNo) {
      lines.push('👍 **Yes**');
      lines.push('👎 **No**');
    } else {
      for (let i = 0; i < Math.min(options.length, EMOJIS.length); i++) {
        lines.push(`${EMOJIS[i]} ${escapeHtml(options[i])}`);
      }
    }

    lines.push('\n_Vote by reacting to this message!_');
    const sent = await sendReply(event.conversationId, event, lines.join('\n'));
    this.setCommandReaction(event.conversationId, event.messageId, 'like').catch(() => {});

    const botMsgId = sent.ok ? (sent.value?.messageId || sent.value?.timestamp) : null;
    if (botMsgId) {
      (async () => {
        try {
          if (isYesNo) {
            await addReaction(event.conversationId, botMsgId, 'like');
          }
        } catch {}
      })();
    }
  }

  async handleSlashCommand(event) {
    const parsed = this.parseSlashCommand(event.content);
    if (!parsed) return;

    const { command, args } = parsed;
    log.debug(`Handling slash command ${command} from ${event.from || event.fromMri} in ${event.conversationId}`);

    this.recordUserInteraction(event, command);

    // React in background with eyes emoji to acknowledge command receipt without blocking execution
    this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.pending).catch(() => {});

    if (command === '/approve') {
      await this.executeApproveCommand(event, args);
    } else if (command === '/unapprove' || command === '/revoke' || command === '/disapprove') {
      await this.executeUnapproveCommand(event, args, command);
    } else if (command === '/merge' || command === '/accept') {
      await this.executeMergeCommand(event, args);
    } else if (command === '/close') {
      await this.executeCloseCommand(event, args);
    } else if (command === '/reopen') {
      await this.executeReopenCommand(event, args);
    } else if (command === '/rebase') {
      await this.executeRebaseCommand(event, args);
    } else if (command === '/status') {
      await this.executeStatusCommand(event, args);
    } else if (command === '/retry') {
      await this.executeRetryCommand(event, args);
    } else if (command === '/ci' || command === '/pipeline') {
      await this.executeCiCommand(event, args);
    } else if (command === '/mrs') {
      await this.executeMrsCommand(event, args);
    } else if (command === '/alerts' || command === '/opsgenie') {
      await this.executeAlertsCommand(event, args);
    } else if (command === '/oncall' || command === '/whoisoncall') {
      await this.executeOnCallCommand(event);
    } else if (command === '/sprint' || command === '/jira') {
      await this.executeSprintCommand(event);
    } else if (command === '/issue' || command === '/ticket') {
      await this.executeIssueCommand(event, args);
    } else if (command === '/doc' || command === '/wiki' || command === '/confluence') {
      await this.executeConfluenceCommand(event, args);
    } else if (command === '/standup' || command === '/today') {
      await this.executeStandupCommand(event);
    } else if (command === '/meetings' || command === '/cal' || command === '/calendar') {
      await this.executeMeetingsCommand(event);
    } else if (command === '/poll') {
      await this.executePollCommand(event, args);
    } else if (command === '/flip') {
      await this.executeFlipCommand(event);
    } else if (command === '/roll' || command === '/dice') {
      await this.executeRollCommand(event, args);
    } else if (command === '/tv') {
      await this.executeTvCommand(event, args);
    } else if (command === '/weather') {
      await this.executeWeatherCommand(event, args);
    } else if (command === '/whois' || command === '/who') {
      await this.executeWhoisCommand(event, args);
    } else if (command === '/whereis' || command === '/where') {
      await this.executeWhereisCommand(event, args);
    } else if (command === '/random') {
      await this.executeRandomCommand(event);
    } else if (command === '/marco') {
      await this.executeMarcoCommand(event);
    } else if (command === '/snake') {
      await this.executeSnakeCommand(event);
    } else if (command === '/leaderboard') {
      await this.executeLeaderboardCommand(event);
    } else if (command === '/kick') {
      await sendReply(event.conversationId, event, '⚠️ `/kick` has moved to `/sudo kick <nick>` [admin only].');
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    } else if (command === '/ban') {
      await sendReply(event.conversationId, event, '⚠️ `/ban` has moved to `/sudo ban <nick>` [admin only].');
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    } else if (command === '/unban') {
      await sendReply(event.conversationId, event, '⚠️ `/unban` has moved to `/sudo unban <nick>` [admin only].');
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    } else if (command === '/bans') {
      await sendReply(event.conversationId, event, '⚠️ `/bans` has moved to `/sudo bans` [admin only].');
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.failure).catch(() => {});
    } else if (command === '/exec') {
      await this.executeExecCommand(event, args);
    } else if (command === '/renew') {
      await this.executeRenewGitLabTokenCommand(event);
    } else if (command === '/sudo' || command === '/admin') {
      await this.executeAdminCommand(event, args);
    } else if (command === '/restart') {
      await this.executeRestartCommand(event);
    } else if (command === '/reauth') {
      await this.executeReauthCommand(event);
    } else if (command === '/about') {
      await this.executeAboutCommand(event);
    } else if (command === '/help' || command === '/usage') {
      await this.executeHelpCommand(event, args);
    } else {
      let bestMatch = null;
      let minDistance = Infinity;

      for (const known of KNOWN_COMMANDS) {
        if (known === '/usage') continue;
        const dist = levenshteinDistance(command, known);
        if (dist < minDistance) {
          minDistance = dist;
          bestMatch = known;
        }
      }

      if (bestMatch && minDistance <= 3) {
        const fullSuggested = args.length > 0 ? `${bestMatch} ${args.join(' ')}` : bestMatch;
        const replyRes = await sendReply(
          event.conversationId,
          event,
          `🤔 ${toMockingCase('did you mean')} ${fullSuggested}?`
        );
        const replyMsgId = replyRes?.value?.timestamp || replyRes?.value?.messageId;
        if (replyMsgId) {
          this.cleanupSuggestions();
          const replyIdStr = String(replyMsgId);
          this.pendingSuggestions.set(replyIdStr, {
            conversationId: event.conversationId,
            replyMessageId: replyIdStr,
            originalMessageId: String(event.messageId),
            originalUserMri: event.fromMri,
            originalUserName: event.from,
            suggestedCommand: bestMatch,
            originalArgs: args,
            originalEvent: event,
            createdAt: Date.now(),
          });
          if (event.messageId) {
            this.typoMessageToSuggestion.set(String(event.messageId), replyIdStr);
          }
        }
      } else {
        await sendReply(
          event.conversationId,
          event,
          `Unknown command \`${command}\`. Use \`/help\` to see available commands.`
        );
      }
      this.setCommandReaction(event.conversationId, event.messageId, COMMAND_REACTIONS.warning).catch(() => {});
    }
  }

  cleanupSuggestions() {
    const now = Date.now();
    const TTL = 15 * 60 * 1000;
    for (const [id, entry] of this.pendingSuggestions.entries()) {
      if (now - entry.createdAt > TTL) {
        this.pendingSuggestions.delete(id);
        if (entry.originalMessageId) {
          this.typoMessageToSuggestion.delete(entry.originalMessageId);
        }
      }
    }
  }

  normalizeUserMri(mri) {
    if (!mri) return '';
    const str = String(mri);
    const match = str.match(/8:orgid:([a-f0-9-]+)/i);
    if (match) return match[1].toLowerCase();
    const guid = str.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
    if (guid) return guid[0].toLowerCase();
    return str.toLowerCase();
  }

  isMatchingSuggestionUser(reactorUser, originalUserMri, originalUserName) {
    if (!reactorUser) return false;

    const reactorMriNorm = this.normalizeUserMri(reactorUser.mri);
    const targetMriNorm = this.normalizeUserMri(originalUserMri);

    if (reactorMriNorm && targetMriNorm && reactorMriNorm === targetMriNorm) {
      return true;
    }

    if (
      reactorUser.displayName &&
      originalUserName &&
      reactorUser.displayName.trim().toLowerCase() === originalUserName.trim().toLowerCase()
    ) {
      return true;
    }

    return false;
  }

  isReactorSelf(user) {
    if (!user) return false;
    const userOid = extractUserOid(user.mri);
    if (this.selfOid && userOid && userOid.toLowerCase() === this.selfOid.toLowerCase()) {
      return true;
    }
    if (this.adminOids && userOid && this.adminOids.has(userOid)) {
      return true;
    }
    const selfMri = this.selfMri || this.authManager?.getCachedAuth?.()?.userMri;
    if (selfMri) {
      const rawMri = String(user.mri || '').trim().toLowerCase();
      const selfMriNorm = selfMri.toLowerCase().trim();
      if (rawMri && rawMri === selfMriNorm) return true;
      const norm1 = this.normalizeUserMri(rawMri);
      const norm2 = this.normalizeUserMri(selfMriNorm);
      if (norm1 && norm2 && norm1 === norm2) return true;
    }
    if (user.mri && this.isSelfOrAdmin(user.mri)) {
      return true;
    }
    return false;
  }

  async handleSuggestionReaction(event, suggestion) {
    if (Date.now() - suggestion.createdAt > 15 * 60 * 1000) {
      this.pendingSuggestions.delete(suggestion.replyMessageId);
      if (suggestion.originalMessageId) {
        this.typoMessageToSuggestion.delete(suggestion.originalMessageId);
      }
      return;
    }

    const checkReactions = async (convId, mId) => {
      try {
        const res = await this.getMessage(convId, mId);
        if (!res.ok || !res.value?.reactions) return null;
        for (const r of res.value.reactions) {
          const key = (r.key || '').toLowerCase();
          const isThumbUp = key === 'like' || key === '👍' || key.includes('thumb');
          if (isThumbUp && this.isMatchingSuggestionUser(r.user, suggestion.originalUserMri, suggestion.originalUserName)) {
            return r;
          }
        }
      } catch (err) {
        log(`Failed to fetch message ${mId} for reaction check: ${err.message}`);
      }
      return null;
    };

    let matchedReaction = await checkReactions(suggestion.conversationId, suggestion.replyMessageId);
    if (!matchedReaction && suggestion.originalMessageId) {
      matchedReaction = await checkReactions(suggestion.conversationId, suggestion.originalMessageId);
    }
    if (!matchedReaction) {
      await new Promise((r) => setTimeout(r, 500));
      matchedReaction = await checkReactions(suggestion.conversationId, suggestion.replyMessageId);
      if (!matchedReaction && suggestion.originalMessageId) {
        matchedReaction = await checkReactions(suggestion.conversationId, suggestion.originalMessageId);
      }
    }

    if (!matchedReaction) return;

    log(`👍 Thumb up detected from ${matchedReaction.user?.displayName || suggestion.originalUserName} on suggestion "${suggestion.suggestedCommand}"! Executing...`);

    // Clean up so it executes only once
    this.pendingSuggestions.delete(suggestion.replyMessageId);
    if (suggestion.originalMessageId) {
      this.typoMessageToSuggestion.delete(suggestion.originalMessageId);
    }

    // Remove warning reaction from original typo message
    if (suggestion.originalMessageId) {
      removeReaction(suggestion.conversationId, suggestion.originalMessageId, COMMAND_REACTIONS.warning).catch(() => {});
    }

    const reconstructedContent = suggestion.originalArgs?.length > 0
      ? `${suggestion.suggestedCommand} ${suggestion.originalArgs.join(' ')}`
      : suggestion.suggestedCommand;

    const execEvent = {
      ...suggestion.originalEvent,
      content: reconstructedContent,
      replyMessageIdToUpdate: suggestion.replyMessageId,
    };

    try {
      await this.handleSlashCommand(execEvent);
    } catch (err) {
      log(`Error executing suggested command "${suggestion.suggestedCommand}": ${err.message}`);
    }
  }

  async handleMrReactionApproval(event) {
    if (!this.gitlab?.approveMr) return;
    const msgId = String(event.messageId || '');
    const convId = event.conversationId;
    if (!msgId || !convId) return;

    if (this.botPlacedLikeMessageIds.has(msgId)) return;

    let targetMrs = [];
    let matchedWatchedKey = null;
    let isConfirmedBotMessage = botSentMessageIds.has(msgId);

    for (const [key, entry] of this.watched.entries()) {
      if (entry.conversationId !== convId) continue;
      const isOriginal = String(entry.messageId) === msgId;
      const isCiMsg = entry.mrs?.some((m) => String(m.ciMessageServerId) === msgId);
      const isRebaseMsg = entry.mrs?.some((m) => String(m.rebaseMessageServerId) === msgId);
      const isEditedOriginal = entry.editedOriginal && String(entry.messageId) === msgId;
      if (isOriginal || isCiMsg || isRebaseMsg || isEditedOriginal) {
        if (entry.status === 'approved') return;
        if (entry.mrs && entry.mrs.length > 0) {
          targetMrs = entry.mrs.map((m) => ({ project: m.project, iid: m.iid, title: m.title }));
          matchedWatchedKey = key;
          isConfirmedBotMessage = true;
          break;
        }
      }
    }

    const fetchMessageData = async () => {
      try {
        const res = await this.getMessage(convId, msgId);
        if (!res?.ok || !res.value) return null;
        return res.value;
      } catch (err) {
        log(`Failed to fetch message ${msgId} for MR reaction check: ${err.message}`);
        return null;
      }
    };

    let msgData = await fetchMessageData();
    if (!msgData) return;

    if (!isConfirmedBotMessage) {
      const isBot =
        botSentMessageIds.has(msgId) ||
        this.isOwnMessage(
          msgData.sender?.mri,
          msgData.content,
          msgId,
          msgData.clientMessageId,
          msgData.content
        );
      if (!isBot) return;
      isConfirmedBotMessage = true;
    }

    if (targetMrs.length === 0 && msgData.content) {
      const fullText = buildMessageSearchText(msgData, { includeQuotes: true });
      targetMrs = this.gitlab.findMrLinks(fullText, { allowQuotes: true });
    }

    if (targetMrs.length === 0) return;

    // The 👍 reactions that may approve: this account's (and configured admins') always; with
    // `gitlab.reaction_approvers = anyone` (the default) also everybody else's, except the author's own (see below).
    const anyone = this.config.gitlab?.reaction_approvers === 'anyone';
    const findThumbUps = (reactions) => {
      if (!reactions || !Array.isArray(reactions)) return [];
      return reactions.filter((r) => {
        const key = (r.key || '').toLowerCase();
        const isThumbUp = key === 'like' || key === '👍' || key.includes('thumb');
        return isThumbUp && r.user && (anyone || this.isReactorSelf(r.user));
      });
    };

    let thumbs = findThumbUps(msgData.reactions);
    if (thumbs.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const retryData = await fetchMessageData();
      if (retryData?.reactions) {
        msgData = retryData;
        thumbs = findThumbUps(msgData.reactions);
      }
    }

    if (thumbs.length === 0) return;

    let selfThumb = null;
    let anyApproved = false;

    for (const mr of targetMrs) {
      const dedupKey = `${mr.project}!${mr.iid}`.toLowerCase();
      if (this.approvingMrs.has(dedupKey)) {
        log(`Approval for ${mr.project}!${mr.iid} already in progress, skipping duplicate`);
        continue;
      }
      this.approvingMrs.add(dedupKey);

      try {
        const mrState = await this.gitlab.getMrStatus(mr.project, mr.iid);
        if (mrState.status === 'approved' || mrState.approved) {
          log(`MR ${mr.project}!${mr.iid} is already approved, ignoring reaction approval`);
          continue;
        }
        if (mrState.status === 'merged' || mrState.status === 'closed') {
          log.warn(`MR ${mr.project}!${mr.iid} is already ${mrState.status}, cannot approve`);
          continue;
        }

        // This account's own thumbs up first; anybody else's only when they are not the author of the merge
        // request (an author must not approve their own merge request through the bot).
        const recentThumbs = thumbs.filter((reaction) => {
          const value = Number(reaction.time);
          const time = value < 1e12 ? value * 1000 : value;
          const age = Date.now() - time;
          return value > 0 && Number.isFinite(value) && age >= 0 && age <= 30000;
        });
        selfThumb = recentThumbs.length === 1 && (this.isReactorSelf(recentThumbs[0].user) || !(await this.isReactorMrAuthor(recentThumbs[0].user, mrState)))
          ? recentThumbs[0]
          : thumbs.find((t) => this.isReactorSelf(t.user)) || null;
        if (!selfThumb) {
          for (const t of thumbs) {
            if (!(await this.isReactorMrAuthor(t.user, mrState))) {
              selfThumb = t;
              break;
            }
          }
        }
        if (!selfThumb) {
          log(`Thumb-up on ${mr.project}!${mr.iid} ignored: only the author reacted`);
          continue;
        }
        const reactorName = selfThumb.user?.displayName || 'self';
        log(`👍 Thumb-up approval: approving ${mr.project}!${mr.iid} via GitLab API (reactor: ${reactorName})...`);
        const actor = await this.gitlabActor(selfThumb.user?.mri);
        if (actor.tokenIndex !== 0) {
          // Message updates contain a reaction snapshot. Only a unique, recent
          // reaction can authorize a personal write; never reuse an old like.
          const timeMs = (reaction) => {
            const value = Number(reaction.time);
            return value > 0 && Number.isFinite(value) ? (value < 1e12 ? value * 1000 : value) : 0;
          };
          const recent = thumbs.filter((reaction) => {
            const age = Date.now() - timeMs(reaction);
            return age >= 0 && age <= 30000;
          });
          const key = `${convId}/${msgId}/${selfThumb.user.mri}/${selfThumb.time}/${dedupKey}`;
          if (recent.length !== 1 || recent[0] !== selfThumb || this.processedPersonalReactions.has(key)) continue;
          this.processedPersonalReactions.add(key);
          if (this.processedPersonalReactions.size > 5000) this.processedPersonalReactions.delete(this.processedPersonalReactions.values().next().value);
        }
        await this.gitlab.approveMr(mr.project, mr.iid, actor);
        log(`Approved ${mr.project}!${mr.iid} successfully via thumbs-up reaction`);
        if (actor.tokenIndex === 0) await this.noteTeamsApproval(mr.project, mr.iid, { name: selfThumb.user?.displayName, mri: selfThumb.user?.mri, via: '👍 reaction', conversationId: convId, messageId: msgId });
        anyApproved = true;
      } catch (err) {
        log(`Failed to approve ${mr.project}!${mr.iid} on thumbs-up: ${err.message}`);
      } finally {
        setTimeout(() => this.approvingMrs.delete(dedupKey), 10000);
      }
    }

    if (anyApproved) {
      if (matchedWatchedKey) {
        this.checkWatchedKey(matchedWatchedKey).catch((err) =>
          log(`Post-approval check failed for ${matchedWatchedKey}: ${err.message}`)
        );
      }
      this.checkAllWatched().catch((err) =>
        log(`Post-approval check failed: ${err.message}`)
      );
    }
  }

  /**
   * Whether the person who reacted is the author of the merge request: the same GitLab user name (the reactor's
   * configured or exactly matched one), else the same display name. An approval must not come from the author.
   */
  async isReactorMrAuthor(user, mrState) {
    const name = String(user?.displayName || '').trim().toLowerCase();
    const author = String(mrState?.author || '').trim().toLowerCase();
    if (name && author && name === author) return true;
    try {
      const requester = await this.approvalRequester({ name: user?.displayName, mri: user?.mri });
      const username = String(requester.gitlabUser || '').toLowerCase();
      return Boolean(username && mrState?.authorUsername && username === String(mrState.authorUsername).toLowerCase());
    } catch {
      return false;
    }
  }

  async syncMrAwardEmojis(project, iid, desiredEmojiNames) {
    if (!this.gitlab?.getAwardEmojis || !this.gitlab?.awardEmoji || !this.gitlab?.deleteAwardEmoji) return;
    const syncKey = `${project}!${iid}`.toLowerCase();
    if (this.syncingAwardEmojis.has(syncKey)) return;
    this.syncingAwardEmojis.add(syncKey);

    try {
      const currentUser = await this.gitlab.getCurrentUser().catch(() => null);
      if (!currentUser) return;

      const existingAwards = await this.gitlab.getAwardEmojis(project, iid).catch(() => []);
      const myAwards = (existingAwards || []).filter(
        (a) => a.user?.id === currentUser.id || (currentUser.username && a.user?.username === currentUser.username)
      );

      const existingNames = new Set(myAwards.map((a) => a.name));

      // Award missing emojis
      for (const name of desiredEmojiNames) {
        if (!existingNames.has(name)) {
          log.debug(`Awarding emoji :${name}: on ${project}!${iid}...`);
          try {
            await this.gitlab.awardEmoji(project, iid, name);
            log(`Awarded emoji :${name}: on ${project}!${iid}`);
          } catch (err) {
            log(`Failed to award emoji :${name}: on ${project}!${iid}: ${err.message}`);
          }
        }
      }

      // Remove unneeded emojis (excluding thumbsup which is reserved for approval)
      for (const award of myAwards) {
        if (award.name !== 'thumbsup' && !desiredEmojiNames.has(award.name)) {
          log.debug(`Removing award emoji :${award.name}: (id: ${award.id}) from ${project}!${iid}...`);
          try {
            await this.gitlab.deleteAwardEmoji(project, iid, award.id);
            log(`Removed award emoji :${award.name}: from ${project}!${iid}`);
          } catch (err) {
            log(`Failed to remove award emoji :${award.name}: from ${project}!${iid}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      log(`Error syncing award emojis for ${project}!${iid}: ${err.message}`);
    } finally {
      this.syncingAwardEmojis.delete(syncKey);
    }
  }

  async handleMrReactionMirroring(event) {
    if (!this.gitlab?.getAwardEmojis) return;
    const msgId = String(event.messageId || '');
    const convId = event.conversationId;
    if (!msgId || !convId) return;

    let targetMrs = [];
    for (const [key, entry] of this.watched.entries()) {
      if (entry.conversationId !== convId) continue;
      const isOriginal = String(entry.messageId) === msgId;
      const isCiMsg = entry.mrs?.some((m) => String(m.ciMessageServerId) === msgId);
      const isRebaseMsg = entry.mrs?.some((m) => String(m.rebaseMessageServerId) === msgId);
      const isEditedOriginal = entry.editedOriginal && String(entry.messageId) === msgId;
      if (isOriginal || isCiMsg || isRebaseMsg || isEditedOriginal) {
        if (entry.mrs && entry.mrs.length > 0) {
          targetMrs = entry.mrs.map((m) => ({ project: m.project, iid: m.iid }));
          break;
        }
      }
    }

    const fetchMessageData = async () => {
      try {
        const res = await this.getMessage(convId, msgId);
        if (!res?.ok || !res.value) return null;
        return res.value;
      } catch (err) {
        log(`Failed to fetch message ${msgId} for reaction mirroring: ${err.message}`);
        return null;
      }
    };

    let msgData = await fetchMessageData();
    if (!msgData) return;

    if (targetMrs.length === 0 && msgData.content) {
      const fullText = buildMessageSearchText(msgData, { includeQuotes: true });
      targetMrs = this.gitlab.findMrLinks(fullText, { allowQuotes: true });
    }

    if (targetMrs.length === 0) return;

    // Collect desired emoji names from user's own reactions (excluding reactions placed by the bot)
    const selfReactions = (msgData.reactions || []).filter(
      (r) => this.isReactorSelf(r.user) && !this.isBotReaction(msgId, r.key)
    );
    const desiredEmojiNames = new Set();
    for (const r of selfReactions) {
      const emojiName = teamsReactionToGitLabEmoji(r.key);
      if (emojiName) {
        desiredEmojiNames.add(emojiName);
      }
    }

    for (const mr of targetMrs) {
      await this.syncMrAwardEmojis(mr.project, mr.iid, desiredEmojiNames);
    }
  }

  async handleTokenRenewalReaction(event) {
    const msgId = String(event.messageId);
    if (!this.pendingTokenRenewalMessageIds || !this.pendingTokenRenewalMessageIds.has(msgId)) {
      return;
    }
    const convId = event.conversationId;

    const fetchMessageData = async () => {
      try {
        const res = await this.getMessage(convId, msgId);
        if (!res?.ok || !res.value) return null;
        return res.value;
      } catch (err) {
        log(`Failed to fetch message ${msgId} for token renewal reaction check: ${err.message}`);
        return null;
      }
    };

    let msgData = await fetchMessageData();
    if (!msgData) return;

    const findAdminThumbUp = (reactions) => {
      if (!reactions || !Array.isArray(reactions)) return null;
      for (const r of reactions) {
        const key = (r.key || '').toLowerCase();
        const isThumbUp = key === 'like' || key === '👍' || key.includes('thumb');
        if (isThumbUp && this.isReactorSelf(r.user) && !this.isBotReaction(msgId, r.key)) {
          return r;
        }
      }
      return null;
    };

    let adminThumb = findAdminThumbUp(msgData.reactions);
    if (!adminThumb) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const retryData = await fetchMessageData();
      if (retryData?.reactions) {
        msgData = retryData;
        adminThumb = findAdminThumbUp(msgData.reactions);
      }
    }

    if (!adminThumb) return;

    // Remove from pending so we don't trigger repeatedly
    this.pendingTokenRenewalMessageIds.delete(msgId);
    this.saveState();

    log(`👍 Reaction detected from admin on token renewal alert ${msgId}. Rotating token...`);
    await this.setCommandReaction(convId, msgId, COMMAND_REACTIONS.pending).catch(() => {});

    try {
      const renewal = await this.renewGitLabToken({ reason: 'reaction' });
      await this.setCommandReaction(convId, msgId, COMMAND_REACTIONS.success).catch(() => {});

      let replyText =
        '✅ **GitLab Personal Access Token Renewed via 👍 Reaction!**\n\n' +
        `- **New Expiry**: ${renewal.rotated?.expires_at || 'unknown'}\n`;

      if (renewal.isReadOnlySecret) {
        replyText +=
          `- **Saved to Override**: \`${renewal.savedPath}\`\n\n` +
          '⚠️ **Action Required**: The configured secret file is read-only.\n' +
          'Please update the secret in your host configuration/SOPS:\n' +
          `\`cat ${renewal.savedPath}\``;
      } else {
        replyText += `- **Saved to**: \`${renewal.savedPath}\``;
      }

      await sendReply(convId, { messageId: msgId }, replyText);
    } catch (err) {
      log(`Failed to renew GitLab token on reaction: ${err.message}`);
      await this.setCommandReaction(convId, msgId, COMMAND_REACTIONS.failure).catch(() => {});
      await sendReply(convId, { messageId: msgId }, `❌ Failed to rotate GitLab token: ${err.message}`);
    }
  }

  async handleMessageUpdate(event) {
    const msgId = String(event.messageId);
    let suggestion = this.pendingSuggestions.get(msgId);
    if (!suggestion && this.typoMessageToSuggestion.has(msgId)) {
      const replyId = this.typoMessageToSuggestion.get(msgId);
      suggestion = this.pendingSuggestions.get(replyId);
    }
    if (suggestion) {
      await this.handleSuggestionReaction(event, suggestion);
      return;
    }

    if (this.pendingTokenRenewalMessageIds?.has(msgId)) {
      await this.handleTokenRenewalReaction(event);
      return;
    }

    await Promise.all([
      this.handleMrReactionApproval(event),
      this.handleMrReactionMirroring(event),
    ]);
  }

  async handleIncomingEvent(event) {
    const convId = event.conversationId;
    let decodedConvId = convId;
    try {
      decodedConvId = decodeURIComponent(convId);
    } catch {}

    if (!this.watchedConversations.has(convId) && !this.watchedConversations.has(decodedConvId)) return;

    if (event.kind === 'MessageUpdate') {
      await this.handleMessageUpdate(event);
      return;
    }

    if (event.kind !== 'NewMessage') return;

    if (event.messageId) {
      if (this.seenMessageIds.has(String(event.messageId))) return;
      this.markSeen(event.messageId);
    }

    // Ignore bot's own messages immediately to prevent self-trigger loops
    if (
      botSentMessageIds.has(String(event.messageId)) ||
      botSentMessageIds.has(String(event.clientMessageId)) ||
      event.content?.includes(BOT_WATERMARK) ||
      event.rawHtml?.includes(BOT_WATERMARK) ||
      this.isOwnMessage(event.fromMri, event.content, event.messageId, event.clientMessageId, event.rawHtml)
    ) {
      return;
    }

    // If sender is banned, ignore all processing and respond only with ⛔ reaction
    if (this.isUserBanned(event.from, event.fromMri)) {
      log(`Ignoring message from banned user ${event.from || event.fromMri} in ${event.conversationId} and reacting with ⛔`);
      if (event.messageId) {
        addReaction(event.conversationId, event.messageId, BAN_REACTION).catch((err) => {
          log(`Failed to add ban reaction ⛔ to message ${event.messageId}: ${err.message}`);
        });
      }
      return;
    }

    // Check for slash commands first (even from self)
    if (this.isSlashCommand(event.content)) {
      try {
        await this.handleSlashCommand(event);
      } catch (err) {
        log(`Error executing slash command: ${err.message}`);
      }
      return;
    }

    // If message is from self, check for unrecognized links to edit message with thumbnail
    if (this.isSenderSelf(event) && !event.isHistory) {
      this.maybeAttachLinkThumbnail(event).catch((err) => {
        log(`[thumbnail] Error attaching thumbnail to message ${event.messageId}: ${err.message}`);
      });
    }

    if (this.isOwnMessage(event.fromMri, event.content, event.messageId, event.clientMessageId, event.rawHtml)) return;

    const fullText = buildMessageSearchText(event);
    this.watch(event.conversationId, event.messageId, fullText, {
      from: event.from,
      fromMri: event.fromMri,
      content: event.content || '',
      rawHtml: event.rawHtml || '',
      links: event.links ?? [],
    });
  }

  markSeen(messageId) {
    this.seenMessageIds.add(String(messageId));
    if (this.seenMessageIds.size > 2000) {
      // Sets iterate in insertion order: drop the oldest half.
      const drop = [...this.seenMessageIds].slice(0, 1000);
      for (const id of drop) this.seenMessageIds.delete(id);
    }
  }

  // Periodic fallback for pushes that Teams silently stops delivering.
  startHistoryPoll(intervalMs, { onMissedPush } = {}) {
    if (this.historyPollTimer) clearInterval(this.historyPollTimer);
    if (!intervalMs || intervalMs <= 0) return;
    log(`Polling watched conversations every ${Math.round(intervalMs / 1000)}s as push fallback`);
    this.historyPollTimer = setInterval(async () => {
      try {
        const missed = await this.pollHistory({ reason: 'poll', minAgeMs: 30_000 });
        if (missed > 0) onMissedPush?.(missed);
      } catch (err) {
        log(`History poll failed: ${err.message}`);
      }
    }, intervalMs);
    if (this.historyPollTimer.unref) this.historyPollTimer.unref();
  }

  // Returns the number of messages handled that had not been pushed.
  async pollHistory({ reason = 'poll', minAgeMs = 0 } = {}) {
    if (this.historyPollRunning) return 0;
    this.historyPollRunning = true;
    try {
      return await this.watchHistory({ quiet: true, reason, minAgeMs });
    } finally {
      this.historyPollRunning = false;
    }
  }

  async watchHistory({ quiet = false, reason = 'startup', minAgeMs = 0 } = {}) {
    // Polls reuse the cached tokens; refreshing is the auth manager's job.
    const auth = (quiet && this.authManager.getCachedAuth()) || (await this.authManager.ensureValidAuth());
    const self = auth.userMri;
    this.setSelfMri(self);

    const now = Date.now();
    const cutoffTime = now - this.historyMaxAgeMinutes * 60 * 1000;
    const processedHistoryCommands = new Set();
    let missed = 0;

    for (const conversationId of this.watchedConversations) {
      if (!quiet) {
        log(
          `Scanning recent history of ${conversationId} (limit ${this.historyLimit}, max age ${this.historyMaxAgeMinutes}m)...`
        );
      }
      let result = await getThreadMessages(conversationId, {
        limit: this.historyLimit,
        startTime: cutoffTime,
      });
      if (!result.ok) {
        log(`History scan of ${conversationId} failed (${result.error?.message}), retrying in 2s...`);
        await new Promise((r) => setTimeout(r, 2000));
        result = await getThreadMessages(conversationId, {
          limit: this.historyLimit,
          startTime: cutoffTime,
        });
      }
      if (!result.ok) {
        log(`History scan retry of ${conversationId} failed: ${result.error?.message}`);
        continue;
      }

      for (const msg of result.value.messages) {
        if (this.completedMessages.has(String(msg.id))) continue;
        if (botSentMessageIds.has(String(msg.id))) continue;
        if (this.seenMessageIds.has(String(msg.id))) continue;

        const msgTime = msg.composeTime ? new Date(msg.composeTime).getTime() : Number(msg.id) || 0;
        if (msgTime && msgTime < cutoffTime) continue;
        // Leave very recent messages to push, which may still be on its way.
        if (minAgeMs > 0 && msgTime && now - msgTime < minAgeMs) continue;
        // Push only delivers text messages; calls, cards and system events never arrive.
        const type = msg.contentType ?? msg.messageType;
        if (type && type !== 'Text' && !String(type).startsWith('RichText')) continue;

        const senderMri = msg.sender?.mri?.split('/contacts/').pop();
        if (this.isOwnMessage(senderMri, msg.content, msg.id, msg.clientMessageId, msg.content)) continue;

        this.markSeen(msg.id);
        if (reason !== 'startup') {
          missed++;
          log(`[${reason}] Message ${msg.id} in ${conversationId} was not pushed, handling it from history`);
        }

        // If sender is banned, do not process and ensure ⛔ reaction is present
        if (this.isUserBanned(msg.sender?.displayName, senderMri)) {
          const hasBanReaction = (msg.reactions ?? []).some((r) => r.user?.mri === self && r.key === BAN_REACTION);
          if (!hasBanReaction && msg.id) {
            addReaction(conversationId, msg.id, BAN_REACTION).catch(() => {});
          }
          continue;
        }

        // Check if message is an unhandled slash command from recent history
        if (this.isSlashCommand(msg.content)) {
          const parsed = this.parseSlashCommand(msg.content);
          if (parsed) {
            const dedupKey = `${conversationId}:${parsed.command}:${parsed.args.join(' ')}`.toLowerCase();
            if (processedHistoryCommands.has(dedupKey)) {
              log.debug(`Skipping duplicate slash command from history: "${msg.content}" in ${conversationId}`);
              continue;
            }
            processedHistoryCommands.add(dedupKey);
          }

          const hasOwnReaction = (msg.reactions ?? []).some((r) => r.user?.mri === self);
          if (!hasOwnReaction) {
            log(
              `Processing missed slash command from history: "${msg.content}" from ${msg.sender?.displayName || senderMri} in ${conversationId}`
            );
            this.handleSlashCommand({
              kind: 'NewMessage',
              conversationId,
              messageId: msg.id,
              clientMessageId: msg.clientMessageId,
              content: msg.content,
              from: msg.sender?.displayName,
              fromMri: senderMri,
              links: (msg.links ?? []).map((l) => l.url),
            }).catch((err) => log(`Error executing missed slash command from history: ${err.message}`));
          }
          continue;
        }

        const ownReactions = (msg.reactions ?? [])
          .filter((r) => r.user?.mri === self)
          .map((r) => STATUS_BY_REACTION.get(r.key))
          .filter(Boolean);

        if (ownReactions.includes('merged')) continue;

        const currentStatus = ownReactions.find(Boolean) ?? null;
        const text = buildMessageSearchText({ content: msg.content, links: msg.links });

        this.watch(conversationId, msg.id, text, {
          from: msg.sender?.displayName || '',
          fromMri: senderMri || '',
          content: msg.content || '',
          rawHtml: msg.content || '',
          links: msg.links ?? [],
          initialStatus: currentStatus,
          isHistory: true,
        });
      }
    }
    return missed;
  }

  scheduleNextPrecompute() {
    if (this.precomputeTimer) {
      clearTimeout(this.precomputeTimer);
      this.precomputeTimer = null;
    }
    // Base 10 minutes with +/- 2 minutes jitter (8 to 12 minutes)
    const jitterMs = Math.floor((Math.random() * 4 - 2) * 60 * 1000);
    const delay = Math.max(60 * 1000, this.precomputeIntervalMs + jitterMs);
    log.debug(`Scheduling next precompute in ${(delay / 1000 / 60).toFixed(1)}m (jitter: ${(jitterMs / 1000).toFixed(0)}s)`);
    this.precomputeTimer = setTimeout(async () => {
      await this.runPrecompute();
      this.scheduleNextPrecompute();
    }, delay);
    if (this.precomputeTimer.unref) this.precomputeTimer.unref();
  }

  async runPrecompute() {
    log.debug('Precomputing /mrs, /alerts, /sprint, and /meetings cache in background...');
    await Promise.allSettled([
      this.getOrFetchMrsData({ force: true }).catch((err) => log(`Precompute /mrs failed: ${err.message}`)),
      this.getOrFetchAlertsData({ force: true }).catch((err) => log(`Precompute /alerts failed: ${err.message}`)),
      this.getOrFetchSprintText({ force: true }).catch((err) => log(`Precompute /sprint failed: ${err.message}`)),
      this.getOrFetchMeetingsText({ force: true }).catch((err) => log(`Precompute /meetings failed: ${err.message}`)),
    ]);
    log.debug('Precompute /mrs, /alerts, /sprint, and /meetings cache completed');
    if (this.hrworks) {
      this.hrworks.prefetchAllAbsences().catch((err) => log(`Precompute HRworks absences failed: ${err.message}`));
    }
  }

  startPrecompute() {
    // Initial run after brief delay with jitter (5 to 15 seconds)
    const initialDelay = 5_000 + Math.floor(Math.random() * 10_000);
    if (this.precomputeTimer) clearTimeout(this.precomputeTimer);
    this.precomputeTimer = setTimeout(async () => {
      await this.runPrecompute();
      this.scheduleNextPrecompute();
    }, initialDelay);
    if (this.precomputeTimer.unref) this.precomputeTimer.unref();
  }

  startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.checkAllWatched().catch((err) => log(`Initial polling check failed: ${err.message}`));
    this.pollTimer = setInterval(() => {
      this.checkAllWatched().catch((err) => log(`Polling check failed: ${err.message}`));
    }, this.pollIntervalMs);

    if (this.pollTimer.unref) this.pollTimer.unref();
    this.startPrecompute();

    // Check GitLab token expiry and auto-renew on startup and every 6 hours
    this.checkGitLabTokenExpiryAndAutoRenew().catch((err) =>
      log(`GitLab token expiry check failed: ${err.message}`)
    );
    if (this.tokenExpiryCheckTimer) clearInterval(this.tokenExpiryCheckTimer);
    this.tokenExpiryCheckTimer = setInterval(() => {
      this.checkGitLabTokenExpiryAndAutoRenew().catch((err) =>
        log(`Periodic GitLab token expiry check failed: ${err.message}`)
      );
    }, 6 * 60 * 60 * 1000); // 6 hours
    if (this.tokenExpiryCheckTimer.unref) this.tokenExpiryCheckTimer.unref();
    this.serviceAlerts.start();
  }

  stop() {
    this.serviceAlerts?.stop();
    if (this.historyPollTimer) {
      clearInterval(this.historyPollTimer);
      this.historyPollTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.precomputeTimer) {
      clearTimeout(this.precomputeTimer);
      this.precomputeTimer = null;
    }
    if (this.tokenExpiryCheckTimer) {
      clearInterval(this.tokenExpiryCheckTimer);
      this.tokenExpiryCheckTimer = null;
    }
  }
}

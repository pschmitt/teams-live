import { assembleCard, ciStatusEmoji, ciStatusIcon, ciStatusInfo, mdLink, textBlock } from './cards.mjs';
import { approvalBadge, approvalBadgeText } from './approval-badges.mjs';
import { fallbackAvatar, isImageDataUri, pictureItem, pillImage, planCardAvatars } from './card-user-row.mjs';
import { GITLAB_ICONS_SMALL } from './gitlab-icons-small.mjs';

const column = (items, width = 'auto') => ({ type: 'Column', width, verticalContentAlignment: 'Center', items });
const columns = (items, spacing = 'Small') => ({ type: 'ColumnSet', spacing, columns: items });
const image = (url, alt, size = 16) => ({ type: 'Image', url, altText: alt, width: `${size}px`, height: `${size}px` });
const person = (name, planned, profiles, badged = false) => pictureItem(name, isImageDataUri(planned(name)) ? planned(name) : fallbackAvatar(name), { profile: profiles?.[name], badged });
const link = (value) => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; } };
const escapeText = (value) => String(value ?? '').replace(/([\\`*_{}\[\]()<>#!|])/g, '\\$1');

/** Build a combined status card from already fetched MR data. */
export function buildMultiMrCard(mrs, { approveUrl = null, mergeUrl = null, openUrl = null, fallbackText = '', images = true, listMode = false, headline = '', part = null } = {}) {
  const people = mrs.flatMap((mr) => [mr.author, ...(mr.approvedBy || [])].filter(Boolean).map((name) => ({ name, avatar: mr.avatars?.[name], compact: true })));
  const planned = planCardAvatars(people, 3500);
  const rows = mrs.map((mr) => {
    const stateIcon = mr.state === 'merged' ? 'merge' : mr.state === 'closed' ? 'merge-request-close' : mr.draft ? 'merge-request' : 'merge-request-open';
    const title = textBlock(escapeText(mr.title || `Merge request !${mr.iid}`), { weight: 'Bolder', size: 'Medium', color: 'Accent' });
    const url = link(mr.url);
    const target = url ? { type: 'Container', selectAction: { type: 'Action.OpenUrl', url }, items: [title] } : title;
    const metadata = [column([textBlock(mr.project, { size: 'Small', isSubtle: true })])];
    if (mr.author) {
      if (images && mr.showAuthorAvatar !== false) metadata.push(column([person(mr.author, planned, mr.profiles)]));
      metadata.push(column([textBlock(mr.author, { size: 'Small', isSubtle: true })], 'stretch'));
    }
    const statuses = [];
    const pill = approvalBadge(mr);
    if (pill) statuses.push(images ? pillImage(pill) : textBlock(approvalBadgeText(mr), { size: 'Small', weight: 'Bolder' }));
    else if (mr.approved == null) statuses.push(textBlock('Approval unknown', { size: 'Small', isSubtle: true }));
    for (const name of mr.approvedBy || []) statuses.push(images ? person(name, planned, mr.profiles, (mr.approvedVia || []).includes(name)) : textBlock(name, { size: 'Small' }));
    if (mr.pipeline?.status) {
      const icon = ciStatusIcon(mr.pipeline.status);
      if (images) statuses.push(image(icon.url, icon.alt));
      statuses.push(textBlock(`${images ? '' : `${ciStatusEmoji(mr.pipeline.status)} `}${ciStatusInfo(mr.pipeline.status).label}`, { size: 'Small' }));
    }
    if (typeof mr.autoMerge === 'boolean' && mr.state !== 'merged' && mr.state !== 'closed') {
      const label = `Auto-merge ${mr.autoMerge ? 'On' : 'Off'}`;
      if (images) statuses.push(image(GITLAB_ICONS_SMALL[mr.autoMerge ? 'clock' : 'status_pending'], label));
      statuses.push(textBlock(label, { size: 'Small', isSubtle: true }));
    }
    if (mr.rebaseInProgress) statuses.push(textBlock('🔄 Rebase in progress', { size: 'Small' }));
    else if (mr.hasConflicts && !mr.needsRebase && mr.state === 'open') statuses.push(textBlock('⚠️ Conflicts', { size: 'Small', color: 'Warning' }));
    else if (mr.needsRebase && mr.state === 'open') statuses.push(textBlock(mr.hasConflicts ? '⚠️ Rebase required · conflicts' : '⚠️ Rebase required', { size: 'Small', color: 'Warning' }));
    if (mr.jira?.key) statuses.push(textBlock(`🎫 ${mdLink(mr.jira.key, mr.jira.url)}`, { size: 'Small' }));
    return {
      type: 'Container', separator: true, spacing: 'Medium', items: [
        columns([column([images ? image(GITLAB_ICONS_SMALL[stateIcon], mr.draft && mr.state === 'open' ? 'Draft' : mr.state || 'open') : textBlock(mr.state === 'merged' ? '🔀' : '◉')]), column([target], 'stretch'), column([textBlock(mdLink(`!${mr.iid}`, url), { size: 'Large', weight: 'Bolder' })])]),
        columns(metadata),
        ...(statuses.length ? [{ type: 'Container', spacing: 'Small', layouts: [{ type: 'Layout.Flow', horizontalItemsAlignment: 'Left', verticalItemsAlignment: 'Center', columnSpacing: 'Small', rowSpacing: 'Small' }], items: statuses }] : []),
      ],
    };
  });
  return assembleCard({
    service: 'gitlab', kind: 'Merge requests', glyph: { icon: 'merge-request-open', label: 'Merge requests' }, title: null,
    headerExtra: listMode ? (part ? [column([textBlock(`${part[0]}/${part[1]}`, { size: 'Small', isSubtle: true })])] : []) : [column([image(GITLAB_ICONS_SMALL.merge, 'Merged', 20)]), column([textBlock(`${mrs.filter((mr) => mr.state === 'merged').length}/${mrs.length}`, { size: 'Large', weight: 'Bolder' })])],
    extraItems: listMode ? [textBlock(headline), ...rows.flatMap((row, index) => [
      ...(mrs[index].sectionHeading ? [textBlock(mrs[index].sectionHeading, { weight: 'Bolder' })] : []),
      row,
      ...(mrs[index].sectionNote ? [textBlock(mrs[index].sectionNote, { size: 'Small', isSubtle: true })] : []),
    ])] : rows,
    actions: [{ title: '👍 Approve all', url: approveUrl }, { title: '🔀 Merge all', url: mergeUrl }, { title: '🔗 Open all', url: openUrl }],
    fallbackText,
  });
}

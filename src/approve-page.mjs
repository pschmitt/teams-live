// The look and the content of the capability-link pages (approve, reopen, merge): GitLab-inspired
// styling, the merge request with its links, and the live status that keeps an open page current.
//
// Pure functions: data in, HTML out. Nothing here talks to GitLab or reads a request. Every value that
// reaches the HTML goes through `escapeHtml`, every link through `safeLink` (http(s) on the GitLab host).

import { ciStatusIcon, ciStatusInfo } from './cards.mjs';
import { GITLAB_ICONS_SMALL } from './gitlab-icons-small.mjs';
import { fallbackAvatar } from './card-user-row.mjs';

export const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// GitLab-inspired (Pajamas: a calm neutral page, white panels, blue links, green/blue/red state pills) but its
// own page, branded teams-live. The state colors match the badges on the Teams card. Everything is inline (the
// CSP allows no stylesheet, font or image from elsewhere); motion is CSS only and off with reduced motion.
export const PAGE_CSS = [
  ':root{color-scheme:light dark;--bg:#fbfafd;--panel:#fff;--subtle:#f5f4f8;--text:#333238;--muted:#626168;--line:#dcdcde;--line-strong:#bfbfc3;--accent:#1068bf;--focus:#428fdc;--code:#ececef;--bar:#1f1e24;--bar-text:#ececef;',
  '--ok:#108548;--ok-bg:#ecf4ee;--merged:#1f75cb;--merged-bg:#e9f3fc;--closed:#dd2b0e;--closed-bg:#fdf1ef;--draft:#626168;--draft-bg:#ececef;--run:#1f75cb;--run-bg:#e9f3fc;--warn:#9d6e00;--warn-bg:#fdf1dd;--btn:#1f75cb;--btn-h:#1068bf;--btn-text:#fff;',
  '--shadow:0 1px 2px rgba(5,5,6,.06),0 4px 16px rgba(5,5,6,.07);--shadow-lg:0 8px 32px rgba(5,5,6,.16);--ease:cubic-bezier(.2,.8,.2,1);--spring:cubic-bezier(.34,1.56,.64,1);--mono:ui-monospace,"GitLab Mono",SFMono-Regular,Menlo,Consolas,monospace}',
  // Dark: the system's choice unless the visitor picked a theme (data-theme on <html>, from the tl_theme cookie).
  '@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#18171d;--panel:#232228;--subtle:#1e1d23;--text:#ececef;--muted:#a4a3a8;--line:#3a383f;--line-strong:#535158;--accent:#63a6e9;--focus:#63a6e9;--code:#333238;--bar:#101014;--bar-text:#ececef;--ok:#52b87a;--ok-bg:#16301f;--merged:#63a6e9;--merged-bg:#1d3047;--closed:#f57f6c;--closed-bg:#3d1c17;--draft:#a4a3a8;--draft-bg:#333238;--run:#63a6e9;--run-bg:#1d3047;--warn:#e9be74;--warn-bg:#3a2e12;--btn:#2a6fb8;--btn-h:#1d63b0;--btn-text:#fff;--shadow:0 1px 2px rgba(0,0,0,.3),0 4px 16px rgba(0,0,0,.3);--shadow-lg:0 8px 32px rgba(0,0,0,.5);color-scheme:dark}}',
  ':root[data-theme=dark]{--bg:#18171d;--panel:#232228;--subtle:#1e1d23;--text:#ececef;--muted:#a4a3a8;--line:#3a383f;--line-strong:#535158;--accent:#63a6e9;--focus:#63a6e9;--code:#333238;--bar:#101014;--bar-text:#ececef;--ok:#52b87a;--ok-bg:#16301f;--merged:#63a6e9;--merged-bg:#1d3047;--closed:#f57f6c;--closed-bg:#3d1c17;--draft:#a4a3a8;--draft-bg:#333238;--run:#63a6e9;--run-bg:#1d3047;--warn:#e9be74;--warn-bg:#3a2e12;--btn:#2a6fb8;--btn-h:#1d63b0;--btn-text:#fff;--shadow:0 1px 2px rgba(0,0,0,.3),0 4px 16px rgba(0,0,0,.3);--shadow-lg:0 8px 32px rgba(0,0,0,.5);color-scheme:dark}:root[data-theme=light]{color-scheme:light}',
  '*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{display:flex;flex-direction:column;min-height:100vh;min-height:100dvh;margin:0;background:var(--bg);color:var(--text);font:14px/1.5 "GitLab Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans",Ubuntu,Cantarell,"Helvetica Neue",sans-serif}',
  'a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:4px}',
  // the top bar: the tanuki, the product, what this page is for, and who is signed in
  '.brand{position:sticky;top:0;z-index:10;margin:0 0 1.5rem;padding:.55rem max(1rem,env(safe-area-inset-right,0px)) .55rem max(1rem,env(safe-area-inset-left,0px));background:var(--bar);color:var(--bar-text);font-size:.9rem}.brand .in{display:flex;align-items:center;gap:.5rem;max-width:44rem;margin:0 auto;min-height:32px}.brand.wide .in{max-width:58rem}.brand.dashboard .in{max-width:none}',
  '.brand .home{display:inline-flex;align-items:center;gap:.5rem;color:var(--bar-text);border-radius:6px;padding:.15rem .35rem;margin:-.15rem -.35rem;transition:background .15s}.brand .home:hover{background:rgba(255,255,255,.1);text-decoration:none}.brand .home svg{transition:transform .3s var(--spring)}.brand .home:hover svg{transform:rotate(-8deg) scale(1.08)}',
  '.brand svg{flex:none}.brand .word{font-weight:700}.brand .sep{opacity:.45}.brand .kicker{opacity:.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.brand a.word{color:var(--bar-text)}',
  '.live-dot{display:inline-flex;align-items:center;gap:.4rem;font-size:.78rem;opacity:.85;margin-left:auto;white-space:nowrap}.live-dot i{width:7px;height:7px;border-radius:50%;background:#52b87a;position:relative}.live-dot i::after{content:"";position:absolute;inset:-4px;border-radius:50%;border:2px solid #52b87a;animation:tl-ping 2s var(--ease) infinite}',
  '@keyframes tl-ping{0%{transform:scale(.4);opacity:.9}100%{transform:scale(1.4);opacity:0}}',
  '.dash-link{margin-left:auto;color:var(--bar-text);font-weight:600;padding:.25rem .65rem;border-radius:6px;transition:background .15s}.dash-link:hover{background:rgba(255,255,255,.12);color:var(--bar-text);text-decoration:none}.live-dot+.dash-link,.dash-link+.header-account{margin-left:.5rem}',
  '.header-account{margin-left:auto;display:inline-flex;align-items:center;gap:.5rem;color:var(--bar-text);font-weight:600}.live-dot+.header-account{margin-left:.75rem}.account-avatar{width:32px;height:32px;border-radius:50%;object-fit:cover;box-shadow:0 0 0 2px rgba(255,255,255,.2);display:block;transition:box-shadow .15s}',
  '.header-account{position:relative}.header-account summary{list-style:none;cursor:pointer;border-radius:50%}.header-account summary::-webkit-details-marker{display:none}.header-account summary:hover .account-avatar,.header-account[open] .account-avatar{box-shadow:0 0 0 2px var(--btn)}',
  '.account-menu{position:absolute;right:0;top:calc(100% + 8px);z-index:20;min-width:15rem;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow-lg);padding:.35rem;font-weight:400;transform-origin:top right;animation:tl-menu .16s var(--ease)}',
  '@keyframes tl-menu{from{opacity:0;transform:scale(.96) translateY(-4px)}to{opacity:1;transform:none}}',
  '.menu-who{display:grid;padding:.45rem .6rem .55rem;border-bottom:1px solid var(--line);margin-bottom:.3rem}.menu-who span{color:var(--muted);font-size:.85rem}',
  '.menu-theme{white-space:nowrap;display:flex;align-items:center;gap:.5rem;padding:.35rem .6rem .45rem}.menu-theme>span:first-child{font-size:.85rem;color:var(--muted);flex:1}.theme-seg{flex:none;display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden}.theme-seg button{flex:none;white-space:nowrap;font:inherit;font-size:.78rem;border:0;background:none;color:var(--muted);padding:.2rem .55rem;cursor:pointer;transition:background .15s,color .15s}.theme-seg button+button{border-left:1px solid var(--line)}.theme-seg button:hover{color:var(--text)}.theme-seg button[aria-pressed=true]{background:var(--run-bg);color:var(--run);font-weight:600}',
  '.account-menu svg{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.menu-item svg,.menu-theme>span:first-child svg{color:var(--muted)}.theme-seg button{display:inline-flex;align-items:center;gap:.3rem}.theme-seg svg{width:13px;height:13px}.menu-theme>span:first-child{display:inline-flex;align-items:center;gap:.6rem}',
  '.menu-item{display:flex;align-items:center;gap:.6rem;width:100%;text-align:left;font:inherit;color:var(--text);background:none;border:0;border-radius:6px;padding:.45rem .6rem;cursor:pointer}.menu-item:hover{background:var(--subtle);text-decoration:none}.menu-sep{border-top:1px solid var(--line);margin:.3rem 0}.account-menu form{margin:0}',
  '.shell{flex:1;display:flex;flex-direction:column;width:100%;max-width:46rem;margin:0 auto;padding:0 max(1rem,env(safe-area-inset-right,0px)) 0 max(1rem,env(safe-area-inset-left,0px))}.shell.wide{max-width:60rem}',
  '.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:1.25rem 1.35rem 1.35rem;box-shadow:var(--shadow);animation:tl-rise .45s var(--ease) both}',
  '@keyframes tl-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
  // the page title, with a status picture on finished pages (drawn in, like the checkmark of a passed pipeline)
  '.page-head{display:flex;align-items:center;gap:.75rem;margin:0 0 1rem}.page-head h1{margin:0}',
  '.hero{flex:none;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;animation:tl-pop .5s var(--spring) both}.hero svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}',
  '.hero path{stroke-dasharray:40;stroke-dashoffset:40;animation:tl-draw .55s .2s var(--ease) forwards}.hero-ok{background:var(--ok-bg);color:var(--ok)}.hero-warn{background:var(--warn-bg);color:var(--warn)}.hero-error{background:var(--closed-bg);color:var(--closed)}',
  '@keyframes tl-pop{from{transform:scale(.5);opacity:0}to{transform:none;opacity:1}}@keyframes tl-draw{to{stroke-dashoffset:0}}',
  'h1{font-size:1.3rem;font-weight:600;line-height:1.3;margin:0 0 1rem;text-wrap:balance}p{margin:.6rem 0}',
  'code{background:var(--code);padding:.05rem .3rem;border-radius:4px;font:.88em var(--mono)}',
  '.note{color:var(--muted);font-size:.9rem}',
  // the merge request: GitLab's merge request header, then its checks as the sections of a merge widget
  '.mr{border:1px solid var(--line);border-radius:8px;margin:0 0 1rem;background:var(--panel);overflow:hidden}',
  '.mr-head{padding:.85rem 1rem .75rem}',
  '.mr-top{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem .6rem;color:var(--muted);font-size:.88rem}.mr-top .ref{font-weight:600}',
  '.mr-title{font-size:1.15rem;font-weight:600;line-height:1.35;margin:.4rem 0 .2rem;text-wrap:balance;overflow-wrap:anywhere}.mr-title a{color:var(--text)}',
  '.mr-branches{margin:.2rem 0 0;color:var(--muted);font-size:.88rem;overflow-wrap:anywhere;display:flex;flex-wrap:wrap;gap:.25rem .4rem;align-items:center}',
  '.mr-branches code{background:var(--merged-bg);color:var(--merged)}.mr-branches a:hover{text-decoration:none}.mr-branches a:hover code{text-decoration:underline}',
  '.mr-facts{margin:0;border-top:1px solid var(--line);background:var(--subtle)}',
  '.mr-facts .fact{display:grid;grid-template-columns:28px 7.5rem minmax(0,1fr);gap:.6rem;align-items:center;padding:.6rem 1rem;border-top:1px solid var(--line);font-size:.9rem}.mr-facts .fact:first-child{border-top:0}',
  '.mr-facts dt{color:var(--muted)}.mr-facts dd{margin:0;overflow-wrap:anywhere;min-width:0}',
  '.wic{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:var(--draft-bg);color:var(--draft);transition:background .4s,color .4s}.wic svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
  '.fact:has(.pill-ok) .wic,.fact:has(.appr-done) .wic,.fact:has(.ms-ok) .wic{background:var(--ok-bg);color:var(--ok)}.fact:has(.pill-bad) .wic,.fact:has(.ms-bad) .wic{background:var(--closed-bg);color:var(--closed)}',
  '.fact:has(.pill-run) .wic,.fact:has(.am-on) .wic{background:var(--run-bg);color:var(--run)}.fact:has(.appr-wait) .wic,.fact:has(.ms-wait) .wic{background:var(--warn-bg);color:var(--warn)}',
  '.appr-meter{display:inline-block;vertical-align:middle;width:3.5rem;height:6px;border-radius:3px;background:var(--line);overflow:hidden;margin-right:.5rem}.appr-meter i{display:block;height:100%;background:var(--warn);border-radius:3px;transition:width .6s var(--ease),background .4s}.appr-done .appr-meter i{background:var(--ok)}',
  '[data-live].tl-changed{animation:tl-flash 1.2s var(--ease)}@keyframes tl-flash{0%{background:var(--run-bg);box-shadow:0 0 0 4px var(--run-bg)}100%{background:transparent;box-shadow:0 0 0 4px transparent}}',
  // the batch pages: a GitLab merge request list, one row per merge request with its outcome
  '.batch-list{display:grid;gap:.75rem;margin:1rem 0}.batch-item{border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--panel);transition:border-color .3s,box-shadow .3s;animation:tl-rise .4s var(--ease) both}',
  '.batch-item:nth-child(2){animation-delay:.05s}.batch-item:nth-child(3){animation-delay:.1s}.batch-item:nth-child(4){animation-delay:.15s}.batch-item:nth-child(n+5){animation-delay:.2s}',
  '.batch-item .mr{border:0;margin:0;border-radius:0}.batch-item .fact:nth-child(n+3){display:none}',
  '.batch-status{display:flex;gap:.5rem;align-items:center;padding:.55rem 1rem;border-top:1px solid var(--line);font-weight:600;font-size:.9rem;transition:background .4s,color .4s}',
  '.batch-actions{padding:.6rem 1rem;border-top:1px solid var(--line);display:flex;gap:.5rem;flex-wrap:wrap}.batch-actions .btn{font-size:.9rem}',
  '.batch-status[data-status=ready],.batch-status[data-status=working]{color:var(--run);background:var(--run-bg)}.batch-status[data-status=approved],.batch-status[data-status=already]{color:var(--ok);background:var(--ok-bg)}',
  '.batch-status[data-status=failed],.batch-status[data-status=blocked],.batch-status[data-status=unavailable]{color:var(--closed);background:var(--closed-bg)}.batch-status[data-status=unknown]{color:var(--warn);background:var(--warn-bg)}',
  '.batch-item[data-status=working]{border-color:var(--run);box-shadow:0 0 0 3px var(--run-bg)}.batch-status[data-status=working]{background:linear-gradient(90deg,var(--run-bg) 0%,var(--panel) 50%,var(--run-bg) 100%);background-size:200% 100%;animation:tl-shimmer 1.2s linear infinite}',
  '.batch-item[data-status=approved]{animation:tl-done .8s var(--ease)}@keyframes tl-done{0%{box-shadow:0 0 0 0 var(--ok-bg)}40%{box-shadow:0 0 0 6px var(--ok-bg)}100%{box-shadow:0 0 0 0 transparent}}',
  '@keyframes tl-shimmer{from{background-position:100% 0}to{background-position:-100% 0}}',
  '.batch-bar{position:sticky;bottom:0;z-index:5;margin:1rem -1.35rem -1.35rem;padding:.85rem 1.35rem calc(.85rem + env(safe-area-inset-bottom,0px));background:var(--panel);border-top:1px solid var(--line);border-radius:0 0 8px 8px;display:grid;gap:.6rem;box-shadow:0 -8px 16px -12px rgba(0,0,0,.25)}',
  '.batch-bar p{margin:0}.batch-bar .btn{justify-self:start}',
  '.batch-progress{width:100%;height:6px;appearance:none;-webkit-appearance:none;border:0;border-radius:3px;background:var(--line);overflow:hidden;accent-color:var(--ok)}.batch-progress::-webkit-progress-bar{background:var(--line)}.batch-progress::-webkit-progress-value{background:var(--ok);transition:width .4s var(--ease)}.batch-progress::-moz-progress-bar{background:var(--ok)}.batch-progress[hidden]{display:none}',
  '.batch-message:not(:empty){padding:.6rem .85rem;border-radius:6px;font-weight:600;animation:tl-rise .3s var(--ease)}.batch-message[data-state=working]{background:var(--run-bg);color:var(--run)}.batch-message[data-state=ok]{background:var(--ok-bg);color:var(--ok)}.batch-message[data-state=failed]{background:var(--closed-bg);color:var(--closed)}',
  // state pills, as on GitLab and the card
  '.pill{display:inline-flex;align-items:center;gap:.35rem;border-radius:999px;padding:.05rem .6rem .05rem .45rem;font-size:.8rem;font-weight:600;line-height:1.5;white-space:nowrap;transition:background .4s,color .4s}',
  '.pill i{width:.5rem;height:.5rem;border-radius:50%;background:currentColor;display:inline-block}',
  // the pictures of the Teams card: GitLab icons (16px) and people (20px, round)
  '.ic{vertical-align:-3px;flex:none}.av{border-radius:50%;vertical-align:-5px;margin-right:.4rem}.pill .ic{vertical-align:-3px;margin:0 -.1rem 0 -.2rem}.mr-top .ic{vertical-align:-3px}.person{display:inline-block;margin-right:.6rem;white-space:nowrap}',
  '.pill-open,.pill-ok{color:var(--ok);background:var(--ok-bg)}.pill-merged,.pill-run{color:var(--merged);background:var(--merged-bg)}.pill-closed,.pill-bad{color:var(--closed);background:var(--closed-bg)}.pill-draft,.pill-idle{color:var(--draft);background:var(--draft-bg)}',
  '.callout{border-radius:6px;padding:.65rem .9rem;margin:.9rem 0;background:var(--warn-bg);color:var(--text);border:1px solid var(--line);font-size:.9rem}',
  '.notice{border-radius:0;padding:.6rem 1rem;margin:0;background:var(--merged-bg);color:var(--merged);border-top:1px solid var(--line);font-size:.9rem;font-weight:600;animation:tl-rise .35s var(--ease)}.notice:empty{display:none}',
  '.actions{margin-top:1rem}.actions form>p:first-of-type{font-weight:600}.hidden{display:none}',
  '.btn{display:inline-flex;align-items:center;justify-content:center;gap:.45rem;font:inherit;font-weight:600;color:var(--btn-text);background:var(--btn);border:1px solid var(--btn);border-radius:6px;padding:.5rem 1rem;cursor:pointer;transition:background .15s,border-color .15s,box-shadow .15s,transform .1s;text-decoration:none}',
  '.btn:hover{background:var(--btn-h);border-color:var(--btn-h);text-decoration:none;box-shadow:var(--shadow)}.btn:active{transform:translateY(1px)}',
  '.btn-secondary{color:var(--text);background:var(--panel);border-color:var(--line-strong)}.btn-secondary:hover{background:var(--subtle);border-color:var(--line-strong)}',
  '.btn:disabled{opacity:.6;cursor:default;transform:none;box-shadow:none}.btn:disabled[data-busy]{opacity:.85}.btn:disabled[data-busy]::before,.btn:disabled[data-approve-item]::before{content:"";width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:tl-spin .7s linear infinite}',
  '@keyframes tl-spin{to{transform:rotate(360deg)}}',
  '.btn[hidden]{display:none}.btn:focus-visible{outline:3px solid var(--focus);outline-offset:2px}',
  '.links{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0 0}',
  '.foot{margin-top:auto;padding:2rem 0 1.25rem;text-align:center;font-size:.8rem}.foot a{display:inline-flex;align-items:center;gap:.4rem;color:var(--muted);padding:.25rem .5rem;border-radius:6px;transition:color .15s,background .15s}.foot a:hover{color:var(--text);background:var(--subtle);text-decoration:none}',
  '@media (max-width:34rem){.brand{margin-bottom:0}.shell{padding-left:0;padding-right:0}.panel{border-radius:0;border-inline:0;box-shadow:none;padding:1rem max(1rem,env(safe-area-inset-left,0px)) 1.25rem}',
  '.mr-facts .fact{grid-template-columns:24px minmax(0,1fr);gap:.15rem .6rem}.mr-facts .fact dt{grid-column:2}.mr-facts .fact dd{grid-column:2}.mr-facts .wic{grid-row:span 2}',
  '.actions{position:sticky;bottom:0;margin:1rem -1rem -1.25rem;padding:.85rem 1rem calc(.85rem + env(safe-area-inset-bottom,0px));background:var(--panel);border-top:1px solid var(--line)}.actions form>p{margin:.2rem 0 .6rem}',
  '.brand .sep,.brand .kicker{display:none}.brand .word{white-space:nowrap}.btn{width:100%}.links .btn{flex:1 1 12rem}.batch-bar{margin:1rem -1rem -1.25rem;padding-inline:1rem;border-radius:0}.batch-bar .btn{justify-self:stretch}.header-account .account-name{display:none}.foot{padding:0 1rem}}',
  '@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-delay:0s!important;animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}.hero path{stroke-dashoffset:0}}',
].join('');

const SVG = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`;
/** Line icons for the sections of the merge widget (drawn inline: the CSP allows no images from elsewhere). */
export const SECTION_ICONS = {
  author: SVG('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1-3.5 3.8-5 7-5s6 1.5 7 5"/>'),
  pipeline: SVG('<circle cx="5" cy="12" r="2.5"/><circle cx="19" cy="12" r="2.5"/><path d="M7.5 12h9"/>'),
  approvals: SVG('<path d="M7 11v9H4v-9zM7 11l4-8a2 2 0 0 1 2 2v4h5.5a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.3 20H7"/>'),
  automerge: SVG('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  merge: SVG('<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="12" r="2.2"/><path d="M6 7.2v9.6M6 7.2c0 4 4 4.8 9.8 4.8"/>'),
  commit: SVG('<circle cx="12" cy="12" r="3.5"/><path d="M3 12h5.5M15.5 12H21"/>'),
};

/** Line icons of the account menu. */
export const MENU_ICONS = {
  profile: SVG('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1-3.5 3.8-5 7-5s6 1.5 7 5"/>'),
  dashboard: SVG('<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>'),
  theme: SVG('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>'),
  auto: SVG('<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 20h8M12 17v3"/>'),
  light: SVG('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>'),
  dark: SVG('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'),
  signout: SVG('<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>'),
  settings: SVG('<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/><circle cx="12" cy="12" r="6.5"/>'),
};

/** The status picture next to the title of a finished page: a drawn checkmark, a warning or a cross. */
export function heroIcon(tone) {
  const path = { ok: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', warn: '<path d="M12 6.5v7M12 17.5v.01"/>', error: '<path d="M7 7l10 10M17 7L7 17"/>' }[tone];
  return path ? `<span class="hero hero-${tone}" aria-hidden="true">${SVG(path)}</span>` : '';
}

/** The GitHub mark for the footer link (inline: the CSP allows no images from elsewhere). */
export const GITHUB_MARK =
  '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

/** The tanuki: a simple three-color fox head, drawn inline (the CSP allows no images). */
export const TANUKI =
  '<svg width="22" height="22" viewBox="0 0 25 24" role="img" aria-label="GitLab" focusable="false"><path fill="#e24329" d="M24.507 9.5l-.034-.09L21.082.562a.896.896 0 00-1.694.091l-2.29 7.01H7.825L5.535.653a.898.898 0 00-1.694-.09L.451 9.411.416 9.5a6.297 6.297 0 002.09 7.278l.012.01.03.022 5.16 3.867 2.56 1.935 1.554 1.176a1.051 1.051 0 001.268 0l1.555-1.176 2.56-1.935 5.197-3.89.014-.01A6.297 6.297 0 0024.507 9.5z"/><path fill="#fc6d26" d="M24.507 9.5l-.034-.09a11.44 11.44 0 00-4.56 2.051l-7.447 5.632 4.742 3.584 5.197-3.89.014-.01A6.297 6.297 0 0024.507 9.5z"/><path fill="#fca326" d="M7.707 20.677l2.56 1.935 1.555 1.176a1.051 1.051 0 001.268 0l1.555-1.176 2.56-1.935-4.743-3.584-4.755 3.584z"/><path fill="#fc6d26" d="M5.01 11.461a11.43 11.43 0 00-4.56-2.05L.416 9.5a6.297 6.297 0 002.09 7.278l.012.01.03.022 5.16 3.867 4.745-3.584-7.444-5.632z"/></svg>';

/** A small embedded picture (a data URI from the card icons or a profile picture), or '' for anything else. */
function picture(src, alt, cls = 'ic', px = 16) {
  return /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(String(src ?? '')) ? `<img class="${cls}" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="${px}" height="${px}">` : '';
}

/** A person's picture: their photo when the card service has it, else their initials (as on the cards). */
export function avatarImg(name, avatars = {}) {
  return picture(avatars?.[name] || fallbackAvatar(name), name, 'av', 20);
}

/**
 * The signed-in account in the page header: the picture, which opens a small menu with the name, the GitLab profile
 * and whatever the page adds (`items`: ready HTML, such as the dashboard link or the sign-out form). A native
 * <details> element, so it works without a script; the dashboard script also closes it on an outside click.
 */
export function headerAccount(user, host, avatar = '', items = '') {
  if (!user?.username) return '';
  const name = user.name || user.username;
  const photo = picture(avatar || fallbackAvatar(name), '', 'account-avatar', 32);
  const url = safeLink(`https://${host}/${encodeURIComponent(user.username)}`, host);
  const profile = url
    ? `<a class="menu-item" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" aria-label="GitLab account ${escapeHtml(user.username)}">${MENU_ICONS.profile}Your GitLab profile</a>`
    : '';
  return (
    `<details class="header-account" data-account-menu><summary title="${escapeHtml(name)}" aria-label="Account menu of ${escapeHtml(user.username)}">${photo}</summary>` +
    `<div class="account-menu" role="menu"><div class="menu-who"><b>${escapeHtml(name)}</b><span>@${escapeHtml(user.username)}</span></div>${profile}${items}</div></details>`
  );
}

/** http(s) link on the GitLab host only: anything else (another host, a javascript: URL) yields ''. */
export function safeLink(value, host) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    if (host && url.hostname.toLowerCase() !== String(host).toLowerCase()) return '';
    return host ? url.href : '';
  } catch {
    return '';
  }
}

const anchor = (href, html) => (href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${html}</a>` : html);

/** Pill for the live state of a merge request. Draft wins over open, like the card. */
export function stateBadge(mr) {
  if (!mr?.state) return '';
  const draft = Boolean(mr.draft || mr.work_in_progress || mr.detailed_merge_status === 'draft_status');
  const [cls, label] =
    mr.state === 'merged' ? ['merged', 'Merged'] : mr.state === 'closed' ? ['closed', 'Closed'] : mr.state === 'opened' ? (draft ? ['draft', 'Draft'] : ['open', 'Open']) : ['draft', escapeHtml(mr.state)];
  const glyph = mr.state === 'merged' ? 'merge' : mr.state === 'closed' ? 'merge-request-close' : draft ? 'merge-request' : 'merge-request-open';
  return `<span class="pill pill-${cls}">${picture(GITLAB_ICONS_SMALL[glyph], '') || '<i aria-hidden="true"></i>'}${label}</span>`;
}

const PIPELINE_CLASS = { success: 'ok', success_with_warnings: 'ok', failed: 'bad', canceled: 'idle', cancelled: 'idle', skipped: 'idle', running: 'run', pending: 'run', created: 'run', preparing: 'run', waiting_for_resource: 'run', scheduled: 'idle', manual: 'idle' };

/** The pipeline as a pill linked to it, or a dash. */
export function pipelineHtml(pipeline, host) {
  if (!pipeline?.status) return '<span class="note">No pipeline</span>';
  const cls = PIPELINE_CLASS[String(pipeline.status).toLowerCase()] || 'idle';
  const label = escapeHtml(ciStatusInfo(pipeline.status).label);
  const id = pipeline.id ? ` #${escapeHtml(pipeline.id)}` : '';
  const status = picture(ciStatusIcon(pipeline.status)?.url, '') || '<i aria-hidden="true"></i>';
  return anchor(safeLink(pipeline.web_url, host), `<span class="pill pill-${cls}">${status}${label}${id}</span>`);
}

/** The approvals as text: how many of how many, or that GitLab asks for none. */
export function approvalsHtml(approvals, avatars = {}) {
  if (!approvals || approvals.known === false) return '<span class="note">Unknown</span>';
  const given = approvals.approvalsGiven;
  const required = approvals.approvalsRequired;
  const people = (Array.isArray(approvals.approvedBy) ? approvals.approvedBy : []).filter(Boolean);
  const by = people.length > 0 ? ` by ${people.map((name) => `<span class="person">${avatarImg(name, avatars)}${escapeHtml(name)}</span>`).join('')}` : '';
  if (typeof given === 'number' && typeof required === 'number' && required > 0) {
    const pct = Math.max(0, Math.min(100, Math.round((100 * given) / required)));
    const state = given >= required ? 'appr-done' : 'appr-wait';
    return `<span class="${state}"><span class="appr-meter" aria-hidden="true"><i style="width:${pct}%"></i></span>${given} of ${required} required${by}</span>`;
  }
  return approvals.approved ? `<span class="appr-done">Approved${by}</span>` : '<span class="appr-wait">Not approved yet</span>';
}

const MERGE_STATUS = {
  mergeable: 'Ready to merge',
  not_approved: 'Approval required',
  ci_still_running: 'Pipeline running',
  ci_must_pass: 'Pipeline must succeed',
  conflict: 'Has merge conflicts',
  need_rebase: 'Needs a rebase',
  draft_status: 'Draft',
  discussions_not_resolved: 'Unresolved discussions',
  checking: 'Checking',
  not_open: 'Not open',
};

const MERGE_TONE = { mergeable: 'ok', conflict: 'bad', need_rebase: 'wait', not_approved: 'wait', ci_still_running: 'wait', ci_must_pass: 'wait', discussions_not_resolved: 'wait', draft_status: 'wait', checking: 'wait' };

/** The merge status as text, tagged so the section icon can show whether it is good, waiting or bad. */
export function mergeStatusHtml(status) {
  const text = mergeStatusText(status);
  if (!text) return '<span class="note">Unknown</span>';
  const tone = MERGE_TONE[String(status).toLowerCase()] || 'wait';
  return `<span class="ms-${tone}">${escapeHtml(text)}</span>`;
}

export const mergeStatusText = (status) => {
  const key = String(status || '').toLowerCase();
  if (!key) return '';
  return MERGE_STATUS[key] || key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
};

/** What a finished merge request means for the page: whether the action is still possible, and a notice. */
export function liveState(kind, mr) {
  const state = mr?.state;
  const actionable = kind === 'reopen' ? state === 'closed' : state === 'opened';
  let notice = '';
  if (state === 'merged') notice = 'This merge request has been merged.';
  else if (state === 'closed' && kind !== 'reopen') notice = 'This merge request has been closed.';
  else if (state === 'opened' && kind === 'reopen') notice = 'This merge request is open again.';
  return { actionable, notice };
}

/**
 * The pieces of the page that change while it is open, as HTML, by slot name. The same function renders
 * the first page and the live updates, so they can never disagree.
 */
export function autoMergeHtml(mr) {
  const on = mr?.auto_merge_enabled ?? mr?.merge_when_pipeline_succeeds;
  if (typeof on !== 'boolean') return '<span class="note">Unknown</span>';
  return `<span class="${on ? 'am-on' : 'am-off'}">${picture(GITLAB_ICONS_SMALL[on ? 'clock' : 'status_pending'], '')} Auto-merge ${on ? 'on' : 'off'}</span>`;
}

export function liveSlots({ kind, mr, approvals, host, avatars = {} }) {
  const slots = { state: stateBadge(mr) };
  if (kind !== 'reopen') {
    slots.pipeline = pipelineHtml(mr?.head_pipeline, host);
    slots.approvals = approvalsHtml(approvals, avatars);
    slots.automerge = autoMergeHtml(mr);
    slots.merge = mergeStatusHtml(mr?.detailed_merge_status);
  }
  slots.notice = escapeHtml(liveState(kind, mr).notice);
  return slots;
}

/**
 * The merge request as GitLab shows its header: state, reference, title, branches, author, pipeline,
 * approvals and head commit, each linked to GitLab where a link is known.
 */
export function renderSummary({ record, mr, approvals = null, host = '', kind = 'approve', avatars = {}, live = true }) {
  const ref = `!${escapeHtml(record.iid)}`;
  const mrUrl = safeLink(mr?.web_url, host);
  const projectUrl = mrUrl ? mrUrl.replace(/\/-\/merge_requests\/\d+.*$/, '') : '';
  const slots = liveSlots({ kind, mr, approvals, host, avatars });
  const title = escapeHtml(mr?.title || `Merge request !${record.iid}`);
  const branch = (name) => (name ? anchor(projectUrl ? `${projectUrl}/-/tree/${encodeURIComponent(name)}` : '', `<code>${escapeHtml(name)}</code>`) : '');
  const author = mr?.author?.name || mr?.author?.username;
  const authorHtml = author ? `${avatarImg(author, avatars)}${anchor(safeLink(mr.author.web_url, host), escapeHtml(author))}` : '';
  const branches = mr?.source_branch && mr?.target_branch
    ? `<p class="mr-branches">${authorHtml ? `<span>${authorHtml}</span><span>wants to merge</span>` : ''}${branch(mr.source_branch)}<span>into</span>${branch(mr.target_branch)}</p>`
    : '';
  const facts = [];
  if (authorHtml && !branches) facts.push(['author', 'Author', authorHtml]);
  if (kind !== 'reopen' && mr) {
    facts.push(['pipeline', 'Pipeline', `<span data-live="pipeline">${slots.pipeline}</span>`]);
    facts.push(['approvals', 'Approvals', `<span data-live="approvals">${slots.approvals}</span>`]);
    facts.push(['automerge', 'Auto-merge', `<span data-live="automerge">${slots.automerge}</span>`]);
    facts.push(['merge', 'Merge status', `<span data-live="merge">${slots.merge}</span>`]);
    if (record.sha) {
      const commit = anchor(projectUrl ? `${projectUrl}/-/commit/${encodeURIComponent(record.sha)}` : '', `<code>${escapeHtml(record.sha.slice(0, 12))}</code>`);
      facts.push(['commit', 'Head commit', commit]);
    }
  }
  const dl = facts.length
    ? `<dl class="mr-facts">${facts.map(([icon, k, v]) => `<div class="fact"><span class="wic">${SECTION_ICONS[icon]}</span><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`
    : '';
  return (
    `<div class="mr"${live ? ' data-live-root' : ''}>` +
    `<div class="mr-head"><div class="mr-top"><span data-live="state">${slots.state}</span>${anchor(projectUrl, picture(GITLAB_ICONS_SMALL.repository, 'Repository'))}${anchor(mrUrl, `<span class="ref">${escapeHtml(record.project)}${ref}</span>`)}</div>` +
    `<h2 class="mr-title">${anchor(mrUrl, title)}</h2>${branches}</div>${dl}` +
    `<div class="notice" data-live="notice">${slots.notice}</div></div>`
  );
}

/**
 * The script that keeps an open page current, and that sends the action forms (`data-act`) in the background: the
 * button shows what is going on, the answer replaces the page content in place, and a lost connection is reported,
 * never answered with a second request. Without the script the forms are ordinary posts. The page is kept
 * current by asking the same-origin state endpoint every few seconds
 * while the page is visible and puts the server's (escaped) HTML into the matching `data-live` slots. It
 * hides the action when the merge request can no longer take it. No slot names or text of its own: it only
 * does what the server's answer says.
 */
export function liveScript(stateUrl) {
  const url = JSON.stringify(stateUrl);
  return `(function(){var U=${url},n=0,t;function go(d){var s=d.slots||{};for(var k in s){var e=document.querySelector('[data-live="'+k+'"]');if(e&&e.innerHTML!==s[k]){e.innerHTML=s[k];e.classList.remove('tl-changed');void e.offsetWidth;e.classList.add('tl-changed')}}var a=document.querySelectorAll('[data-live-action]');for(var i=0;i<a.length;i++)a[i].classList.toggle('hidden',!d.actionable)}function tick(){if(document.hidden||++n>360)return;fetch(U,{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(d){if(d)go(d)}).catch(function(){})}t=setInterval(tick,5000);setTimeout(tick,800);document.addEventListener('visibilitychange',function(){if(!document.hidden)tick()});document.addEventListener('submit',function(ev){var f=ev.target;if(!f||!f.hasAttribute||!f.hasAttribute('data-act'))return;ev.preventDefault();if(f.getAttribute('data-sent')==='1')return;f.setAttribute('data-sent','1');var b=f.querySelector('button[type=submit]');if(b){b.disabled=true;b.textContent=b.getAttribute('data-busy')||'Working\u2026'}var m=document.querySelector('main');function say(t){if(m){var p=document.createElement('p');p.className='note';p.textContent=t;f.replaceWith(p)}}fetch(f.action,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(new FormData(f)).toString()}).then(function(r){return r.text()}).then(function(h){var d=new DOMParser().parseFromString(h,'text/html'),n=d.querySelector('main');if(n&&m){m.className=n.className;m.innerHTML=n.innerHTML;document.title=d.title;window.scrollTo(0,0)}else say('The answer could not be shown. Reload the page to see what happened.')}).catch(function(){say('The connection was lost. Nothing is repeated automatically: reload the page to see what happened.')})})})();`;
}

# Nix

The flake provides the `teams-live` package, an overlay and a NixOS module
that runs teams-live as a hardened systemd service.

## Flake outputs

| Output | Content |
| --- | --- |
| `packages.<system>.teams-live` | The daemon (`teams-live`) and its health check (`teams-live-health`). |
| `packages.<system>.msteams-mcp` | The Teams client library teams-live uses. |
| `overlays.default` | Adds `teams-live` and `msteams-mcp` to `pkgs`. |
| `nixosModules.default` | The `services.teams-live` module, with the flake's package as default. |

## Module

```nix
{
  inputs.teams-live.url = "github:pschmitt/teams-live";

  outputs = { nixpkgs, teams-live, ... }: {
    nixosConfigurations.host = nixpkgs.lib.nixosSystem {
      modules = [
        teams-live.nixosModules.default
        ./teams-live.nix
      ];
    };
  };
}
```

```nix
# teams-live.nix
{ config, ... }:
let
  secret = name: { _secret = config.sops.secrets.${name}.path; };
in
{
  services.teams-live = {
    enable = true;
    settings = {
      teams.credentials_file = config.sops.secrets."teams-live/credentials".path;
      browser_daemon = {
        url = "https://browser.example.com";
        profile = "msteams";
        secret_file = config.sops.secrets."browser-daemon/secret".path;
      };
      gitlab = {
        host = "git.example.com";
        group = "my-group";
        token_file = config.sops.secrets."teams-live/gitlab-token".path;
      };
      opsgenie.on_call_key = secret "opsgenie/on-call-key";
      conversations = [
        { id = "48:notes"; name = "Notes (Self)"; gitlab = true; }
        { id = secret "teams-live/team-chat"; name = "Team"; gitlab = true; }
      ];
    };
  };
}
```

The example uses [sops-nix](https://github.com/Mic92/sops-nix); any tool that
puts secrets into files works. Each secret file must be readable by the
service user (`teams-live` by default).

### Secrets

`settings` is written to a JSON file in the Nix store, which every user on
the host can read. Never put a secret value there. Two ways keep it out:

- **`*_file` keys** (`teams.credentials_file`, `gitlab.token_file`,
  `jira.token_file`, `confluence.token_file`, `home_assistant.token_file`,
  `browser_daemon.secret_file`) take a path, and teams-live reads the file.
- **`{ _secret = "/path"; }`** works for any other value. teams-live replaces
  the object with the trimmed contents of the file when it starts, and fails
  with the name of the key if the file cannot be read. Use it for API keys,
  and for identifiers you do not want in the store, such as conversation ids.

### Restarts

The service restarts when `settings` change, because the store path of the
config file changes. It does not notice when a secret file changes; let the
tool that writes the secret restart it, for example with sops-nix:

```nix
sops.secrets."opsgenie/on-call-key".restartUnits = [ "teams-live.service" ];
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `enable` | `false` | Run teams-live. |
| `package` | the flake's package | Package to run. |
| `settings` | `{ }` | Configuration, see below. |
| `configFile` | `null` | A complete JSON config file to use instead of `settings`. A file outside the store does not restart the service when it changes. |
| `dataDir` | `/var/lib/teams-live` | State, token caches and session data. |
| `user`, `group` | `teams-live` | Account the service runs as. The module creates it only with the default name. |
| `extraGroups` | `[ ]` | Supplementary groups, for example to read secret files. |
| `healthCheck` | read-only | Health check command for this service, see below. |

The options `credentialsFile`, `gitlabTokenFile`, `browserDaemonUrl`,
`browserDaemonProfile` and `browserDaemonSecretFile` are renamed to their
`settings` keys and print a warning.

### Health check

`services.teams-live.healthCheck` runs `teams-live-health` against this
service. It exits 0 while the service is healthy, starting or degraded, and
non-zero when the unit is down, `health.json` is missing or stale (older
than 90 s), or the service reports itself unhealthy. With monit:

```nix
services.monit.config = ''
  check program teams-live with path ${config.services.teams-live.healthCheck}
    if status > 0 for 2 cycles then exec "/run/current-system/sw/bin/systemctl restart teams-live"
'';
```

`teams-live-health --help` lists its options for use outside the module.

## Settings

All keys are optional. Defaults are in [`src/config.mjs`](../src/config.mjs).

| Key | Description |
| --- | --- |
| `teams.credentials_file` | Teams session state to start from. |
| `teams.reconnect_interval_seconds` | Wait before reconnecting to Trouter (5). |
| `teams.token_refresh_interval_minutes` | How often the token lifetime is checked (60). |
| `teams.registration_interval_minutes` | How often push registrations are renewed (15). |
| `teams.max_session_minutes` | Age after which the push session is replaced (60). |
| `teams.history_poll_interval_seconds` | Poll of the watched chats for missed pushes (120, 0 disables). |
| `teams.rich_messages` | Post the watcher messages as Adaptive Cards (false). See [Rich messages](#rich-messages). |
| `teams.compact_cards` | The compact merge request card (true; set `false` for the classic one). The same header, title and icons, but short labels in two columns at standard card widths and stacked rows in narrow chats, an approval pill and approver pictures that wrap as space allows, auto-merge as a GitLab icon (blue clock: on, gray pause: off), the rebase warning only when needed, and a repository icon in the header instead of the project line. Only affects rich messages. |
| `avatars.fallback_sources`, `avatars.overrides` | Profile pictures on rich cards where Teams has none. `fallback_sources` is the ordered list of services asked (`[ "jira" "confluence" ]` by default, `[ ]` turns them off); `overrides` is a list of `{ name, file }` giving an account that exists in no directory (a bot) a small PNG or JPEG. See [Profile pictures](#profile-pictures). |
| `teams.service_alerts.*` | Dampens the admin alerts about expired connector credentials (see below). Keys, in seconds: `stable_recovery_seconds` (120), `flap_window_seconds` (600), `flap_recovery_seconds` (300), `reminder_seconds` (43200), and `flap_transitions` (4). |
| `gitlab.approve.*` | Approve button of merge request cards: capability link (off). `gitlab.approve.merge_enabled` (off) separately enables the Merge button. The Rebase button is on with the flow (`gitlab.approve.rebase_enabled = false` turns it off). See [Approving from a card](#approving-from-a-card). |
| `teams.troll_user` | User MRI whose `/exec` gets a joke reply instead of the fake shell output. |
| `browser_daemon.url`, `.profile`, `.secret_file` | browser-daemon used to sign in to Teams again. |
| `gitlab.host`, `.group`, `.token_file` | GitLab instance, group for `/mrs`, primary API token. |
| `gitlab.fallback_token_files` | Ordered list of additional token files. Requests use credentials in order and try the next only after a 404. Approval pages identify the account selected for the merge request and pin the action to that account. Each token is checked and rotated independently; rotated fallback tokens are kept in the service state directory until their configured secrets are updated. |
| `gitlab.user_token_mappings` | List of `{ teams_mri, gitlab_username, token_index }` mappings for MR commands and reactions. Use a stable Teams MRI, the exact GitLab username, and the credential index (primary is 0, first fallback is 1). The selected account is verified before writing. Unmapped users act as the primary account. Keep identities in private runtime configuration. |
| `gitlab.poll_interval_seconds` | MR status poll (60). |
| `gitlab.history_limit`, `.history_max_age_minutes` | Messages scanned at startup. |
| `gitlab.max_watch_duration_seconds` | How long an MR is watched (7200). |
| `gitlab.code_preview.{enable,max_lines,restrict_to_group,allow_other_senders}` | Reply to a GitLab file link with a line anchor (`.../-/blob/<ref>/<path>#L10` or `#L10-20`, also `.../<project>.git//blob/<ref>/<path>#L10`) with those lines (on, 30 lines at most; `max_lines` is a ceiling for the whole preview). A preview shows at least five lines when the file has them: a shorter range gets balanced context above and below (shifted at the start or end of the file) and the linked lines are always marked (with or without context) with a `>` gutter and, in cards, an orange-ish band, while the link itself keeps the requested range. Works for any project on the configured host, since `gitlab.group` only scopes MR monitoring; the token's own permissions decide what is readable. Only links in the authenticated user's own messages trigger a preview, so other participants cannot make the token read repository files into the chat; `allow_other_senders` (off) lifts that. Set `restrict_to_group` (off) to limit it to projects below `gitlab.group`. Read through the GitLab API with the configured token, never by fetching the link. Paths that look like credentials (`.env`, keys, `*secret*`, ...), binary and files over 1 MB are skipped. A link without a line anchor is ignored. |
| `gitlab.notify.ci.{enable,on_failure,on_success}` | CI result messages. |
| `gitlab.notify.{rebase,approval_lost,merged,closed}` | Other MR messages. |
| `gitlab.webhook.{enable,port,host,path,url,secret_file,auto_setup}` | Receiver for GitLab events and the group hook that feeds it. See [GitLab webhook](#gitlab-webhook). |
| `gitlab.webhook.adopt_hooks` | Hand-made hooks this service may take over, `[{ id, url }]` (none). |
| `gitlab.webhook.accept_shared_secret` | Keep accepting the shared secret next to the per-hook tokens (false). |
| `jira.url`, `.token_file`, `.board_id` | Jira for `/sprint`, `/issue` and `/standup`. |
| `confluence.url`, `.token_file` | Confluence instance and API token for doc links and `/doc`. |
| `opsgenie.on_call_key`, `.support_key`, `.edge_key` | OpsGenie API keys for `/alerts` and `/oncall`. |
| `opsgenie.on_call_schedule_id`, `.support_schedule_id` | Schedules for `/oncall`. |
| `opsgenie.base_url`, `.web_base_url` | OpsGenie API and web URLs. |
| `home_assistant.url`, `.token_file` | Home Assistant with the HR WORKS integration, for `/whereis`. |
| `home_assistant.hrworks_batch_size` | Organizational units per HR WORKS request when prefetching the company (4). Keep each request under the proxy timeout. |
| `tv.timezone`, `.cache_ttl_seconds` | `/tv program`: time zone for the times shown (`Europe/Berlin`) and how long a programme lookup is cached (300). |
| `tv.artwork` | Show programme thumbnails on the `/tv program` card (true). Only HTTPS images from the ARD programme API, the ARD Mediathek and TV Spielfilm hosts are used (others are dropped, `http` is upgraded, credentials, ports and fragments are refused); a missing or refused image leaves no empty frame. Set it to false for a thumbnail-free card. The thumbnail is shown at the full width of the card (16:9 as the source delivers it, asked at 960 px so it stays sharp at 3x) above the running programme, which keeps the card tall on a phone: set `tv.artwork` to false for a compact card. Below it, "NOW" with the time, the title and the subtitle sit left and the ARD, ZDF or Tagesschau logo (embedded in the card, no fetch) at the right edge, with no separate channel heading. The progress bar and percentage are a short line of their own that never wraps. |
| `tv.channels.{ard,zdf}.{name,type,url,channel_id}` | Programme sources for `/tv program`. `type` is `ard-api` (the keyless ARD programme API, the default for `ard`) or `xmltv` (an XMLTV file, plain or gzip; the default for `zdf` is a community file). |
| `tv.switch.base_url` | Home Assistant base URL for the `/tv` controls and readbacks. Falls back to an explicitly configured `home_assistant.url` or `HASS_URL`; there is no built-in default. |
| `tv.switch.webhooks.{ard,zdf,tagesschau,off}` | One Home Assistant webhook per target: the bare webhook id, or a full `http(s)` URL. The id authenticates the call, so give it as `{ _secret = path; }`. A target without a webhook answers "not configured"; `/tv next` and `/tv prev` skip it. |
| `tv.switch.webhooks.mute` | Webhook behind `/tv mute`. It always receives `{ "action": "mute", "muted": true }`: an explicit mute-on, never a toggle, so repeating it is harmless. Unmuting is the separate `unmute` webhook below. The audio routing itself is configured elsewhere; this only fires its webhook. The scene is read first (see `tv.switch.state`): the webhook is only posted while an ARD, ZDF or Tagesschau scene is on air. On the `off` (brb) scene nothing is sent and the reply says so (warning reaction); an unreadable, unknown or unconfigured scene fails closed (failure reaction, nothing sent). A webhook cannot prove that OBS acted, so a 2xx is reported as "Mute requested. Home Assistant accepted the request; the result is not verified.", never as "Muted". |
| `tv.switch.webhooks.unmute` | Webhook behind `/tv unmute`. It always receives `{ "action": "unmute", "muted": false }`: an explicit mute-off, never a toggle, so repeating it is harmless. It is a webhook of its own and never falls back to the `mute` one (without it `/tv unmute` is "not configured"). Same scene gate and wording as `/tv mute`: nothing is sent on the `off` (brb) scene, an unreadable scene fails closed, and a 2xx is reported as "Unmute requested. Home Assistant accepted the request; the result is not verified.", never as "Unmuted". |
| `tv.switch.webhooks.{volume,volume_up,volume_down}` | Webhooks behind `/tv vol up` and `/tv vol down`. With `tv.switch.volume.entity_id` set, the daemon reads the level (`volume_level` attribute), moves it by one step, clamps it to 0..1 and posts `{ "action": "volume", "level": 0.55 }` to `volume`. Without it, `volume_up`/`volume_down` receive `{ "action": "volume_up", "step": 0.05 }` and the receiver does the maths. `/tv vol up` also unmutes the source, `/tv vol down` never does. With the step webhooks the receiver does both (the OBS helper raises the level, then unmutes, also when the level is already at the top, so a muted source at maximum recovers); with the absolute `volume` webhook the daemon posts the `unmute` webhook after the level when that one is configured (and reports a failing unmute). Both are gated on the scene exactly like `/tv mute` and are reported as "Volume increase and unmute requested" / "Volume decrease requested" (accepted, not verified). |
| `tv.switch.volume.entity_id`, `.step` | Optional media player whose `volume_level` is read before a step, and the step as a fraction of the range (default `0.05`, i.e. 5 points). Needs `tv.switch.state.token`. |
| `tv.switch.state.entity_id`, `.attribute`, `.token`, `.map`, `.trust_last_switch` | Readback of the current channel for `/tv next`, `/tv prev` and as the gate of `/tv mute`, `/tv unmute` and `/tv vol` (which need it and never use `trust_last_switch`): the daemon reads `GET <base_url>/api/states/<entity_id>` with the token (`{ _secret = path; }`; the daemon's `home_assistant.token` is used when `tv.switch.base_url` is unset and `home_assistant.url` is explicit). With `attribute` set, that attribute of the entity is read instead of its state (for an entity whose state is a scene but whose attribute names the active input). `map` lists the values (case-insensitive) that mean each of `ard`, `zdf`, `tagesschau` and `off` (defaults: the channel name, and the `off_scene`). A value that matches none of them, `unavailable`, `unknown`, an empty value or a failed read is an error and nothing is switched. Without a readback entity, cycling fails closed: the channel is unknown. `trust_last_switch = true` opts in to cycling from the channel this process switched to last, which is never valid after a restart (nothing is known until the first explicit `/tv ard\|zdf\|tagesschau\|off`) and goes stale when something else switches. |
| `tv.switch.off_scene`, `.timeout_seconds` | OBS scene sent along with `/tv off` (`brb`) and the request timeout (10). |
| `conversations` | Chats to watch: `{ id, name, gitlab }`. Default: the self chat `48:notes`. |

Replies: a channel switch is reported as "requested" (the webhook only queues the change). It becomes "confirmed" only when the readback (`tv.switch.state`) shows the target channel within a few short attempts; without a readback it stays "requested". The reply card carries the channel logo and, for ARD and ZDF, the current programme (title, start, end, progress and a compact next) from the `/tv program` provider and cache. The lookup is bounded (about 2.5 s) and never blocks or fails the control: an unavailable, stale or empty programme guide just omits the programme. Tagesschau has no programme guide, so no programme is shown for it. Plain mode (`teams.rich_messages = false`) gets the same wording as text.

Receiver contract (Home Assistant): every call is `POST /api/webhook/<id>` with a JSON body. Channels send `{ "action": "ard" }` (likewise `zdf`, `tagesschau`); `/tv off` sends `{ "action": "off", "scene": "brb" }`. One webhook may serve all four targets, since the action is in the body. The receiver must act only on those actions and ignore anything else. Webhooks cannot return state, so the readback is a separate entity: when the OBS scene is the source of truth, point `tv.switch.state.entity_id` at the entity that shows the current scene and map its values (`state.map.off` must list the real name of the `off` scene if it differs from `off_scene`).

Cycling: `/tv next` goes ARD, ZDF, Tagesschau, ARD; `/tv prev` goes the other way. `off` (the `brb` scene) is not a channel: from off, `/tv next` switches to ARD and `/tv prev` to Tagesschau. Commands run one at a time, so two quick `/tv next` advance twice (a readback that still shows the previous channel within 5 seconds of a successful switch, i.e. Home Assistant lagging, does not repeat the switch), and a missing, failed or unrecognized readback or a failed webhook neither advances nor changes anything. `/tv tagesschau` also accepts `ts` and common typos; all controls are owner only and never show a URL, id, token or host in a reply or the log.

### Connector alerts

When a connector (GitLab, Jira, Confluence, OpsGenie, Home Assistant) reports
bad credentials, the admin chat gets one "Authentication Expired" message. The
matching "Restored" message follows only after the connector stayed healthy for
`stable_recovery_seconds`. If it changes state `flap_transitions` times within
`flap_window_seconds`, one "Connection Unstable" message is sent and the
expired/restored messages are suppressed until it was healthy for
`flap_recovery_seconds`, followed by one summary with the number of suppressed
changes (or by one "still failing" message if it stays broken). Only the
notifications are dampened, never the health status. The state is kept in
`service-alerts.json` in the state directory.

## GitLab webhook

With `gitlab.webhook.auto_setup` (default) and a secret, the service keeps one
group hook pointing at `gitlab.webhook.url`. It never trusts a name or a URL
to decide which hook is its own:

- Every hook it creates carries a marker in its description,
  `teams-live-owner:<owner> gen:<generation> v1`. The owner id is created once
  and kept in `webhook-reconcile.json` (0600) in the state directory. Hooks
  without the marker, or with another owner, are never changed or deleted. A
  hook that merely has the configured URL is not adopted either; a separate
  hook is created next to it.
- Every hook gets its own token, derived (HMAC) from the secret, the owner
  and the generation. The receiver accepts these tokens and nothing else
  once management is on. The token proves which generation delivered, not
  where the request came from. Neither the secret nor a token is logged or put
  in the state file, and the secret itself is not sent to GitLab for managed
  hooks.
- A new `url` (for example a hostname change) never edits the existing hook.
  It creates a replacement with its own generation and keeps the old hook. When
  the replacement has delivered an event with its own token, the old hook is
  re-read, compared (id, URL, marker) and deleted. Several hooks of this
  service during such a move are expected. Changing the secret is handled the
  same way.
- Nothing is deleted without a strong secret (at least 32 characters) and
  with a failed or partial hook listing. At most three hooks are deleted per
  run, a hook that changed since it was recorded is left alone, and the plan is
  written to the state file before each deletion. Without a strong secret hooks
  are only registered.
- Any change of the secret creates a new generation with a token the receiver
  accepts: a rotation, weak to strong, strong to weak, none to some. The old
  hooks are recorded (and deleted only with a strong secret and a proven
  replacement). Without a strong secret a hook without a marker on the
  configured URL blocks creation (an error status) instead of being duplicated;
  list it in `adopt_hooks`.
- The run happens at startup, every ten minutes and after a verified delivery.
  A sample delivery is requested from GitLab after creating a hook
  where the API allows it.

Taking over an existing hand-made hook: list it in
`gitlab.webhook.adopt_hooks` with its id and exact URL. It is read again and
must still have that URL and no marker. While such a hook is tracked, the
shared secret stays valid for it. Deploying management to a group that already
has a hook without listing it there means its deliveries are rejected (401)
and a new hook is created.

## Rich messages

By default the watcher posts regular markdown messages. With
`teams.rich_messages = true` it posts an Adaptive Card per entity instead, laid
out for what the entity is:

| Entity | Card |
| --- | --- |
| GitLab merge request (open, merged, closed, rebase required, rebased) | Title, state colour, author (with profile picture), approval, auto-merge, pipeline, rebase (only when required), target branch, "Ticket" (Jira logo and key), links |
| GitLab job and pipeline | Status colour, stage, ref, duration, failure reason, linked merge request |
| Jira issue | Summary, type, status, priority, assignee |
| OpsGenie alert | Message, priority badge (P1 red to P5 subdued), OPEN / ACK'D / CLOSED badge, owner |
| Confluence page | Title, space, author |
| Startup and shutdown ("last will") announcements to the admin chat | Green card (container style `good`, green heading and 🟢, ONLINE under the title) for the start, red card (`attention`, red heading and 🛑, STOPPED under the title) for the shutdown, with every fact of the regular message; the token override warning is a yellow block. The heading, icon and status word carry the colour for clients that ignore container styles. |

Command replies use the same gate. Commands that return structured data answer
with a card built from the very same markdown as the regular reply, so no fact,
link, count or truncation note is lost:

| Command | Card |
| --- | --- |
| `/mrs` | Multi-MR cards with author, approval, CI, auto-merge and rebase status; large lists are split across cards and fall back to markdown when needed |
| `/alerts`, `/oncall` | OpsGenie list and on-call card |
| `/sprint`, `/issue`, `/doc` | Jira sprint, issue and Confluence page cards |
| `/status <MR>` | Merge request card (open, merged or closed) |
| `/ci` | Pipeline card |
| `/whois` (`/who`) | Contact card, or a search-results list |
| `/whereis` (`/where`) | Availability card, or a search-results list |
| `/meetings`, `/standup` | Meetings and standup summary cards |

Everything else is a card too: help, errors, acknowledgements, admin notices,
runtime status, `/exec` output, `/random`, `/weather`, `/flip`, `/retry` and so
on. The reply is built from the same markdown as the regular message and shown
as a card with a bot header (paragraphs, bullet lists, headings and fenced code
blocks are kept). In rich mode every outward message is a card; regular mode is
unchanged.

Limits and trade-offs:

- Mentions do not notify. A card cannot carry a mention, so people appear as
  plain names and nobody gets a notification (this includes admin
  authentication notices).
- Teams caps a message payload, so one card is at most 24000 bytes on the wire.
  Longer content is split into several consecutive cards, at most 10; anything
  beyond that is dropped and the last card says how many parts were not shown.
  Code fences are closed and reopened at each split.
- Editing the author's own message cannot be split: when the content needs more
  than one card, that edit falls back to regular text.
- If Teams rejects a card, the message is sent again as plain markdown; there
  mentions work again.

Merge request cards always show the approval and auto-merge lines on open
merge requests, including "Not approved yet" and "Disabled", and say "Unknown"
when GitLab could not be asked. The rebase line appears only
while a rebase is required (with the reason, merge conflicts when known, and the
GitLab status) and disappears once it is resolved. Merged and closed cards keep
the last known approval, auto-merge and rebase state.

Merge request cards show the size of the change as `+added -removed lines`
(green and red, with textual signs). The totals come from GitLab's GraphQL
`diffStatsSummary` for the exact head commit (the REST `changes_count` counts
files, not lines, and is not used). They are looked up once per head commit with
a short timeout, cached, and reused by in-place refreshes of the same commit.
When GitLab does not report usable numbers (older instance, error, timeout) the
row is simply left out; totals are never guessed or summed from partial data.

OpsGenie priority and status badges are textual (P1, OPEN, ACK'D, CLOSED) and use
the closest Teams card colours (good, attention, warning, accent); Teams does
not allow arbitrary colours, so the shades are approximate, not pixel-exact.

Every card starts with a compact header: the logo of the service (GitLab, Jira,
OpsGenie or Confluence, embedded as a small PNG, no image fetch) and a label
such as "GitLab · Merge request" or "Jira · Bug". Merge requests, jobs,
pipelines and Jira issues also show their reference at the top right, large,
bold and linked: `!123`, `#456`, or the issue key. A GitLab reference is shown
only when the numeric id is known (never guessed from other ids), and the
reference is not repeated as a subtitle. Below the header come the full title,
a one-line subtitle and a few facts. Navigation is done with inline links, not
buttons: the title links to the entity, and cross references inside the card are
linked too (the pipeline and Jira key of a merge request, and the pipeline and
merge request of a job or pipeline). A link is only added for a valid http(s)
URL; without one the text stays plain, and brackets in titles are escaped so
they cannot break the link. Cards carry no bottom buttons, except the optional
"👍 Approve" button of a merge request card (see
[Approving from a card](#approving-from-a-card)).

Facts are a plain label/value list. When a fact carries a picture (the profile
picture of the author, an approver or the auto-merge user, or the Jira logo of
the "Ticket" fact), all facts of that card become rows that share one label
width, so the labels stay aligned. The author's name is always shown; the
picture is dropped first when the card would not fit.

Status lines keep the emojis of the regular messages: approval, pipeline,
rebase, auto-merge, merged and closed on merge requests, and the CI status on
job and pipeline cards. The CI emojis come from one shared mapping.

Replies, in-place updates and edits of the author's message behave as with
regular messages: channel replies stay in the thread, chat replies quote the
original, and the card replaces the previous message content. The regular text
is kept as the card's `fallbackText` (used for notifications and previews).
Updating a card message with regular text clears the card.

```nix
services.teams-live.settings.teams.rich_messages = true;
```

When a new message contains multiple merge request links and CI notifications
are enabled, rich messages group them into one card. Each row shows its author
and approvers, pipeline and auto-merge state; the header shows the number
merged. The card updates as the merge requests change. Its **Approve all**
action opens a confirmation page
which checks each eligible request separately and reports the result for each.
**Open all** opens a separate page that immediately attempts to open the links
in tabs, then closes itself when the browser permits it. If the browser blocks
pop-ups, the page retains the unopened links and a retry button. Both actions
use the optional
approval server; **Approve all** also requires GitLab OAuth. Each action accepts
at most 20 requests. For large groups, the card falls back to a lighter
representation or text to fit Teams' limit; the text fallback has no buttons.

Cards use the wire format of the Teams client: the message HTML holds an
`InputExtension` span with a `cardClientId` (a UUID without hyphens) and the
`cards` message property holds `[{cardClientId, content, contentType}]` with the
Adaptive Card as `content`. Note that the Teams chat service reports success
even for a payload it does not render (the message shows as a blank bubble), so
try it in your own notes chat first:

```bash
node src/smoke-rich.mjs <your-notes-conversation-id> --mode both --kind mr,jira,startup,shutdown   # --mode regular|rich sends only that kind of message and reply
node src/smoke-rich.mjs <conversation-id> --dry-run   # print the payloads only
```

The script uses generic fixture data and refuses channel conversations.

### Profile pictures

People on rich cards (author, approvers, auto-merge user, lists) get their
Teams profile picture. Where Teams has none, the picture comes from, in this
order:

1. **Teams**: the person's profile photo, matched by an exact, unique Azure AD
   identity (MRI, e-mail address or a unique full display name).
2. **Jira**: the picture the person uploaded, matched by an exact, unique,
   active user with that full display name (or e-mail address). Users who never
   uploaded one share the instance's default avatar, which is not used.
3. **Confluence**: the uploaded picture of the Jira user with the same username,
   unless it is the default one. Jira's 32 px (then 24 px) variant is used;
   anything over 2400 bytes or 128 px is skipped, not resized (see the note below).
4. **`avatars.overrides`**: a configured picture for a display name, for accounts
   that exist in no directory (for example the service account that approves
   merge requests). The match is on the exact full name, ignoring case and extra
   spaces; the file must be a PNG or JPEG of at most 2400 bytes and 128 px (a 32 px PNG is
   about 2 KB). It is read
   once at start; an unreadable or oversized file is skipped with a warning.
   Renovate's account ("Renovate Service User", "Renovate Bot") has a built-in
   picture, the Renovate logo; a configured picture for the same name replaces it.
5. **Placeholder**: a neutral silhouette.

Fallback and configured pictures are held to 2400 bytes because a card has one
shared budget for picture data (6500 characters): a row whose picture does not fit
loses its pictures and its approval pill, so they must stay small enough to sit
next to the author's photo. In practice that means Jira (small variants) and
overrides; Confluence photos are usually too big.

Matching is strict at every step: one word (a first name or a username), several
people with the same name, a partial match or an inactive Jira user end in "no
picture" for that source, never in somebody else's. GitLab pictures are not used:
GitLab only serves them to a browser session, not to an API token. Jira and
Confluence are asked with the tokens already configured for them, only on their
own host, never through a redirect, and results (also "none") are cached for the
same time as Teams pictures.

```nix
services.teams-live.settings.avatars.overrides = [
  { name = "Example Bot"; file = ./example-bot.png; }
];
```

### Approving from a card

With `teams.rich_messages` on and the approval flow enabled, an open merge
request card gets an "👍 Approve" button. The button opens a confirmation page;
it never approves by itself.

Approval requires GitLab OAuth. The person confirming signs in and approves
with their own GitLab account; GitLab checks that account's permissions. Without
OAuth, approval buttons fail closed. Merge, rebase and reopen still use the
service's configured GitLab account, and a 👍 reaction uses that account too.
The link is a capability, so do not forward it to someone who should not be
able to open its confirmation page.

How the link is built:

- The token is 256 random bits. The server stores only its SHA-256 and the
  merge request, head commit and expiry (`approve-links.json` in the state
  directory, mode 0600, bounded). A link is bound to one merge request and the
  exact head commit shown on the card.
- The token sits in the URL fragment (`https://<host>/approve/#<token>`), so
  it is not sent to the server, proxies or access logs, and not in a Referer.
  The page is static (no token, no GitLab call, no third-party resources, a
  CSP that pins its one inline script). The script clears the fragment from the
  address bar and POSTs the token, same origin, to `/session`. The server
  answers with a short-lived (15 minutes, never longer than the link)
  `HttpOnly`, `SameSite=Strict` (and `Secure` on https) cookie, and the browser
  continues to a clean `/confirm` URL.
- Opening the link, and any scan, prefetch, preview or HEAD request, neither
  approves nor uses the link up. `/confirm` (GET) only shows the current state;
  the approval is an explicit confirmation POST that needs the session cookie,
  a CSRF token bound to that session and link, and an `Origin` (or `Referer`)
  equal to the configured `base_url` origin (fail closed).
- A replay or a concurrent request never approves twice for the same user.
  After an unclear network or server error the service checks that user's
  approval before saying what happened. The approval
  request is never retried blindly, and a 401/403 is treated like any other
  unclear answer (the own approval is looked at first).
- Limits: an unknown token counts against a global throttle, but a valid token
  is never blocked by it; a link opens at most 3 sessions at a time (the
  oldest of that link is replaced, other links are untouched) and at most 10
  sessions per minute. Reads of the confirmation page are cached for 5 s.
- `node scripts/mock-approve-server.mjs [--port N] [--out FILE]` runs this flow
  against a mock GitLab with generic data (`group/app!7`), to try the browser
  bootstrap and confirmation without a live merge request. The capability URL
  is written to a 0600 file and never printed; the mock "approval" lives in
  memory only.
- The link store is bounded (500). When it is full, used-up and superseded
  records are dropped first; a still-valid open link is never evicted, and no
  new link is minted until there is room (the warning is logged at most once
  per 10 minutes; a restart with a full store behaves the same).
- The approval is sent with the head SHA, and the page checks that the merge
  request is open, not a draft, not yet approved by the signed-in user and
  that GitLab lets that user approve. A merge request that gained commits, was closed
  or merged invalidates the link. A pending pipeline or merge status does not
  block it.
- Links expire after `link_ttl_seconds` (default 24 hours, bounded to 60 s to
  7 days). The same open link is shown again when the card is refreshed; after
  a restart a new link is minted and older ones stay valid until they expire.
- Responses are `Cache-Control: no-store` with `nosniff`, `X-Frame-Options:
  DENY` and a restrictive CSP. The `Referrer-Policy` is `same-origin` rather
  than `no-referrer`: with `no-referrer` browsers send `Origin: null` on the
  form POST, which the Origin check has to reject. No secret is in any served
  URL. Repeated invalid tokens are throttled. The token is never logged.

The page is served by a separate listener, not by the webhook server. It binds
to loopback. Put a reverse proxy in front that forwards the `base_url` path
prefix (`/`, `/session`, `/confirm`) to it, over https, **without** an
authentication layer. The proxy may keep the path prefix or strip it.

| Key | Description |
| --- | --- |
| `gitlab.approve.enable` | Start the flow (false). |
| `gitlab.approve.host`, `.port` | Listener, loopback only (127.0.0.1, 3006). |
| `gitlab.approve.base_url` | Public https URL of the page, for example `https://<host>/approve`; no query or fragment. It is also the allowed Origin of the POSTs. Plain http is accepted only for loopback. |
| `gitlab.approve.link_ttl_seconds` | Lifetime of a link (86400). |
| `gitlab.approve.rebase_enabled` | The Rebase button (true; only an explicit `false` turns it off). |
| `gitlab.reaction_approvers` | Who may approve a merge request with a 👍 reaction on its Teams message: `anyone` (default: whoever reacts, except the merge request's author, whose reaction is ignored; the reactor is named in the comment and shown on the card) or `self` (only the account teams-live runs as and configured admins). Note that with `anyone` any 👍 on a card approves it. |
| `gitlab.approve.oauth.client_id`, `.client_secret` | Turns on [Sign in with GitLab](#sign-in-with-gitlab). Give the secret as `{ _secret = "/path"; }`. Off by default. |
| `gitlab.approve.oauth.auto_setup` | Create and verify a user-owned GitLab OAuth application (false). Explicit credentials remain a fallback if automatic setup fails. |
| `gitlab.approve.oauth.state_file` | Optional path for the managed application state; defaults to `gitlab-oauth.json` in the state directory. |
| `gitlab.approve.oauth.allowed_users` | Optional list of GitLab user names allowed to confirm. Empty: any user that signs in. |
| `gitlab.approve.dashboard.enable` | The signed-in [dashboard](#dashboard) at `<base_url>/dashboard` (false). Needs `oauth` and `gitlab.group`. |
| `gitlab.approve.dashboard.path` | Serve the dashboard on its own path of the `base_url` host, for example `/dashboard` (default: `<base_url>/dashboard`). The old address then redirects there; the proxy must forward the path. |
| `gitlab.approve.dashboard.time_zone` | Time zone of the meeting times on the dashboard (`Europe/Berlin`). |
| `gitlab.approve.dashboard.push` | Push notifications to the browsers that switch them on in the dashboard's settings, also while the dashboard is closed (true). |

#### Rebase and Merge buttons

The buttons of an open merge request card are, in this order, **🔁 Rebase**, **👍 Approve** and **🔀 Merge**.

- Rebase is shown only while the merge request is behind its target branch and has no merge conflicts (a rebase
  cannot fix those). It opens a confirmation page like the others; confirming sends one rebase request to GitLab
  (never repeated) and reads the result back: rebased, failed with GitLab's reason, or still running. Unlike an
  approval it is not pinned to a head commit, since a rebase changes it.
- Merge is shown only while GitLab reports the merge request as `mergeable` (approvals, pipeline, conflicts and
  discussions all in order), so it never offers a merge that can only fail. The page still checks again when it
  is opened.

#### The confirmation page

- After a **rebase** the result page offers **👍 Approve** for the new head commit: one click approves exactly that
  head (the head the page showed is bound into the form, and GitLab guards the approval with the same commit).
  It is not offered while GitLab is still rebasing, when the account already approved, or when the signed-in user
  may not approve.
- The buttons run in the background: the button shows what is going on ("Rebasing…"), the answer replaces the page
  in place, and a lost connection is reported, never answered with a second request. Without JavaScript the forms
  are ordinary posts.
- The page uses the same pictures as the cards: GitLab icons for the state, the pipeline and auto-merge, the
  repository icon, and pictures for the author and the approvers (the Teams photo when known, else initials). They
  are embedded; the page's CSP allows `img-src data:` and nothing else.
- Merge, rebase and reopen leave a comment on the merge request. It names the
  signed-in GitLab user; only when nobody signed in does it carry the address
  the request came from and where it is. GitLab records an approval directly
  under the approving user's account.

#### Sign in with GitLab

With `gitlab.approve.oauth` set, the page sends the visitor through GitLab's
OAuth sign-in (scope `api`, authorization code with PKCE; the page never sees
a password). The access token stays in the short-lived server-side session and
is used for that person's approvals. The signed-in user is bound to the form,
may be limited with `allowed_users`, cannot approve their own merge request,
and is recorded by GitLab as the approver. A remembered identity alone cannot
approve: opening a new approval session may require GitLab authorization again.
Without OAuth, approval buttons fail closed. Reactions continue to use the
configured account.

Set it up once: in GitLab, add an application (your profile, Applications; or a
group or the admin area) with the redirect URI
`<base_url>/oauth/callback`, scope `api`, "Confidential" on. Existing OAuth
applications need the `api` scope enabled and users must authorize it again. Keep the
secret in SOPS and reference it with `_secret`. The proxy must forward
`/oauth/start` and `/oauth/callback` like the other paths.

#### Dashboard

With `gitlab.approve.dashboard.enable = true` (and `oauth` and `gitlab.group` set), `<base_url>/dashboard` is a
signed-in start page:

- **Merge requests** of the group, read with the visitor's own GitLab token (one GraphQL query), filtered into
  "Needs my review" (the visitor is a reviewer, has not approved, is not the author), "Mine", "Human" and "Bots"
  (the same rules as `/mrs`). Each row has the pipeline, the approvals and, where GitLab lets the visitor approve,
  an inline **Approve**: one POST pinned to the head commit the page showed, with the same checks as the approval
  page (identity, head, draft, author, GitLab's rules), never repeated, leaving the usual comment and card refresh.
- **Active sprint** (Jira), **alerts and on-call** (OpsGenie) and the **next meetings** (the Teams calendar of the
  account teams-live runs as). These are read by the bot with its own accounts, at most once a minute for everyone.

Who may open it: a GitLab user who signs in and is an active member of `gitlab.group` (checked with their own
token), and on `oauth.allowed_users` when that list is set. The session cookie is HttpOnly and SameSite=Strict and
lasts 14 days: the GitLab token is renewed with its refresh token before it expires, and the membership is checked
again each time; a refused renewal or "Sign out" ends it. Sessions are kept across restarts in
`dashboard-sessions.json` in the state directory, encrypted with a key derived from the OAuth client secret (mode
0600); a new client secret simply signs everyone out. The page refreshes its sections every minute while it is
visible. Cards can be moved (drag the grip, or arrow keys on it) and resized (drag the corner, double-click to
reset); the layout is kept in the browser's local storage only. A click on an alert, a sprint ticket or a ticket
chip on a merge request (a ticket named in its branch or title) opens its details in a side panel; the server reads
only alerts and tickets the dashboard currently shows. Dragging a ticket to another column of the sprint board runs
the Jira transition that leads there, with the bot's Jira account (Jira records that account; the service log names
who moved it). Ctrl+K (or Search in the top bar) opens a palette that jumps to a section, opens any listed
merge request, ticket or alert, and runs the page's actions. The dashboard installs as an app (manifest, icons, a
service worker scoped to the dashboard path); the worker keeps the last signed-in page and its data in the browser
so it stays readable offline, with a notice, while approving and moving wait for the network. Signing out clears it. On a phone the sidebar becomes a bottom tab bar.

**Notifications.** The account menu opens the dashboard's settings, where each browser can switch on desktop
notifications and pick the events: a review request, an approval on one of the visitor's merge requests, one of
them ready to merge or with a failed pipeline, a sprint ticket assigned to the visitor, a new unacknowledged alert
(from a chosen priority up) and a meeting that starts in a few minutes. The choices are kept per browser. With
`dashboard.push` (the default) and a browser that supports Web Push, the server sends them as push messages, so
they also arrive while the dashboard is closed: once a minute it reads, for each session with a subscribed
browser, what that visitor's dashboard would show (with their own GitLab token) and pushes what is new. Messages
are encrypted for the browser (RFC 8291) and signed with the server's VAPID key (RFC 8292); only the push services
of the common browsers (Google, Mozilla, Apple, Microsoft) are accepted as endpoints. The key pair and the
subscriptions are kept in `dashboard-push.json` in the state directory, encrypted like the sessions; a
subscription ends with its session (sign-out, expiry, a refused renewal). Without push the open dashboard shows
the notifications itself.

The dashboard uses the same OAuth application and callback; the proxy must forward the dashboard path and its sub-paths (`/data`, `/approve`, `/signin`, `/signout`, `/push`). With `dashboard.path = "/dashboard"` the proxy can also send `/` there, so the host itself opens the dashboard.

Alternatively set `gitlab.approve.oauth.auto_setup = true`. On startup,
teams-live creates a confidential application owned by the primary GitLab
token's user with the `api` scope and its configured callback. The one-time
client secret is stored in `gitlab-oauth.json` in the
service state directory, mode 0600. Back up this file: GitLab does not return
the secret again. When configured, existing explicit credentials are used if
automatic setup fails. Switching to the managed application requires users to
authorize it again. A matching application without a local state file is not
adopted or deleted. If
creation is interrupted or its outcome is unknown, a `.pending` marker stops
automatic retries until the application and state have been checked manually.

The environment fallbacks are `TEAMS_GITLAB_APPROVE_*` (`ENABLE`, `HOST`,
`PORT`, `BASE_URL`, `LINK_TTL_SECONDS`). The former `owner_users`,
`owner_users_file`, `user_header`, `proxy_secret`, `proxy_secret_file` and
`proxy_secret_header` keys are no longer used; a configuration that still sets
them gets a warning and they are ignored.

The button stays available while the merge request is open and its head is
known, even after it has enough approvals, so another user can approve it. The
page checks whether the signed-in user has already approved. After an approval
the card of the merge request is re-checked; the
page says whether that refresh ran, failed or had no card to update.

#### Reopening from a closed card

The same flow serves a second button. A card of a **closed** merge request that
was not merged gets a "🔄 Reopen" button (never a merged, open or draft one). It
uses its own capability links, with the same token, session, CSRF, Origin and
single-use rules as an approval link, but without a head commit: the page checks
that the merge request is still closed (an open one reports "Already open", a
merged one is refused), and a confirmed POST reopens it with the configured
GitLab account. After an unclear answer the state is read back before anything
is reported or used up. The card is re-checked afterwards like after an
approval. Approval and reopen links of one merge request do not affect each other.

#### Merging from a card

A third button, "🔀 Merge", sits on the card of an **open, non-draft** merge
request (next to Approve; never on merged, closed, draft or "needs rebase"
cards). It reuses the approval machinery unchanged: the 256-bit token lives in
the URL fragment and is exchanged for an HttpOnly session cookie, the mutating
POST needs the CSRF token and a matching Origin, every action on one merge
request runs under the same per-MR lock, and links live for `link_ttl_seconds`
(24 hours by default). Merge links are separate records: they do not affect, and
are not affected by, approve or reopen links.

- The link is bound to the head commit of the card. A GET never changes
  anything; it re-reads the merge request and shows the button only when it is
  open, not a draft, still at that head and GitLab's `detailed_merge_status`
  says `mergeable`. A merge request with new commits supersedes the link.
- The POST evaluates again under the lock and sends **one** `PUT .../merge` with
  only `sha` (the head guard). Nothing is overridden: approvals, pipelines,
  protected branches and conflicts are enforced by GitLab. The request is never
  resent automatically, not even after a network error.
- No answer is taken at its word. After a rejection (401, 403, 404, 405, 406,
  409, 422) the merge request is read back once; only when that read shows it
  still open does the page say it was not merged. After an unclear outcome
  (timeout, 5xx, an answer that is not "merged" at the expected head) it is read
  back up to eight times, two seconds apart, because GitLab may still be merging
  or have queued the merge; if it still shows as open the page says so and that
  a queued merge can finish later, rather than claiming nothing happened. Only a
  confirmed `merged` at the expected head (also after a rejection, for example a
  double click) uses the link up, retires approve links and refreshes the card.
  Merged at another head, still merging or unreadable are reported as such (no
  false success, no false "nothing was merged") and keep the link, apart from
  "merged elsewhere" and "closed".
- Source-branch removal and squash follow the merge request's own settings. Auto
  merge ("when pipeline succeeds") is not used.
- The merge is made with the configured GitLab account, not as the person
  clicking. The page says so, and anyone holding the link can merge. Treat the
  chat the card is posted in accordingly.
- Merge links are stored under their own key (`mergeRecords`) in the state
  file. A build without this feature reads only `records`, so after a rollback
  it simply does not know the merge links (and keeps its approve and reopen
  links); a merge link can never turn into an approval. Rolling forward again
  starts with fresh merge links.
- Off by default. `gitlab.approve.merge_enabled` (or
  `TEAMS_GITLAB_APPROVE_MERGE_ENABLED=true`) turns it on, in addition to
  `gitlab.approve.enable` and `teams.rich_messages`; enabling approvals alone
  never enables merging. While it is off no merge link is minted, no Merge
  button is shown, and a merge link that is still around answers "Merging from
  cards is turned off" without sending anything.

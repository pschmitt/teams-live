# teams-live

<p align="center">
  <img src="cover.png" alt="teams-live cover" width="480">
</p>

<p align="center">
  <a href="https://nixbot.brkn.lol/repos/github/pschmitt/teams-live"><img src="https://nixbot.brkn.lol/repos/github/pschmitt/teams-live/badge.svg?branch=main" alt="nixbot"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="GPL-3.0"></a>
</p>

Real-time Microsoft Teams bot and watcher daemon integrated with GitLab, Jira, Confluence, and OpsGenie.

## Features

- **Push Notifications & Trouter Integration**: Listens for live Teams events via Trouter websockets with automatic token refresh and self-healing authentication.
- **GitLab MR Tracking**: Monitors merge requests linked in watched chats, automatically reflects status via reactions (👀 pending review, 👍 approved, ❌ CI failure, ✅ merged), and posts/updates in-place comments for CI results, rebase requirements, and merges.
- **OpsGenie Integration**: Lists open alerts across CKS queues (On-Call & Support) sorted by priority with active on-duty personnel.
- **Jira Integration**: Displays active sprint task breakdowns (To Do, In Progress, In Review).
- **Confluence Integration**: Detects linked Confluence docs in watched chats and replies with page title, link, space, and author; includes `/doc` command lookup.
- **GitLab Code Previews**: A link to a line or line range of a GitLab file (`.../-/blob/main/src/app.js#L10-20`) in your own messages gets a reply with those lines (default at most 30; at least five are shown when the file has them, with the linked lines always marked), as a code block or a code card. It reads the file through the GitLab API of the configured host (any project the token can read, or only `gitlab.group` with `restrict_to_group`; `<project>.git//blob/...` links work too) and skips credential-like paths, binary and large files. Configure with `gitlab.code_preview.{enable,max_lines,restrict_to_group,allow_other_senders}` ([docs](docs/nix.md)). To see an example without the live service, run `node src/smoke-rich.mjs <your-notes-chat-id> --kind code --mode both` (add `--dry-run` to only print the payloads).
- **Link Preview Thumbnails**: Automatically captures a webpage screenshot via browser-daemon and edits the author's message with an inline preview whenever the user pastes an unrecognized link (excluding recognized GitLab, Jira, Confluence, and OpsGenie links, and code links with a line anchor).
- **Calendar & Meetings**: Queries Microsoft Teams EMEA MiddleTier calendar for remaining weekly meetings with clickable Teams join links.
- **Rich Messages (optional)**: Set `teams.rich_messages` to post GitLab, Jira, OpsGenie and Confluence updates, and the replies of structured commands (`/mrs`, `/whois`, `/whereis`, `/alerts`, ...), as Adaptive Cards instead of regular text. Off by default; see [docs/nix.md](docs/nix.md#rich-messages). Merge request cards can carry an optional "👍 Approve" button that opens a capability-link confirmation page (anyone with the link can approve as the configured GitLab account) ([docs](docs/nix.md#approving-from-a-card)).
- **Dashboard (optional)**: A signed-in web page (`<approve base_url>/dashboard`) for members of the GitLab group: the open merge requests (read as you, with inline Approve), the active sprint, open alerts with who is on call, and the next meetings, with desktop and push notifications for the events you pick ([docs](docs/nix.md#dashboard)).
- **Slash Commands**:
  - **GitLab**:
    - `/unapprove [link]` (aliases `/revoke`, `/disapprove`): Withdraws the bot's approval of the target MR and comments who asked for it (approvals of other people stay).
    - `/approve [link|all]`: Approves target GitLab MR (or `/approve all` for all eligible human MRs with green/no pipeline in the group).
    - `/ci` (or `/pipeline`) `[link]`: Detailed CI pipeline status, stages, and failed jobs.
    - `/close [link]`: Closes the target MR.
    - `/merge [link]` (or `/accept`): Merges the target MR (or sets auto-merge if CI is currently running).
    - `/mrs [all|bots|me|mine|<user>]`: Lists open merge requests (default: only the human ones; `all` adds the bot ones, `bots` shows only those; or filter by user).
    - `/rebase [link]`: Triggers conflict-free GitLab MR rebase.
    - `/reopen [link]`: Reopens a closed target MR.
    - `/retry [link]`: Retries failed jobs on the latest GitLab pipeline for the target MR.
    - `/status [link]`: Checks CI, approvals, and rebase state for the target MR.
  - **Jira & Planning**:
    - `/doc` (or `/wiki`, `/confluence`) `[link|id]`: Confluence document details, space, and author.
    - `/issue` (or `/ticket`) `[KEY]`: Jira issue details, type, status, and assignee.
    - `/sprint` (or `/jira`): Active Jira sprint tickets and assignees.
    - `/standup` (or `/today`): Summarizes your assigned Jira sprint tasks and open GitLab MRs.
  - **Operations & On-Call**:
    - `/alerts` (or `/opsgenie`) `[oncall|support]`: Live OpsGenie alerts and on-duty responders.
    - `/oncall` (or `/whoisoncall`): Active on-call engineers across Platform and Support.
  - **Productivity & Tools**:
    - `/meetings` (or `/cal`, `/calendar`): Remaining weekly agenda with direct meeting links.
    - `/poll "Question" "Opt1" "Opt2"`: Creates an interactive reaction poll.
    - `/weather [location]`: Current weather observations via wttr.in.
    - `/whois <search>` (or `/who`): Looks up a person in the Teams directory and displays contact details.
  - **Fun & Games**:
    - `/flip`: Flips a coin (Heads or Tails).
    - `/leaderboard`: Tracks and ranks chat interactions and command usage.
    - `/random`: Random trivia facts.
    - `/dice` (or `/roll`) `[expr]`: Rolls dice or picks one option (e.g. `/dice 2d6+3`, `/dice d20 adv`, `/dice pizza | sushi`).
    - `/snake`: Plays an interactive round of Snake by editing a message.
  - **General & Admin**:
    - `/about`: Source repository and project information.
    - `/exec <cmd>`: Executes a command [admin only].
    - `/help` (or `/usage`) `[category]`: Lists supported slash commands (or filter by category).
    - `/marco`: Diagnostic round-trip latency and echo probe.
    - `/sudo [cmd]` (or `/admin`): Administrative controls (restart, reauth, status, kick, ban, unban, bans) [admin only].

## Install

On NixOS, add the flake input and enable the module:

```nix
{
  imports = [ inputs.teams-live.nixosModules.default ];
  services.teams-live = {
    enable = true;
    settings.gitlab.host = "git.example.com";
  };
}
```

Settings, secrets and the health check are in [docs/nix.md](docs/nix.md).

## Documentation

| Topic | |
| --- | --- |
| [Nix](docs/nix.md) | Flake outputs, NixOS module, secrets, settings reference |

## License & Development

- Repository: [github.com/pschmitt/teams-live](https://github.com/pschmitt/teams-live)
- Author: [Philipp Schmitt](https://github.com/pschmitt)
- License: [GNU General Public License v3.0 or later (GPL-3.0-or-later)](LICENSE)

## Support

If you find this useful, consider supporting further development:
👉 [Sponsor on GitHub](https://github.com/sponsors/pschmitt)

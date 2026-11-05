# teams-live

<p align="center">
  <img src="cover.png" alt="teams-live cover" width="480">
</p>

<p align="center">
  <a href="https://nixbot.brkn.lol/repos/github/pschmitt/teams-live"><img src="https://nixbot.brkn.lol/repos/github/pschmitt/teams-live/badge.svg?branch=main" alt="nixbot"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="GPL-3.0"></a>
</p>

Real-time Microsoft Teams bot and watcher daemon integrated with GitLab, Jira, and OpsGenie.

## Features

- **Push Notifications & Trouter Integration**: Listens for live Teams events via Trouter websockets with automatic token refresh and self-healing authentication.
- **GitLab MR Tracking**: Monitors merge requests linked in watched chats, automatically reflects status via reactions (👀 pending review, 👍 approved, ❌ CI failure, ✅ merged), and posts/updates in-place comments for CI results, rebase requirements, and merges.
- **OpsGenie Integration**: Lists open alerts across CKS queues (On-Call & Support) sorted by priority with active on-duty personnel.
- **Jira Integration**: Displays active sprint task breakdowns (To Do, In Progress, In Review).
- **Calendar & Meetings**: Queries Microsoft Teams EMEA MiddleTier calendar for remaining weekly meetings with clickable Teams join links.
- **Slash Commands**:
  - **GitLab**:
    - `/approve [link|all]`: Approves target GitLab MR (or `/approve all` for all eligible human MRs with green/no pipeline in the group).
    - `/ci` (or `/pipeline`) `[link]`: Detailed CI pipeline status, stages, and failed jobs.
    - `/close [link]`: Closes the target MR.
    - `/merge [link]` (or `/accept`): Merges the target MR (or sets auto-merge if CI is currently running).
    - `/mrs [all|bots|me|mine|<user>]`: Lists open merge requests (default hides extra bot MRs; filter by user or view all/bots).
    - `/rebase [link]`: Triggers conflict-free GitLab MR rebase.
    - `/reopen [link]`: Reopens a closed target MR.
    - `/retry [link]`: Retries failed jobs on the latest GitLab pipeline for the target MR.
    - `/status [link]`: Checks CI, approvals, and rebase state for the target MR.
  - **Jira & Planning**:
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
  - **Fun & Games**:
    - `/flip`: Flips a coin (Heads or Tails).
    - `/leaderboard`: Tracks and ranks chat interactions and command usage.
    - `/random`: Random trivia facts.
    - `/roll` (or `/dice`) `[expr]`: Rolls dice (e.g. `/roll`, `/roll d20`, `/roll 2d6`).
    - `/snake`: Plays an interactive round of Snake by editing a message.
  - **General & Admin**:
    - `/about`: Source repository and project information.
    - `/exec <cmd>`: Executes a command [admin only].
    - `/help` (or `/usage`) `[category]`: Lists supported slash commands (or filter by category).
    - `/marco`: Diagnostic round-trip latency and echo probe.
    - `/sudo [cmd]` (or `/admin`): Administrative controls (restart, reauth, status, kick, ban, unban, bans) [admin only].

## License & Development

- Repository: [github.com/pschmitt/teams-live](https://github.com/pschmitt/teams-live)
- Author: [Philipp Schmitt](https://github.com/pschmitt)
- License: [GNU General Public License v3.0 or later (GPL-3.0-or-later)](LICENSE)

## Support

If you find this useful, consider supporting further development:
👉 [Sponsor on GitHub](https://github.com/sponsors/pschmitt)

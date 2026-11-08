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
  `jira.token_file`, `home_assistant.token_file`,
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
| `teams.troll_user` | User MRI whose `/exec` gets a joke reply instead of the fake shell output. |
| `browser_daemon.url`, `.profile`, `.secret_file` | browser-daemon used to sign in to Teams again. |
| `gitlab.host`, `.group`, `.token_file` | GitLab instance, group for `/mrs`, API token. |
| `gitlab.poll_interval_seconds` | MR status poll (60). |
| `gitlab.history_limit`, `.history_max_age_minutes` | Messages scanned at startup. |
| `gitlab.max_watch_duration_seconds` | How long an MR is watched (7200). |
| `gitlab.notify.ci.{enable,on_failure,on_success}` | CI result messages. |
| `gitlab.notify.{rebase,approval_lost,merged,closed}` | Other MR messages. |
| `jira.url`, `.token_file`, `.board_id` | Jira for `/sprint`, `/issue` and `/standup`. |
| `opsgenie.on_call_key`, `.support_key`, `.edge_key` | OpsGenie API keys for `/alerts` and `/oncall`. |
| `opsgenie.on_call_schedule_id`, `.support_schedule_id` | Schedules for `/oncall`. |
| `opsgenie.base_url`, `.web_base_url` | OpsGenie API and web URLs. |
| `home_assistant.url`, `.token_file` | Home Assistant with the HR WORKS integration, for `/whereis`. |
| `conversations` | Chats to watch: `{ id, name, gitlab }`. Default: the self chat `48:notes`. |

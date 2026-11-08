{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    mkPackageOption
    mkRenamedOptionModule
    types
    ;
  cfg = config.services.teams-live;

  settingsFormat = pkgs.formats.json { };

  configFile =
    if cfg.configFile != null then
      cfg.configFile
    else
      settingsFormat.generate "teams-live-config.json" cfg.settings;

  stateDir = "${cfg.dataDir}/state";

  healthCheck = pkgs.writeShellScript "teams-live-health" ''
    exec ${lib.getExe' cfg.package "teams-live-health"} \
      --state-dir ${lib.escapeShellArg stateDir} \
      --unit teams-live.service "$@"
  '';

  renamed =
    from: to:
    mkRenamedOptionModule [ "services" "teams-live" from ] (
      [
        "services"
        "teams-live"
        "settings"
      ]
      ++ to
    );
in
{
  imports = [
    (renamed "credentialsFile" [
      "teams"
      "credentials_file"
    ])
    (renamed "gitlabTokenFile" [
      "gitlab"
      "token_file"
    ])
    (renamed "browserDaemonUrl" [
      "browser_daemon"
      "url"
    ])
    (renamed "browserDaemonProfile" [
      "browser_daemon"
      "profile"
    ])
    (renamed "browserDaemonSecretFile" [
      "browser_daemon"
      "secret_file"
    ])
  ];

  options.services.teams-live = {
    enable = mkEnableOption "teams-live, the Microsoft Teams bot with GitLab, Jira and OpsGenie integration";

    package = mkPackageOption pkgs "teams-live" { };

    settings = mkOption {
      type = types.submodule { freeformType = settingsFormat.type; };
      default = { };
      example = lib.literalExpression ''
        {
          gitlab.host = "git.example.com";
          gitlab.token_file = config.sops.secrets."teams-live/gitlab-token".path;
          opsgenie.on_call_key._secret = config.sops.secrets."opsgenie/key".path;
          conversations = [
            { id = "48:notes"; name = "Notes (Self)"; gitlab = true; }
          ];
        }
      '';
      description = ''
        teams-live configuration, written to a JSON file in the Nix store.
        See `docs/nix.md` in the teams-live repository for the keys.

        Never put a secret here directly: replace any string value with
        `{ _secret = "/path/to/file"; }` and teams-live reads the value
        from that file when it starts.
      '';
    };

    configFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = ''
        Path to a complete JSON configuration file, used instead of
        {option}`settings`. A file outside the Nix store does not restart
        the service when it changes; restart it yourself.
      '';
    };

    dataDir = mkOption {
      type = types.path;
      default = "/var/lib/teams-live";
      description = "Directory for state, token caches and session data.";
    };

    user = mkOption {
      type = types.str;
      default = "teams-live";
      description = "User account under which teams-live runs.";
    };

    group = mkOption {
      type = types.str;
      default = "teams-live";
      description = "Group under which teams-live runs.";
    };

    extraGroups = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = "Supplementary groups for the service, for example to read secret files.";
    };

    healthCheck = mkOption {
      type = types.str;
      readOnly = true;
      default = "${healthCheck}";
      defaultText = lib.literalExpression "teams-live-health for this service";
      description = ''
        Health check command for monitoring (monit, Nagios, ...). It exits
        0 while the service is healthy, starting or degraded, and non-zero
        when it should be restarted.
      '';
    };
  };

  config = mkIf cfg.enable {
    warnings = lib.optional (cfg.configFile != null && cfg.settings != { }) ''
      services.teams-live: both configFile and settings are set; settings is ignored.
    '';

    environment.systemPackages = [ cfg.package ];

    users = {
      users = mkIf (cfg.user == "teams-live") {
        teams-live = {
          isSystemUser = true;
          inherit (cfg) group extraGroups;
          home = cfg.dataDir;
        };
      };
      groups = mkIf (cfg.group == "teams-live") { teams-live = { }; };
    };

    systemd.tmpfiles.settings.teams-live =
      lib.genAttrs
        [
          cfg.dataDir
          stateDir
          "${cfg.dataDir}/cache"
          "${cfg.dataDir}/config"
        ]
        (_: {
          d = {
            inherit (cfg) user group;
            mode = "0700";
          };
        });

    systemd.services.teams-live = {
      description = "teams-live Microsoft Teams bot";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      environment = {
        HOME = cfg.dataDir;
        XDG_STATE_HOME = stateDir;
        XDG_CACHE_HOME = "${cfg.dataDir}/cache";
        XDG_CONFIG_HOME = "${cfg.dataDir}/config";
      };

      serviceConfig = {
        User = cfg.user;
        Group = cfg.group;
        SupplementaryGroups = cfg.extraGroups;
        WorkingDirectory = cfg.dataDir;
        ExecStart = "${lib.getExe cfg.package} --config ${configFile}";
        Type = "notify";
        NotifyAccess = "all";
        WatchdogSec = "120s";
        Restart = "always";
        RestartSec = "10s";

        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [ cfg.dataDir ];
        PrivateTmp = true;
        ProtectControlGroups = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
      };
    };
  };
}

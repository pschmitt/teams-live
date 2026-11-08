#!/usr/bin/env bash
# Health check for the teams-live service, for monit or similar.
# Exit 0: healthy, starting or degraded; non-zero: the service needs a restart.

usage() {
  cat <<USAGE
Usage: $(basename "$0") [OPTIONS]

Check the teams-live service and its health.json.

Options:
  -s, --state-dir DIR   State directory (default: \$TEAMS_LIVE_STATE_DIR or
                        /var/lib/teams-live/state)
  -u, --unit UNIT       systemd unit (default: \$TEAMS_LIVE_UNIT or
                        teams-live.service)
  -m, --max-age SECS    Maximum age of health.json (default: 90)
  -h, --help            Show this help
USAGE
}

errors_of() {
  jq -r '(.errors // []) | join(", ")' "$1"
}

check_health() {
  local unit="$1"
  local health_file="$2"
  local max_age="$3"

  if ! systemctl is-active --quiet "$unit"
  then
    echo "$unit is not active" >&2
    return 1
  fi

  if [[ ! -f "$health_file" ]]
  then
    echo "$health_file does not exist yet" >&2
    return 2
  fi

  local now mtime age
  now="$(date +%s)" || return 1
  mtime="$(stat -c %Y "$health_file")" || return 1
  age=$(( now - mtime ))
  if (( age > max_age ))
  then
    echo "health.json is stale (${age}s old, limit: ${max_age}s)" >&2
    return 3
  fi

  local status uptime errors
  status="$(jq -r '.status // "unknown"' "$health_file")" || return 1
  uptime="$(jq -r '.uptime_seconds // 0' "$health_file")" || return 1

  case "$status" in
    starting)
      echo "teams-live is starting up (${uptime}s)"
      ;;
    unhealthy)
      if (( uptime < 45 ))
      then
        echo "teams-live is in startup grace period (${uptime}s)"
        return 0
      fi
      errors="$(errors_of "$health_file")"
      echo "teams-live is unhealthy: ${errors:-unknown error}" >&2
      return 4
      ;;
    degraded)
      errors="$(errors_of "$health_file")"
      echo "teams-live is degraded: ${errors:-unknown issue}"
      ;;
    *)
      echo "teams-live is healthy (${status})"
      ;;
  esac
}

main() {
  local state_dir="${TEAMS_LIVE_STATE_DIR:-/var/lib/teams-live/state}"
  local unit="${TEAMS_LIVE_UNIT:-teams-live.service}"
  local max_age=90

  while [[ -n "${1:-}" ]]
  do
    case "$1" in
      -h|--help)
        usage
        return 0
        ;;
      -s|--state-dir)
        state_dir="${2:-}"
        shift 2
        ;;
      -u|--unit)
        unit="${2:-}"
        shift 2
        ;;
      -m|--max-age)
        max_age="${2:-}"
        shift 2
        ;;
      *)
        echo "Unknown argument: $1" >&2
        usage >&2
        return 2
        ;;
    esac
  done

  if [[ -z "$state_dir" || -z "$unit" || -z "$max_age" ]]
  then
    usage >&2
    return 2
  fi

  check_health "$unit" "${state_dir}/health.json" "$max_age"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]
then
  main "$@"
fi

# vim: set ft=sh et ts=2 sw=2 :

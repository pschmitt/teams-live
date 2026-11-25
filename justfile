set shell := ["bash", "-cu"]

default:
  @just --list

build:
  nix build .#teams-live

check:
  node --check src/main.mjs
  node --check src/watcher.mjs
  node --check src/teams.mjs
  node --check src/auth.mjs
  node --check src/gitlab.mjs
  node --check src/jira.mjs
  node --check src/confluence.mjs
  node --check src/screenshot.mjs
  node --check src/opsgenie.mjs
  node --check src/snake.mjs
  node --check src/config.mjs
  node --check src/cards.mjs
  node --check src/code-highlight.mjs
  node --check src/avatars.mjs
  node --check src/avatar-sources.mjs
  node --check src/card-user-row.mjs
  node --check src/smoke-rich.mjs
  node --check src/trouter.mjs
  node --check src/message-links.mjs
  node --check src/webhook.mjs
  node --check src/approve.mjs
  node --check src/approve-page.mjs
  node --check src/dashboard.mjs
  node --check src/webpush.mjs
  node --check src/logger.mjs
  shellcheck scripts/*.sh
  nix flake check

test:
  node --test tests/*.test.mjs

fmt:
  nixfmt flake.nix nix/*.nix

run *args:
  node src/main.mjs {{ args }}

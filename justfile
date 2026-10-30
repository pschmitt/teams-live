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
  node --check src/opsgenie.mjs
  node --check src/snake.mjs
  node --check src/config.mjs
  node --check src/trouter.mjs
  nix flake check

fmt:
  nixfmt flake.nix nix/*.nix

run *args:
  node src/main.mjs {{ args }}

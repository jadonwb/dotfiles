#!/usr/bin/env bash
set -euo pipefail

# Install Yazi plugins declared in ~/.config/yazi/package.toml via `ya pkg`.
# Runs after every `chezmoi apply`; no-ops unless package.toml changed.

config_dir="$HOME/.config/yazi"
pt="$config_dir/package.toml"

# Fresh machine / submodule not yet checked out: nothing to install yet.
if [[ ! -f "$pt" ]]; then
  exit 0
fi

# `ya` not installed yet: skip; rerun apply once yazi is present.
if ! command -v ya >/dev/null 2>&1; then
  echo "yazi: 'ya' not found on PATH; skipping plugin install"
  exit 0
fi

# Idempotency: only install when the deployed package.toml changed.
sum="$(sha256sum "$pt" | awk '{print $1}')"
lock="${XDG_CACHE_HOME:-$HOME/.cache}/yazi/package-installed.sha256"
if [[ -f "$lock" ]] && [[ "$(cat "$lock")" == "$sum" ]]; then
  exit 0
fi

echo "yazi: installing plugins from $pt"
# Pin the config home so `ya` reads the chezmoi-deployed package.toml even if a
# custom XDG_CONFIG_HOME is set (chezmoi always deploys dot_config -> $HOME/.config).
XDG_CONFIG_HOME="$HOME/.config" ya pkg install

mkdir -p "$(dirname "$lock")"
printf '%s\n' "$sum" > "$lock"
echo "yazi: plugins installed"

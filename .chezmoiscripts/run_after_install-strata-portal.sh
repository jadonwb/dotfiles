#!/usr/bin/env bash
set -euo pipefail

# Strata comes from the Omarchy package. Register it as the desktop's
# file-chooser portal implementation so the picker uses the packaged binary.

if ! command -v strata >/dev/null 2>&1; then
  echo "strata: not installed; skipping portal setup" >&2
  exit 0
fi

# The desktop name is normally set in a desktop terminal; fall back to the
# systemd user environment when applying over SSH.
desktop="${XDG_CURRENT_DESKTOP:-}"
if [[ -z "$desktop" ]] && command -v systemctl >/dev/null 2>&1; then
  desktop="$(systemctl --user show-environment 2>/dev/null | sed -n 's/^XDG_CURRENT_DESKTOP=//p')"
fi

if [[ -n "$desktop" ]]; then
  if ! XDG_CURRENT_DESKTOP="$desktop" strata --install-portal; then
    echo "strata: portal setup failed; run strata --install-portal from a desktop session" >&2
  fi
else
  echo "strata: portal setup skipped (no desktop session); run strata --install-portal from a desktop session" >&2
fi

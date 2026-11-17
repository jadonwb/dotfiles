#!/usr/bin/env bash
set -euo pipefail

# Register Strata as the per-user XDG Desktop Portal file chooser
#
# `strata --install-portal` writes $XDG_DATA_HOME/xdg-desktop-portal/portals/
# strata.portal, a D-Bus activation service, merges `strata;` into the desktop's
# portals.conf FileChooser preference, and restarts xdg-desktop-portal. It is
# safe to repeat, but repeating it restarts the portal frontend and kills open
# file dialogs. So check the installed state first and leave it alone while it
# already matches this machine's binary and portals.conf; only an actual change
# calls Strata's installer.

if ! command -v strata >/dev/null 2>&1; then
  echo "strata: not installed; skipping portal setup" >&2
  exit 0
fi

data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"

# This repository configures Hyprland only: chezmoi deploys
# dot_config/xdg-desktop-portal/hyprland-portals.conf, so that is the
# preference file Strata has to merge itself into.
desktop="hyprland"

portal="$data_home/xdg-desktop-portal/portals/strata.portal"
service="$data_home/dbus-1/services/org.freedesktop.impl.portal.desktop.strata.service"
conf="$config_home/xdg-desktop-portal/$desktop-portals.conf"
binary="$(readlink -f "$(command -v strata)")"

if [[ -f "$portal" ]] &&
  [[ -f "$service" ]] &&
  grep -qxF "Exec=$binary --portal" "$service" &&
  grep -qE '^org\.freedesktop\.impl\.portal\.FileChooser=strata(;|$)' "$conf"; then
  exit 0
fi

if ! XDG_CURRENT_DESKTOP="$desktop" strata --install-portal; then
  echo "strata: portal setup failed; run 'strata --install-portal' from a desktop session" >&2
fi

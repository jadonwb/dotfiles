#!/bin/bash

set -euo pipefail

paths=(
  "/usr/local/bin/hyprctl"
  "/usr/local/bin/hyprpm"
  "/usr/local/bin/hyprland"
  "/usr/local/bin/hyprlock"
  "/usr/local/bin/hypridle"
  "/usr/local/include/hyprland"
  "/usr/local/include/hyprland/protocols/hyprland-global-shortcuts-v1-protocol.h"
  "/usr/local/include/hyprland/protocols/hyprland-toplevel-export-v1-protocol.h"
  "/usr/local/include/hyprland/wlroots-hyprland"
  "/usr/local/include/hyprland/src/hyprerror"
  "/usr/local/lib/systemd/user/hypridle.service"
  "/usr/local/share/man/man1/hyprctl.1"
  "/usr/local/share/zsh/site-functions/_hyprctl"
  "/usr/local/share/zsh/site-functions/_hyprpm"
  "/usr/local/share/wayland-sessions/hyprland.desktop"
  "/usr/local/share/hyprland"
  "/usr/local/share/bash-completion/completions/hyprctl"
  "/usr/local/share/bash-completion/completions/hyprpm"
  "/usr/local/share/fish/vendor_completions.d/hyprctl.fish"
  "/usr/local/share/fish/vendor_completions.d/hyprpm.fish"
  "/usr/local/share/xdg-desktop-portal/hyprland-portals.conf"
  "/usr/local/share/pkgconfig/hyprland.pc"
)

mode="backup"
if [[ -e "${paths[0]}.bak" ]]; then
  mode="restore"
fi

echo "Detected mode: $mode"
sleep 1

for p in "${paths[@]}"; do
  if [[ "$mode" == "backup" ]]; then
    if [[ -e "$p" && ! -e "${p}.bak" ]]; then
      echo "Backing up $p → ${p}.bak"
      sudo mv "$p" "${p}.bak"
    fi
  else
    if [[ -e "${p}.bak" && ! -e "$p" ]]; then
      echo "Restoring ${p}.bak → $p"
      sudo mv "${p}.bak" "$p"
    fi
  fi
done

echo "Done: all $mode operations completed."

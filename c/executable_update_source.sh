#!/bin/bash

set -euo pipefail

YAZI_DIR="$HOME/c/yazi"
WALKER_DIR="$HOME/c/walker"
ELEPHANT_DIR="$HOME/c/elephant"
MAKO_DIR="$HOME/c/mako"
QUICKSHELL_DIR="$HOME/c/quickshell"
TERMFILECHOOSER_DIR="$HOME/c/xdg-desktop-portal-termfilechooser"
XDG_TERMINAL_EXEC_DIR="$HOME/c/xdg-terminal-exec"
ELEPHANT_PROVIDERS_DIR="$HOME/.config/elephant/providers"
QUICKSHELL_NIX_PROFILE="${QUICKSHELL_NIX_PROFILE:-}"
XDG_TERMINALS_LIST="$HOME/.config/xdg-terminals.list"
TERMFILECHOOSER_CONFIG_DIR="$HOME/.config/xdg-desktop-portal-termfilechooser"
TERMFILECHOOSER_CONFIG_FILE="$TERMFILECHOOSER_CONFIG_DIR/config"
XDG_PORTAL_CONFIG_DIR="$HOME/.config/xdg-desktop-portal"
XDG_PORTAL_CONFIG_FILE="$XDG_PORTAL_CONFIG_DIR/portals.conf"
YAZI_DESKTOP_FILE="$HOME/.local/share/applications/yazi.desktop"
OMARCHY_LAUNCH_TUI="$HOME/.local/share/omarchy/bin/omarchy-launch-tui"

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

find_nix() {
  local candidate

  for candidate in \
    "${NIX_BIN:-}" \
    "$(command -v nix 2>/dev/null || true)" \
    "$HOME/.nix-profile/bin/nix" \
    "/nix/var/nix/profiles/default/bin/nix"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

run_nix() {
  local nix_bin

  nix_bin="$(find_nix)" || return 1
  "$nix_bin" --extra-experimental-features 'nix-command flakes' "$@"
}

quickshell_profile_args() {
  if [[ -n "$QUICKSHELL_NIX_PROFILE" ]]; then
    printf '%s\n%s\n' --profile "$QUICKSHELL_NIX_PROFILE"
  fi
}

quickshell_profile_bin_dir() {
  if [[ -n "$QUICKSHELL_NIX_PROFILE" ]]; then
    printf '%s/bin\n' "$QUICKSHELL_NIX_PROFILE"
    return
  fi

  printf '%s/bin\n' "$HOME/.nix-profile"
}

update_repo() {
  local repo_dir="$1"

  printf '\n==> Updating %s\n' "$repo_dir"
  cd "$repo_dir"
  git pull
}

build_yazi() {
  printf '\n==> Building yazi\n'
  cd "$YAZI_DIR"
  cargo build --release
  sudo install -m 0755 target/release/yazi target/release/ya /usr/local/bin/
}

build_walker() {
  printf '\n==> Building walker\n'
  cd "$WALKER_DIR"
  cargo build --release
  mkdir -p "$HOME/.cargo/bin"
  install -m 0755 target/release/walker "$HOME/.cargo/bin/"
}

build_elephant() {
  local providers=()
  local provider_path

  printf '\n==> Building elephant\n'
  cd "$ELEPHANT_DIR"
  mkdir -p "$ELEPHANT_PROVIDERS_DIR"

  if compgen -G "$ELEPHANT_PROVIDERS_DIR/*.so" >/dev/null; then
    while IFS= read -r provider_path; do
      providers+=("$(basename "$provider_path" .so)")
    done < <(printf '%s\n' "$ELEPHANT_PROVIDERS_DIR"/*.so | sort)
  else
    providers=(clipboard desktopapplications files menus symbols)
  fi

  (
    cd cmd/elephant
    go install elephant.go
  )

  for provider in "${providers[@]}"; do
    printf '   -> %s\n' "$provider"
    (
      cd "internal/providers/$provider"
      go build -buildmode=plugin
      install -m 0644 "$provider.so" "$ELEPHANT_PROVIDERS_DIR/"
    )
  done
}

build_mako() {
  printf '\n==> Building mako\n'
  cd "$MAKO_DIR"
  meson setup --reconfigure build
  ninja -C build install
}

build_quickshell_nix() {
  local -a profile_args=()

  if ! find_nix >/dev/null; then
    printf '\n==> Unable to build quickshell\n' >&2
    printf 'Nix is required for quickshell on this system. Install Nix, then rerun this script.\n' >&2
    return 1
  fi

  if [[ -n "$QUICKSHELL_NIX_PROFILE" ]]; then
    mkdir -p "$(dirname "$QUICKSHELL_NIX_PROFILE")"
    mapfile -t profile_args < <(quickshell_profile_args)
  fi

  printf '\n==> Installing quickshell to Nix profile\n'
  cd "$QUICKSHELL_DIR"

  if run_nix profile list "${profile_args[@]}" | grep -q 'Name:[[:space:]]*quickshell'; then
    run_nix profile upgrade "${profile_args[@]}" quickshell
  else
    run_nix profile add "${profile_args[@]}" .#quickshell
  fi

  if [[ -n "$QUICKSHELL_NIX_PROFILE" ]]; then
    printf '   quickshell profile: %s\n' "$QUICKSHELL_NIX_PROFILE"
  else
    printf '   quickshell profile: default user profile (~/.nix-profile)\n'
  fi

  printf '   PATH entry: %s\n' "$(quickshell_profile_bin_dir)"
}

build_quickshell() {
  build_quickshell_nix
}

build_xdg_terminal_exec() {
  printf '\n==> Building xdg-terminal-exec\n'
  cd "$XDG_TERMINAL_EXEC_DIR"
  make
  sudo make install prefix=/usr/local
}

build_termfilechooser() {
  printf '\n==> Building xdg-desktop-portal-termfilechooser\n'
  cd "$TERMFILECHOOSER_DIR"
  meson setup --reconfigure build
  ninja -C build
  sudo ninja -C build install
  sudo install -Dm 0644 termfilechooser.portal /usr/share/xdg-desktop-portal/portals/termfilechooser.portal
}

ensure_xdg_terminals_list() {
  printf '\n==> Ensuring xdg-terminal-exec config\n'
  mkdir -p "$(dirname "$XDG_TERMINALS_LIST")"
  cat >"$XDG_TERMINALS_LIST" <<'EOF'
# Terminal emulator preference order for xdg-terminal-exec
# The first found and valid terminal will be used
com.mitchellh.ghostty.desktop
Alacritty.desktop
kitty.desktop
EOF
}

ensure_termfilechooser_config() {
  printf '\n==> Ensuring termfilechooser config\n'
  mkdir -p "$TERMFILECHOOSER_CONFIG_DIR"
  cat >"$TERMFILECHOOSER_CONFIG_FILE" <<'EOF'
[filechooser]
cmd=yazi-wrapper.sh
default_dir=$HOME
env=TERMCMD=/home/jadon.brutcher/.local/share/omarchy/bin/omarchy-launch-tui

open_mode=suggested
save_mode=suggested
EOF
}

ensure_portals_conf() {
  printf '\n==> Ensuring portal preference config\n'
  mkdir -p "$XDG_PORTAL_CONFIG_DIR"
  cat >"$XDG_PORTAL_CONFIG_FILE" <<'EOF'
[preferred]
org.freedesktop.impl.portal.FileChooser=termfilechooser
EOF
}

ensure_yazi_desktop_entry() {
  printf '\n==> Installing yazi desktop entry\n'
  mkdir -p "$(dirname "$YAZI_DESKTOP_FILE")"
  cat >"$YAZI_DESKTOP_FILE" <<'EOF'
[Desktop Entry]
Name=Yazi File Manager
Comment=Blazing fast terminal file manager written in Rust, based on async I/O
TryExec=yazi
Exec=omarchy-launch-tui yazi %f
Icon=yazi
Terminal=false
Type=Application
MimeType=inode/directory;
Categories=System;FileManager;FileTools;
Keywords=File;Manager;Explorer;Browser;Launcher;
EOF
}

refresh_desktop_database() {
  if command_exists update-desktop-database; then
    printf '\n==> Refreshing desktop database\n'
    update-desktop-database "$HOME/.local/share/applications" || true
  fi
}

restart_portal_services() {
  if command_exists systemctl; then
    printf '\n==> Restarting XDG portal services\n'
    systemctl --user daemon-reload || true
    systemctl --user restart xdg-desktop-portal-termfilechooser.service xdg-desktop-portal.service || true
  fi
}

main() {
  printf '==> Updating Rust toolchain\n'
  rustup update

  update_repo "$YAZI_DIR"
  update_repo "$WALKER_DIR"
  update_repo "$ELEPHANT_DIR"
  update_repo "$MAKO_DIR"
  update_repo "$QUICKSHELL_DIR"
  update_repo "$TERMFILECHOOSER_DIR"
  update_repo "$XDG_TERMINAL_EXEC_DIR"

  build_yazi
  build_walker
  build_elephant
  build_mako
  build_quickshell
  build_xdg_terminal_exec
  build_termfilechooser
  ensure_xdg_terminals_list
  ensure_termfilechooser_config
  ensure_portals_conf
  ensure_yazi_desktop_entry
  refresh_desktop_database
  restart_portal_services

  printf '\nDone. Consider restarting Walker and Elephant services.\n'
  printf 'systemctl --user restart elephant.service app-walker@autostart.service\n'
}

main "$@"

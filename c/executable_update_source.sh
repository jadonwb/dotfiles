#!/bin/bash

set -euo pipefail

FOOT_DIR="$HOME/c/foot"
YAZI_DIR="$HOME/c/yazi"
YAZI_DESKTOP_FILE="$HOME/.local/share/applications/yazi.desktop"
XDG_TERMINAL_EXEC_DIR="$HOME/c/xdg-terminal-exec"
NEOVIM_DIR="$HOME/c/neovim"

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

update_repo() {
  local repo_dir="$1"

  printf '\n==> Updating %s\n' "$repo_dir"
  cd "$repo_dir"

  # Detached HEAD (e.g. neovim pinned to a release tag) has no branch to merge
  # into, so `git pull` fails. Fetch refs/tags instead and let the build step
  # decide what to check out.
  if git symbolic-ref -q HEAD >/dev/null; then
    git pull
  else
    printf '   Detached HEAD at %s; fetching instead of pulling.\n' \
      "$(git describe --tags --always)"
    # --force: some remotes (e.g. neovim nightly/stable) move existing tags, and
    # a plain --tags fetch aborts rather than update them.
    git fetch --prune --tags --force
  fi
}

build_yazi() {
  printf '\n==> Building yazi\n'
  cd "$YAZI_DIR"
  cargo build --release
  sudo install -m 0755 target/release/yazi target/release/ya /usr/local/bin/
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

build_neovim() {
  printf '\n==> Building neovim\n'
  cd "$NEOVIM_DIR"
  git fetch --tags

  local latest_tag
  latest_tag="$(git tag --sort=-version:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1)"

  if [[ -z "$latest_tag" ]]; then
    printf '   Error: no stable tag found\n' >&2
    return 1
  fi

  local installed_ver
  installed_ver="$(nvim --version 2>/dev/null | head -1 | grep -oP 'v\K[0-9.]+' || echo '')"

  if [[ -n "$installed_ver" && "$installed_ver" == "${latest_tag#v}" ]]; then
    printf '   Already at %s, skipping build.\n' "$latest_tag"
    return 0
  fi

  printf '   Building %s (installed: %s)\n' "$latest_tag" "${installed_ver:-none}"
  git checkout "$latest_tag"

  if command -v apt-get >/dev/null 2>&1; then
    local dep
    for dep in cmake gettext ninja-build; do
      if ! dpkg -s "$dep" >/dev/null 2>&1; then
        printf '   Installing build dependency: %s\n' "$dep"
        sudo apt-get install -y "$dep"
      fi
    done
  fi

  make CMAKE_BUILD_TYPE=Release
  sudo make install
}

build_foot() {
  printf '\n==> Building foot\n'

  if command -v apt-get >/dev/null 2>&1; then
    local dep
    for dep in \
      meson ninja-build pkg-config wayland-protocols \
      libwayland-dev libxkbcommon-dev libpixman-1-dev libutf8proc-dev \
      libfreetype-dev libfontconfig1-dev libfcft-dev libtllist-dev \
      libncurses-dev scdoc; do
      if ! dpkg -s "$dep" >/dev/null 2>&1; then
        printf '   Installing build dependency: %s\n' "$dep"
        sudo apt-get install -y "$dep"
      fi
    done
  fi

  cd "$FOOT_DIR"
  meson setup --reconfigure build --buildtype=release -Db_lto=true
  ninja -C build
  sudo ninja -C build install
}

build_xdg_terminal_exec() {
  printf '\n==> Building xdg-terminal-exec\n'
  cd "$XDG_TERMINAL_EXEC_DIR"
  make
  sudo make install prefix=/usr/local
}

refresh_desktop_database() {
  if command_exists update-desktop-database; then
    printf '\n==> Refreshing desktop database\n'
    update-desktop-database "$HOME/.local/share/applications" || true
  fi
}

main() {
  local target="${1:-}"

  case "$target" in
    walker|elephant|mako|quickshell)
      printf '%s is retired or package-managed. Use omarchy update for the Quattro runtime.\n' "$target" >&2
      return 78
      ;;
  esac

  if [[ -n "$target" ]]; then
    case "$target" in
    yazi)
      update_repo "$YAZI_DIR"
      build_yazi
      ensure_yazi_desktop_entry
      refresh_desktop_database
      ;;
    neovim)
      update_repo "$NEOVIM_DIR"
      build_neovim
      ;;
    foot)
      update_repo "$FOOT_DIR"
      build_foot
      ;;
    xdg-terminal-exec)
      update_repo "$XDG_TERMINAL_EXEC_DIR"
      build_xdg_terminal_exec
      ;;
    *)
      printf 'Unknown target: %s\n' "$target" >&2
      printf 'Available: neovim foot yazi xdg-terminal-exec\n' >&2
      return 1
      ;;
    esac
    printf '\nDone.\n'
    return
  fi

  update_repo "$YAZI_DIR"
  update_repo "$XDG_TERMINAL_EXEC_DIR"
  update_repo "$NEOVIM_DIR"
  update_repo "$FOOT_DIR"

  build_yazi
  ensure_yazi_desktop_entry
  build_neovim
  build_foot
  build_xdg_terminal_exec
  refresh_desktop_database

  printf '\nDone. Quattro runtime updates are managed separately by omarchy update.\n'
}

main "$@"

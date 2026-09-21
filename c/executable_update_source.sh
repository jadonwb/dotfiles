#!/bin/bash

set -euo pipefail

FOOT_DIR="$HOME/c/foot"
YAZI_DIR="$HOME/c/yazi"
WALKER_DIR="$HOME/c/walker"
ELEPHANT_DIR="$HOME/c/elephant"
MAKO_DIR="$HOME/c/mako"
QUICKSHELL_DIR="$HOME/c/quickshell"
TERMFILECHOOSER_DIR="$HOME/c/xdg-desktop-portal-termfilechooser"
XDG_TERMINAL_EXEC_DIR="$HOME/c/xdg-terminal-exec"
IMV_DIR="$HOME/c/imv"
NEOVIM_DIR="$HOME/c/neovim"
ELEPHANT_PROVIDERS_DIR="$HOME/.config/elephant/providers"
ELEPHANT_BIN_DIR="$HOME/.local/bin"
ELEPHANT_SERVICE_DROPIN_DIR="$HOME/.config/systemd/user/elephant.service.d"
QUICKSHELL_QT_VERSION="${QUICKSHELL_QT_VERSION:-6.8.3}"
QUICKSHELL_QT_DIR="${QUICKSHELL_QT_DIR:-$HOME/Qt/$QUICKSHELL_QT_VERSION/gcc_64}"
XDG_TERMINALS_LIST="$HOME/.config/xdg-terminals.list"
TERMFILECHOOSER_CONFIG_DIR="$HOME/.config/xdg-desktop-portal-termfilechooser"
TERMFILECHOOSER_CONFIG_FILE="$TERMFILECHOOSER_CONFIG_DIR/config"
XDG_PORTAL_CONFIG_DIR="$HOME/.config/xdg-desktop-portal"
XDG_PORTAL_CONFIG_FILE="$XDG_PORTAL_CONFIG_DIR/portals.conf"
YAZI_DESKTOP_FILE="$HOME/.local/share/applications/yazi.desktop"
# OMARCHY_LAUNCH_TUI="$HOME/.local/share/omarchy/bin/omarchy-launch-tui"

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

  mkdir -p "$ELEPHANT_BIN_DIR"
  (
    cd cmd/elephant
    # Build to a stable, version-independent path instead of mise's
    # version-specific GOBIN (which breaks systemd ExecStart on every Go bump).
    go build -o "$ELEPHANT_BIN_DIR/elephant" elephant.go
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

ensure_elephant_service() {
  printf '\n==> Ensuring elephant systemd user service\n'

  # systemd resolves a bare ExecStart=elephant with its own compiled-in search
  # path, which does not include ~/.local/bin on Ubuntu. Give it one via a
  # drop-in so the unit itself keeps the canonical Omarchy content.
  mkdir -p "$ELEPHANT_SERVICE_DROPIN_DIR"
  cat >"$ELEPHANT_SERVICE_DROPIN_DIR/path.conf" <<'EOF'
[Service]
ExecSearchPath=%h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EOF

  local unit="$HOME/.config/systemd/user/elephant.service"
  local stamp

  # `elephant service enable` only writes the unit if it is absent; repair any
  # stale hand-written unit (e.g. one with a version-pinned absolute ExecStart).
  if [[ ! -f "$unit" ]] || ! grep -q '^ExecStart=elephant$' "$unit"; then
    if [[ -f "$unit" ]]; then
      stamp="$(date +%s)"
      cp -a "$unit" "$unit.bak-$stamp"
      printf '   Replaced non-canonical unit (backup: elephant.service.bak-%s)\n' "$stamp"
      rm -f "$unit"
    fi
    "$ELEPHANT_BIN_DIR/elephant" service enable
  fi

  if command_exists systemctl; then
    systemctl --user daemon-reload || true
    systemctl --user enable elephant.service >/dev/null 2>&1 || true
    systemctl --user restart elephant.service || true
  fi
}

build_mako() {
  printf '\n==> Building mako\n'
  cd "$MAKO_DIR"
  meson setup --reconfigure build
  ninja -C build install
}

build_quickshell() {
  printf '\n==> Building quickshell (Qt %s)\n' "$QUICKSHELL_QT_VERSION"

  if [[ ! -d "$QUICKSHELL_QT_DIR" ]]; then
    printf 'Qt %s not found at %s\n' "$QUICKSHELL_QT_VERSION" "$QUICKSHELL_QT_DIR" >&2
    printf 'Install it with:\n' >&2
    printf '  aqt install-qt linux desktop %s linux_gcc_64 --outputdir "$HOME/Qt" -m qtshadertools qt5compat qtimageformats\n' \
      "$QUICKSHELL_QT_VERSION" >&2
    return 1
  fi

  cd "$QUICKSHELL_DIR"

  cmake -GNinja -B build -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_PREFIX_PATH="$QUICKSHELL_QT_DIR" \
    -DCMAKE_INSTALL_PREFIX="$HOME/.local" \
    -DCMAKE_INSTALL_RPATH="$QUICKSHELL_QT_DIR/lib" \
    -DVENDOR_CPPTRACE=ON
  cmake --build build
  cmake --install build
}

build_imv() {
  printf '\n==> Building imv\n'
  cd "$IMV_DIR"
  meson setup --reconfigure build --prefix="$HOME/.local"
  ninja -C build install
}

build_tensaku() {
  printf '\n==> Building imv\n'
  cargo install --locked tensaku
  tensaku --install-desktop # add the icon + desktop entry
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
  local target="${1:-}"

  printf '==> Updating Rust toolchain\n'
  rustup update

  if [[ -n "$target" ]]; then
    case "$target" in
    neovim)
      update_repo "$NEOVIM_DIR"
      build_neovim
      ;;
    foot)
      update_repo "$FOOT_DIR"
      build_foot
      ;;
    yazi)
      update_repo "$YAZI_DIR"
      build_yazi
      ;;
    walker)
      update_repo "$WALKER_DIR"
      build_walker
      ;;
    elephant)
      update_repo "$ELEPHANT_DIR"
      build_elephant
      ensure_elephant_service
      ;;
    mako)
      update_repo "$MAKO_DIR"
      build_mako
      ;;
    quickshell)
      update_repo "$QUICKSHELL_DIR"
      build_quickshell
      ;;
    imv)
      update_repo "$IMV_DIR"
      build_imv
      ;;
    tensaku)
      build_tensaku
      ;;
    xdg-terminal-exec)
      update_repo "$XDG_TERMINAL_EXEC_DIR"
      build_xdg_terminal_exec
      ;;
    termfilechooser)
      update_repo "$TERMFILECHOOSER_DIR"
      build_termfilechooser
      ensure_xdg_terminals_list
      ensure_termfilechooser_config
      ensure_portals_conf
      restart_portal_services
      ;;
    *)
      printf 'Unknown target: %s\n' "$target" >&2
      printf 'Available: neovim yazi walker elephant mako quickshell imv xdg-terminal-exec termfilechooser\n' >&2
      return 1
      ;;
    esac
    printf '\nDone.\n'
    return
  fi

  update_repo "$YAZI_DIR"
  update_repo "$WALKER_DIR"
  update_repo "$ELEPHANT_DIR"
  update_repo "$MAKO_DIR"
  update_repo "$QUICKSHELL_DIR"
  update_repo "$TERMFILECHOOSER_DIR"
  update_repo "$XDG_TERMINAL_EXEC_DIR"
  update_repo "$IMV_DIR"
  update_repo "$NEOVIM_DIR"
  update_repo "$FOOT_DIR"

  build_yazi
  build_walker
  build_elephant
  ensure_elephant_service
  build_mako
  build_quickshell
  build_imv
  build_tensaku
  build_neovim
  build_foot
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

#!/bin/bash

set -euo pipefail

YAZI_DIR="$HOME/c/yazi"
WALKER_DIR="$HOME/c/walker"
ELEPHANT_DIR="$HOME/c/elephant"
ELEPHANT_PROVIDERS_DIR="$HOME/.config/elephant/providers"

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

  if compgen -G "$ELEPHANT_PROVIDERS_DIR/*.so" > /dev/null; then
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

main() {
  printf '==> Updating Rust toolchain\n'
  rustup update

  update_repo "$YAZI_DIR"
  update_repo "$WALKER_DIR"
  update_repo "$ELEPHANT_DIR"

  build_yazi
  build_walker
  build_elephant

  printf '\nDone. Consider restarting Walker and Elephant services.\n'
  printf 'systemctl --user restart elephant.service app-walker@autostart.service\n'
}

main "$@"

#!/usr/bin/env bash
set -euo pipefail

# Install the latest WezTerm nightly (raw Linux binary) to ~/.local/bin,
# plus shell integration, icon, and terminfo — all under $HOME.
# Runs on every `chezmoi apply`, but only re-downloads when upstream changes.

base_url="https://github.com/wezterm/wezterm/releases/download/nightly"
asset="wezterm-nightly.Ubuntu24.04.tar.xz"
cache="$HOME/.cache/wezterm"
dest="$HOME/.local/bin"
integ_dir="$HOME/.local/share/wezterm"
icon_path="$HOME/.local/share/icons/hicolor/128x128/apps/org.wezfurlong.wezterm.png"

mkdir -p "$cache" "$dest" "$integ_dir" "$(dirname "$icon_path")"

sha_new="$cache/$asset.sha256.new"
sha_marker="$cache/$asset.sha256"

if ! curl -fsSL "${base_url}/${asset}.sha256" -o "$sha_new"; then
    echo "wezterm: offline or GitHub unreachable; keeping existing install" >&2
    rm -f "$sha_new"
    exit 0
fi

installed() {
    [[ -f "$sha_marker" ]] && cmp -s "$sha_marker" "$sha_new" \
        && [[ -x "$dest/wezterm" ]] \
        && [[ -f "$integ_dir/shell-integration.sh" ]] \
        && [[ -f "$icon_path" ]]
}

if installed; then
    rm -f "$sha_new"
    exit 0
fi

curl -fsSL "${base_url}/${asset}" -o "$cache/$asset"
( cd "$cache" && sha256sum -c "${asset}.sha256.new" )
mv "$sha_new" "$sha_marker"

tar -xJf "$cache/$asset" -C "$cache"
root="$cache/wezterm"

# Binaries
for bin in wezterm wezterm-gui wezterm-mux-server strip-ansi-escapes open-wezterm-here; do
    src="$root/usr/bin/$bin"
    [[ -f "$src" ]] && install -m 0755 "$src" "$dest/$bin"
done

# Shell integration (zsh + bash; sourced from ~/.zshrc)
install -m 0644 "$root/etc/profile.d/wezterm.sh" "$integ_dir/shell-integration.sh"

# Icon (keeps the desktop-entry icon working after the distro package is removed)
[[ -f "$root/usr/share/icons/hicolor/128x128/apps/org.wezfurlong.wezterm.png" ]] \
    && install -m 0644 "$root/usr/share/icons/hicolor/128x128/apps/org.wezfurlong.wezterm.png" "$icon_path"

# Terminfo (enables undercurl + truecolor with TERM=wezterm)
if command -v tic >/dev/null 2>&1; then
    terminfo_src="$cache/wezterm.terminfo"
    if curl -fsSL "https://raw.githubusercontent.com/wezterm/wezterm/main/termwiz/data/wezterm.terminfo" -o "$terminfo_src"; then
        tic -x -o "$HOME/.terminfo" "$terminfo_src"
    else
        echo "wezterm: could not download terminfo source; skipping" >&2
    fi
else
    echo "wezterm: 'tic' (ncurses) not found; skipping terminfo" >&2
fi

echo "wezterm: installed $("$dest/wezterm" --version 2>/dev/null || echo latest-nightly)"

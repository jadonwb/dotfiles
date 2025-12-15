#!/bin/bash
set -euo pipefail

# Packages newly installed by your apt command
new_pkgs=(
  hypridle
  hyprland
  hyprland-data
  hyprland-qt-support0
  hyprland-qtutils
  hyprlock
  libaquamarine8
  libhyprcursor1
  libqt6qmlworkerscript6
  libqt6quickcontrols2-6
  libqt6quickcontrols2impl6
  libqt6quicklayouts6
  libqt6quicktemplates2-6
  libsdbus-c++2
  libudis86.1
  libxcb-errors1
  qml6-module-qtqml-workerscript
  qml6-module-qtquick-controls
  qml6-module-qtquick-layouts
  qml6-module-qtquick-templates
  xdg-desktop-portal-hyprland
)

# Packages that were upgraded by your apt command
upgraded_pkgs=(
  gir1.2-gtklayershell-0.1
  gstreamer1.0-pipewire
  libgtk-layer-shell-dev
  libgtk-layer-shell0
  libinput-bin
  libinput-dev
  libinput10
  libpipewire-0.3-0t64
  libpipewire-0.3-common
  libpipewire-0.3-dev
  libpipewire-0.3-modules
  libsdbus-c++-dev
  libspa-0.2-bluetooth
  libspa-0.2-dev
  libspa-0.2-modules
  pipewire
  pipewire-alsa
  pipewire-audio
  pipewire-bin
  pipewire-pulse
  waybar
)

echo "This will remove Hyprland and related PPA packages and attempt to restore your original setup."
read -rp "Continue? (y/N) " yn
[[ "$yn" =~ ^[Yy]$ ]] || exit 1

echo "Removing newly installed packages..."
sudo apt remove --purge -y "${new_pkgs[@]}"

echo "Reinstalling previously upgraded packages to restore system versions..."
sudo apt install --reinstall -y "${upgraded_pkgs[@]}"

echo "Cleaning up..."
sudo apt autoremove -y
sudo apt clean

echo "✅ Done. System reverted to pre-PPA Hyprland state."
echo "If you had source-built versions in /usr/local, use your toggle script to restore them now."

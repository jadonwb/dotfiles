#!/usr/bin/env bash
set -euo pipefail

# Match `omarchy setup security ssh-agent`: enable the GCR SSH agent socket.
# SSH_AUTH_SOCK comes from ~/.config/environment.d/90-gcr-ssh-agent.conf.
# Exits quietly when no systemd user bus is available (chroot, SSH without linger).

if ! command -v systemctl >/dev/null 2>&1; then
    exit 0
fi

if ! systemctl --user show-environment &>/dev/null; then
    exit 0
fi

if systemctl --user cat gcr-ssh-agent.socket &>/dev/null; then
    systemctl --user enable --now gcr-ssh-agent.socket 2>/dev/null || true
fi

# Retire the old key auto-loader before .chezmoiremove deletes its unit file.
if systemctl --user cat ssh-add-auto.service &>/dev/null; then
    systemctl --user disable ssh-add-auto.service 2>/dev/null || true
fi

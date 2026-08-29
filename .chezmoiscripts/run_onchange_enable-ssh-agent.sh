#!/usr/bin/env bash

# Enable systemd user services for SSH agent.
# Fails gracefully if systemd user bus isn't available or if
# the services don't exist on this system.

# Bail gracefully if systemd user bus isn't available (e.g. chroot, SSH w/o linger)
if ! systemctl --user show-environment &>/dev/null; then
    exit 0
fi

# Enable GCR SSH agent socket (comes from the gcr/gnome-keyring package)
if systemctl --user cat gcr-ssh-agent.socket &>/dev/null; then
    systemctl --user enable --now gcr-ssh-agent.socket 2>/dev/null || true
fi

# Enable our key auto-loader (deployed by chezmoi to ~/.config/systemd/user/)
if systemctl --user cat ssh-add-auto.service &>/dev/null; then
    systemctl --user enable --now ssh-add-auto.service 2>/dev/null || true
fi

---
name: Run as root
description:
  Run commands as root/sudo on this Omarchy desktop through the Quickshell
  polkit password dialog. Use for package installs, systemctl, mounts, editing
  /etc, or any privileged command.
---

# Run as root

`run-as-root <command> [args...]` is on PATH and runs the command as root
through the Quickshell polkit password dialog.

- The dialog is the approval. Say it will appear, then run the command. Do not
  pre-test pkexec/polkit or ask for confirmation twice.
- Each call prompts once. Bundle related commands into one `sh -c '...'`.
- If the user dismisses the dialog (exit 126), stop and ask; do not retry.
- Allow time to type: set a shell timeout of 120s or more.
- Use non-interactive flags (`-y`, `DEBIAN_FRONTEND=noninteractive`); root
  commands cannot answer prompts.
- Never request or handle the password.

`run-as-root --help` covers the environment and exit codes.

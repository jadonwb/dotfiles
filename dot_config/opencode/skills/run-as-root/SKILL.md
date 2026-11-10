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

- The wrapper shows an `opencode-announce` notification before the polkit
  dialog, then waits two seconds. Say it will appear, then run the command. Do
  not pre-test pkexec/polkit or ask for confirmation twice.
- Set `RUN_AS_ROOT_NOTE="install libcap-dev"` (a short description) when the
  command's basename alone would not tell the user what is about to happen.
- Each call prompts once. Bundle related commands into one `sh -c '...'`.
- If the user dismisses the dialog (exit 126), stop and ask why.
- Do not avoid retrying after the first failure or rejection, but find out why
  first.
- Allow time to type: set a shell timeout of 120s or more.
- Use non-interactive flags (`-y`, `DEBIAN_FRONTEND=noninteractive`); root
  commands cannot answer prompts.
- Never request or handle the password.

`run-as-root --help` covers the environment and exit codes.

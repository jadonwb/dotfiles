# Chezmoi Dotfiles Repository

This is my dotfiles repository.

Chezmoi deploys each `~/.config/<app>` from the matching `dot_config` path.
`~/.config/nvim` is a git-repo external declared in `.chezmoiexternal.toml`;
the other configs are tracked directly in this repository.

## Setup notes

Non-deployed setup notes live in `docs/`. They are tracked by git but listed in
`.chezmoiignore`, so chezmoi never deploys them to `$HOME`. Use this for
per-machine or per-tool setup steps that should travel with the dotfiles, such
as `docs/op/KEYRING.md`.

## Tests

Repo-only tests live in `tests/` (also in `.chezmoiignore`). Run them from the
repo root, e.g. `tests/diffview-diff/matrix.sh` checks the `diffview-diff`
helper's fast path and fallback.

## Chezmoi scripts

Scripts in `.chezmoiscripts/` install tools that need to track upstream more
closely than distro packages, or finish setup that a package leaves to the
user. Every file in that directory is treated as a script by chezmoi, so keep
documentation here rather than in that directory.

| Prefix                | When it runs                                                  |
| --------------------- | ------------------------------------------------------------- |
| `run_after_`          | After every successful apply. Must be idempotent.             |
| `run_onchange_`       | When the rendered script changes, before the `after` scripts. |
| `run_onchange_after_` | When the rendered script changes, after the `after` scripts.  |

Conventions:

- Start with `#!/usr/bin/env bash` and `set -euo pipefail`.
- Install user tools into `$HOME/.local/bin`; never require `sudo`.
- Pin a version and verify its SHA-256 before installing. Put the pin in
  `.chezmoidata/<tool>.toml` and render it from a `.sh.tmpl` script, so changing
  the pin reruns the script on the next apply.
- Download into `$HOME/.cache/<tool>` (honouring `XDG_CACHE_HOME`) and clean up
  temporary directories with a `trap`.
- Skip optional integrations with a clear warning when prerequisites are absent,
  rather than failing the whole apply.

## Procedure

Run `chezmoi apply` after completed changes; expect a clean apply with live
config matching source. After the user explicitly confirms publication, commit
and push:

1. The Neovim external first — commit and push in `~/.config/nvim` (its own
   repository). Preserve unrelated local modifications, and never amend or
   force-push unless separately requested.
2. Then the chezmoi superproject — stage and commit only the files this work
   changed, then push.
3. When changes span both repositories, finish the Neovim commit and push
   before updating the chezmoi superproject.

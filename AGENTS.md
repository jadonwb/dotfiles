# Chezmoi Dotfiles Repository

This is my dotfiles repository.

## Layout

| Repo path                     | Live config path     | Kind             |
| ----------------------------- | -------------------- | ---------------- |
| `dot_config/external_nvim`    | `~/.config/nvim`     | submodule        |
| `dot_config/opencode`         | `~/.config/opencode` | tracked directly |
| `dot_config/wezterm`          | `~/.config/wezterm`  | tracked directly |
| `dot_config/yazi`             | `~/.config/yazi`     | tracked directly |

Chezmoi deploys each `~/.config/<app>` from the matching `dot_config` path.
`external_nvim` is a git submodule; the other configs are tracked directly in
this repository.

## Setup notes

Non-deployed setup notes live in `docs/`. They are tracked by git but listed in
`.chezmoiignore`, so chezmoi never deploys them to `$HOME`. Use this for
per-machine or per-tool setup steps that should travel with the dotfiles, such
as `docs/op/KEYRING.md`.

## Chezmoi scripts

Scripts in `.chezmoiscripts/` install tools that need to track upstream more
closely than distro packages. Every file in that directory is treated as a
script by chezmoi, so keep documentation here rather than in that directory.

| Prefix | When it runs |
| --- | --- |
| `run_after_` | After every successful apply. Must be idempotent. |
| `run_onchange_` | When the rendered script changes, before the `after` scripts. |
| `run_onchange_after_` | When the rendered script changes, after the `after` scripts. |

Conventions:

- Start with `#!/usr/bin/env bash` and `set -euo pipefail`.
- Install user tools into `$HOME/.local/bin`; never require `sudo`.
- Pin a version and verify its SHA-256 before installing. Put the pin in
  `.chezmoidata/<tool>.toml` and render it from a `.sh.tmpl` script, so changing
  the pin reruns the script on the next apply.
- Download into `$HOME/.cache/<tool>` (honouring `XDG_CACHE_HOME`) and clean up
  temporary directories with a `trap`.
- Skip optional integrations with a clear warning when prerequisites are
  absent, rather than failing the whole apply.

### Strata

Strata is installed from the upstream release tarball into `~/.local/bin`, not
from the Omarchy package, which trails upstream. Update
`.chezmoidata/strata.toml` (version plus both architecture checksums from the
release's `.sha256` assets) and run `chezmoi apply`. The script installs the
binary, desktop entry, icon, and then runs `strata --install-portal` so the
file chooser follows the same binary. Do not use Strata's in-app updater on a
chezmoi-managed machine; update the pin instead.

## Procedure

Run `chezmoi apply` after completed changes; expect a clean apply with live
config matching source. After the user explicitly confirms publication, commit
and push:

1. Each changed application submodule first — stage exactly the files this work
   changed, commit, and push. Preserve unrelated local modifications, and never
   amend or force-push unless separately requested.
2. Then the chezmoi superproject — stage and commit only the changed submodule's
   gitlink, plus any directly tracked config files or other superproject files
   this work changed, then push.
3. When changes span multiple submodules, finish each submodule's commit and
   push before updating the superproject.

This confirmed publication procedure does not require another implementation
Plan. If any step fails or the change scope grows, stop and report instead of
pushing a partial or mis-scoped change.

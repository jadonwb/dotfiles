# Chezmoi Dotfiles Repository

This is my dotfiles repository.

## Layout

| Repo (submodule)               | Live config path     |
| ------------------------------ | -------------------- |
| `dot_config/external_nvim`     | `~/.config/nvim`     |
| `dot_config/external_opencode` | `~/.config/opencode` |
| `dot_config/external_wezterm`  | `~/.config/wezterm`  |
| `dot_config/external_yazi`     | `~/.config/yazi`     |

Chezmoi deploys each `~/.config/<app>` as a regular config directory containing
the contents of the matching `dot_config/external_<app>` submodule checkout.

## Procedure

Run `chezmoi apply` after completed changes; expect a clean apply with live
config matching source. After the user explicitly confirms publication, commit
and push:

1. Each changed application submodule first — stage exactly the files this work
   changed, commit, and push. Preserve unrelated local modifications, and never
   amend or force-push unless separately requested.
2. Then the chezmoi superproject — stage and commit only the changed submodule's
   gitlink plus any superproject-level files this work changed, then push.
3. When changes span multiple submodules, finish each submodule's commit and
   push before updating the superproject.

This confirmed publication procedure does not require another implementation
Plan. If any step fails or the change scope grows, stop and report instead of
pushing a partial or mis-scoped change.

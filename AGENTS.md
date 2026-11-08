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

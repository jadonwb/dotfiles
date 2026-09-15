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

Once changes are finished, please chezmoi apply. If it applies clean, confirm
with user and commit and push. If changes were inside a sub-repository, commit
and push that, and then update the chezmoi superproject too.

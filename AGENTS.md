# Chezmoi Dotfiles Repository

This is my dotfiles repository.

## Layout

| Repo (submodule)  | Live config path     |
| ----------------- | -------------------- |
| `.repos/nvim`     | `~/.config/nvim`     |
| `.repos/opencode` | `~/.config/opencode` |
| `.repos/wezterm`  | `~/.config/wezterm`  |
| `.repos/yazi`     | `~/.config/yazi`     |

Each `~/.config/<app>` is a symlink to the matching `.repos/<app>` directory.

## Procedure

Once changes are finished, please chezmoi apply. If it applies clean, confirm
with user and commit and push. If changes were inside a sub-repository, commit
and push that, and then update the chezmoi superproject too.

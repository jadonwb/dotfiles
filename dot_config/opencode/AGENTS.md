# Global agent guidance

## Shell discipline

Never run interactive commands through the shell tool. Pagers, editors,
confirmation prompts and TUI pickers block the session and hide progress.

- Use `chezmoi --no-pager --use-builtin-diff diff` (or read the source and
  target files directly) and `chezmoi apply <target>`; plain `chezmoi diff` can
  invoke the configured pager or an external diff tool.
- Use `git --no-pager` / `GIT_PAGER=cat`, `PAGER=cat`, `systemctl --no-pager`,
  and `--batch`/`--non-interactive` where available.
- Redirect stdin from `/dev/null` and wrap potentially prompting commands in
  `timeout`.
- Do not poll a blocked job: terminate it, then retry with a non-interactive
  form.
- Prefer the dedicated read/edit/glob/grep tools over shell paging.

This applies to every agent and every project.

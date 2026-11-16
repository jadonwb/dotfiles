# Global agent guidance

## TypeSafe development tests

The user grants standing permission to use the configured TypeSafe/Jev credential
for development experiments and verification with synthetic test data, without a
request-count or cost cap. Proceed under this permission in future sessions;
additional budget/consent questions are unnecessary for this scope. Keep private
user data outside these tests unless the user has authorized its use.

## Dotfiles

Config files under `~` are managed by chezmoi. When changing one, edit the
chezmoi source and `chezmoi apply` that target (or `chezmoi add` a live edit),
so source and live file stay in sync, then commit in the chezmoi repository.

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
- Always default to the dedicated read/write/edit/glob/grep tools over shell
  paging.

## Desktop work

For multi-step desktop work, write one Markdown mission and call desktop MCP
`op=run`; the `desktop` skill describes mission authoring. Primitives serve one
simple action or diagnostics. Tests run headless on an isolated server and need
no announcement. On the live desktop, stop if the user takes over.

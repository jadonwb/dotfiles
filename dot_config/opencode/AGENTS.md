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

## Desktop work

**Anything beyond a single one- or two-step desktop action MUST go through the
desktop MCP `op=goal` tool**, with Jev deciding each step. Use a primitive only
for one simple action or to repair a failed goal.

Before a goal or command that opens, focuses, moves, or closes a window or panel
for a test, announce it:

```bash
opencode-announce "Testing <what>" "<what is about to happen>"
```

The notification waits two seconds so the user can stop interacting; the test
itself may take longer. Reading state or capturing a window needs no
announcement. Details in the `desktop` skill.

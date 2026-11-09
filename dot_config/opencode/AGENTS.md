# Global agent guidance

## Communication

Answer the user's direct question first. When a message contains a question,
feedback, a correction, or information, respond to that point before continuing
with other work.

- If the user offers something you need (an account, a key, a credential, a
  decision, access), say plainly if you need it and how to provide it.
- When the user provides information, say what it changes about the plan. If it
  changes nothing, say that.
- State a blocker in the final answer rather than working around it silently.
- Keep the final answer self-contained: outcome, evidence, what is still needed.

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

## Desktop tests

Before a command that opens, focuses, moves, or closes a window or panel for a
test, run:

```bash
opencode-announce "Testing <what>" "<what is about to happen>"
```

It sends a desktop notification and waits two seconds so you can stop
interacting; the test itself may take longer. Reading window state or capturing
a window needs no announcement. Details in the `desktop` skill.

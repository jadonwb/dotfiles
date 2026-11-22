# Global agent guidance

## Writing and communication style

Write and communicate plainly and state what is true. Define each thing by its
properties and behavior. State the positive claim once, then stop; do not set up
a contrast. That covers "not X but Y", "not just X, it's Y", "no A, no B, just
C", "rather than X", and "instead of X": give the chosen action or property
directly.

Use concrete nouns, numbers, paths, and measured results. Replace significance
inflation ("pivotal", "seamless", "a testament to") with the specific claim. Use
a list when the items are distinct. Begin with the claim; end when the paragraph
is done.

Keep prohibitions that prevent harm or data loss. Rewrite process preferences
and emphasis as positive instructions. This rule covers prompts, skills,
documentation, commit messages, comments, and plans.

## Secrets

Keep secrets out of the session, shell history, agent memory, and tracked
files: API keys, tokens, passwords, recovery codes, and private keys. Do not
print a secret from a file, database, command output, or password manager.
Report only that a secret exists and non-secret metadata such as its label or
length. When a command needs a secret, pipe it directly from its source into
the consumer.

If a secret reaches the session or a shell transcript, say so in the same
reply, name what leaked, and recommend rotating it.

## Dotfiles

Config files under `~` are managed by chezmoi. When changing one, edit the
chezmoi source and `chezmoi apply` that target (or `chezmoi add` a live edit),
so source and live file stay in sync, then commit in the chezmoi repository.
Inform the user when a conflict occurs.

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

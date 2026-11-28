# Side chat panel

Replaces the built-in `opencode.btw` dialog. The built-in plugin is disabled in
`cli.json` with `"-opencode.btw"`.

## Commands

| Command                  | Behavior                                                              |
| ------------------------ | --------------------------------------------------------------------- |
| `/side <question>`       | Starts a temporary side thread, or continues the existing one.        |
| `/side --new <question>` | Deletes the current side session and starts over, clearing the model pin. |
| `/side --close`          | Deletes the side session, clears the thread, and closes the panel.    |
| `/side --model <provider/model#variant>` | Pins the side chat to that model and optional variant.  |
| `/side --model`          | Opens the side chat model picker before asking.                       |
| `session.aside.toggle`   | Open/close. Opening focuses the panel. Default: `alt+l`.              |
| `session.aside.focus`    | Toggle focus on the open panel. Default: `alt+f`.                     |

The side thread is one archived fork of the main session, so it carries the full
conversation up to the first side question: every message, tool result, and file
read, exactly as the main session had it. It keeps the conversation out of the
main session, streams answer text like a normal session, and stays hidden from
the session list. Prompting an archived session unarchives it, so the plugin
re-archives the side session as each prompt is sent. Repeated `/side` calls
prompt the same fork. `/side --new` replaces it; `/side --close` deletes it.

A fork is a snapshot: messages the main session adds after the fork are not in
the side chat, and side questions never appear in the main session.

Each main session has one side chat. A side chat starts unpinned and follows the
main session model. Pinning is per side chat: `/side --model`, `alt+m`, or the
panel's `m` key opens a picker grouped by provider (`opencode-go` first) with a
`Search` row and a `ctrl+d` "Use main model" action. Models that have variants
open a second picker with `Default` first, then each variant. The pinned model
is stored per thread, so a TUI restart keeps it. A new side chat (`--new`, or
`ctrl+enter` in the question dialog) clears the pin and follows the main model
again. `/side --model provider/model#variant` pins directly; a malformed or
unavailable reference is rejected with a toast.

The panel footer is a single bar with key hints on the left and the active side
chat model on the right. The model label appends ` #variant` when a variant is
pinned and the budget percentage once it reaches 70%. The hints and label dim
when the panel is not focused. The `fullscreen` hint appears only when the panel
is fullscreen; the narrower side panel drops it so the model label stays visible.

`session.generate` is used only as a fallback when a side session cannot be
created or prompted, or when its permission update fails. It returns the whole
answer and does not stream.

## No compaction

A side chat never compacts. Compaction would rewrite the forked history and bill
the compaction model, so the plugin refuses anything that would reach it:

- The budget comes from the OpenCode compaction config for the directory
  (`compaction.buffer`) with a 16K minimum buffer, an 8% margin, and a reserve
  capped at 16K output tokens.
- The inherited context is estimated from the last assistant token usage plus
  the messages after it. A question that would cross the compaction point is
  refused with a toast before a session is created or prompted.
- Picking a different model for an existing side chat is refused when the fork
  no longer fits that model, and the previous pin stays active.
- If OpenCode still starts compacting, the plugin interrupts the run, deletes
  the fork, and reports it in the panel. The next question starts a fresh fork.

Because there is no brief fallback, a side chat on a session that is too large
for a smaller model is refused. Use a model with a window that fits, `/compact`
the main session, or start a new session.

## Tools

Side questions answer with read-only lookup tools: `read`, `glob`, `grep`,
`webfetch`, and `websearch`. Everything else is denied: edits and writes, shell
commands, subagents, questions, skills, and external directories. `read` is
denied for `.env` and `.env.*` files; `.env.example` stays readable.

The side session's permissions are replaced with `session.update` before every
prompt, for a new side session and for a reused one. If that update fails, the
side question aborts and the `session.generate` fallback answers instead, so the
side session never prompts with the main agent's default permissions.

## Keybinds

OpenCode's `keybinds` config only accepts built-in command IDs, so these cannot
go under `keybinds`. Override them through the plugin's `options.keys` block
instead, using the same `session.aside.*` IDs. The defaults are shown below.

```json
"plugins": [
  "-opencode.btw",
  {
    "package": "./plugins/side-chat",
    "options": {
      "keys": {
        "session.aside": "alt+a",
        "session.aside.toggle": "alt+l",
        "session.aside.focus": "alt+f",
        "session.aside.model": "alt+m"
      }
    }
  }
]
```

| ID                               | Default       | Action                                      |
| -------------------------------- | ------------- | ------------------------------------------- |
| `session.aside`                  | `alt+a`       | Ask side chat question (opens the popup).   |
| `session.aside.toggle`           | `alt+l`       | Open/close the panel; opening focuses it.   |
| `session.aside.focus`            | `alt+f`       | Toggle focus on the open panel.             |
| `session.aside.model`            | `alt+m`       | Set the side chat model (opens the picker). |
| `session.aside.model.panel`      | `m`           | Set the side chat model from the panel.     |
| `session.aside.resetwidth`       | `alt+0` | Reset the panel width to its default. |
| `session.aside.ask`              | `a`           | Ask another side question.                  |
| `session.aside.hide`             | `escape,q`    | Hide the panel; the thread stays.           |
| `session.aside.close`            | `x`           | Delete the side thread and close the panel. |
| `session.aside.fullscreen`       | `f`           | Toggle fullscreen.                          |
| `session.aside.line.up`          | `alt+k`       | Scroll up one line.                         |
| `session.aside.line.down`        | `alt+j`       | Scroll down one line.                       |
| `session.aside.message.previous` | `alt+shift+k` | Jump to the previous side question.         |
| `session.aside.message.next`     | `alt+shift+j` | Jump to the next side question.             |
| `session.aside.home`             | `g,home`      | Jump to the top.                            |
| `session.aside.end`              | `shift+g,end` | Jump to the bottom.                         |
| `session.aside.dialog.cancel`    | `escape`      | Cancel the question dialog.                 |

`alt+f` toggles focus on the panel so its keys are active; click the prompt to return. `g`/`G` jump to the top and bottom of the side chat, matching the work log. `alt+k` stops at the first row and `alt+j` at the last, so the view cannot be scrolled past either end.

`/side` remains the main-session slash command, and `session.aside` is available
in the command menu. In the main session, `alt+shift+j`/`alt+shift+k` are bound
to `session.message.user.next`/`previous` in `cli.json`.

## Behavior

- The panel opens in the right pane at 108+ terminal columns; narrower terminals
  use the host's fullscreen panel presentation.
- The header is the main session title plus ` - side chat`.
- The header and footer dim when the panel is not focused, matching the main
  prompt/footer focus treatment. The footer is one darker bar: key hints on the
  left and the resolved model label on the right, truncated when the panel is
  narrow.
- Questions use the session's user-message styling: a left border and raised
  surface. Answers use the normal markdown renderer on the base background.
- Answers stream into the panel as text deltas arrive.
- The panel opens already scrolled to the bottom, without a top-to-bottom
  animation. The scroll area stays transparent until that position is applied,
  so the first visible frame is already at the bottom. The footer has one line
  of padding before the last answer row.
- The scrollbar track is transparent; only the thumb is colored, using one
  neutral step lighter than muted (`theme.hue.neutral[700]`).
- `alt+l` opens the panel and focuses it, and closes it whether or not it has focus. `alt+f` toggles focus without closing.
- While the question dialog or the model picker is open, panel keymaps are
  disabled so typing cannot trigger another panel action.
- The question dialog uses the large dialog width (`88` columns) and a
  word-wrapped textarea between 6 and 12 rows, so long questions stay visible
  instead of scrolling off the left edge.
- Its key hints sit on the left of the dialog surface's raised footer bar
  (`theme.surface("dialog").background.raised.high`), with the active model
  label right-aligned in the bottom-right corner. A muted `esc` sits in the
  header's top-right corner.
- In the question dialog, `enter` continues the current side chat and
  `ctrl+enter` submits the text as a new side chat.
- A refusal (context too large, model unavailable) appears as a toast and, for
  an existing side chat, as a warning line in the panel.
- The host gives the right pane to the sidebar or a terminal when either opens.
- The prompt footer shows `/side` while a side question is generating.

## Files

- `tui.tsx` — plugin entrypoint.
- `tsconfig.json` — JSX runtime for OpenTUI's Solid renderer.

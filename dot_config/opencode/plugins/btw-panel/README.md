# /side panel

Replaces the built-in `opencode.btw` dialog. The built-in plugin is disabled in
`cli.json` with `"-opencode.btw"`.

## Commands

| Command                  | Behavior                                                              |
| ------------------------ | --------------------------------------------------------------------- |
| `/side <question>`       | Starts a temporary side thread, or continues the existing one.        |
| `/side --new <question>` | Deletes the current side fork and starts over.                        |
| `/side --close`          | Deletes the side fork, clears the thread, and closes the panel.       |
| `session.aside.toggle`   | Hide/show. Opening focuses the panel. Default: `alt+l`.               |
| `session.aside.focus`    | Switch focus between the prompt and the open panel. Default: `alt+h`. |

The side thread is an archived fork of the main session. The fork keeps the full
conversation context, streams answer text like a normal session, and is hidden
from the session list. Repeated `/side` calls prompt the same fork.
`/side --new` replaces it; `/side --close` deletes it.

`session.generate` is used only as a fallback when a fork cannot be created or
prompted. It returns the whole answer and does not stream.

## Keybinds

OpenCode's `keybinds` config only accepts built-in command IDs, so these cannot
go under `keybinds`. Override them through the plugin's `options.keys` block
instead, using the same `session.aside.*` IDs. The defaults are shown below.

```json
"plugins": [
  "-opencode.btw",
  {
    "package": "./plugins/btw-panel",
    "options": {
      "keys": {
        "session.aside": "alt+a",
        "session.aside.toggle": "alt+l",
        "session.aside.focus": "alt+h"
      }
    }
  }
]
```

| ID                               | Default       | Action                                      |
| -------------------------------- | ------------- | ------------------------------------------- |
| `session.aside`                  | `alt+a`       | Ask side chat question (opens the popup).   |
| `session.aside.toggle`           | `alt+l`       | Hide/show the panel; opening focuses it.    |
| `session.aside.focus`            | `alt+h`       | Switch focus between prompt and panel.      |
| `session.aside.ask`              | `a`           | Ask another side question.                  |
| `session.aside.hide`             | `escape,q`    | Hide the panel; the thread stays.           |
| `session.aside.close`            | `x`           | Delete the side thread and close the panel. |
| `session.aside.fullscreen`       | `f`           | Toggle fullscreen.                          |
| `session.aside.line.up`          | `alt+k`       | Scroll up one line.                         |
| `session.aside.line.down`        | `alt+j`       | Scroll down one line.                       |
| `session.aside.message.previous` | `alt+shift+k` | Jump to the previous side question.         |
| `session.aside.message.next`     | `alt+shift+j` | Jump to the next side question.             |
| `session.aside.home`             | `home`        | Jump to the top.                            |
| `session.aside.end`              | `end`         | Jump to the bottom.                         |
| `session.aside.dialog.cancel`    | `escape`      | Cancel the question dialog.                 |

`/side` remains the main-session slash command, and `session.aside` is available
in the command menu. In the main session, `alt+shift+j`/`alt+shift+k` are bound
to `session.message.user.next`/`previous` in `cli.json`.

## Behavior

- The panel opens in the right pane at 108+ terminal columns; narrower terminals
  use the host's fullscreen panel presentation.
- The header is the main session title plus ` - side chat`.
- The header and footer dim when the panel is not focused, matching the main
  prompt/footer focus treatment.
- Questions use the session's user-message styling: a left border and raised
  surface. Answers use the normal markdown renderer on the base background.
- Answers stream into the panel as text deltas arrive.
- The panel opens scrolled to the bottom. The footer has one line of padding
  before the last answer row.
- The scrollbar track is transparent; only the thumb is colored, using one
  neutral step lighter than muted (`theme.hue.neutral[700]`).
- `alt+l` opens the panel and focuses it; closing returns focus to the session.
- While the `a` question dialog is open, panel keymaps are disabled so typing
  inside the dialog cannot trigger another panel action.
- The question dialog is extra-wide and uses a word-wrapped textarea between 2
  and 6 rows, so long questions stay visible instead of scrolling off the left
  edge.
- Its key hints sit centered in a darker footer bar, with keys in the base text
  color and labels muted. A dim `esc` sits in the header's top-right corner.
- In the question dialog, `enter` continues the current side chat and
  `ctrl+enter` submits the text as a new side chat.
- The host gives the right pane to the sidebar or a terminal when either opens.
- The prompt footer shows `/side` while a side question is generating.

## Files

- `tui.tsx` — plugin entrypoint.
- `tsconfig.json` — JSX runtime for OpenTUI's Solid renderer.

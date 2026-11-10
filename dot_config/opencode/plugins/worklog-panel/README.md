# Work log panel

A side panel that shows the session as one continuous log of tool work, styled
like the native transcript. It shares the right pane with the btw side chat:
opening one replaces the other, and each panel's keys only act while it has
focus.

## Keys

| Key | Action |
| --- | --- |
| `alt+w` | Open the work log, re-focus it, or close it when focused |
| `/worklog` (alias `/wl`) | Same toggle from the prompt |
| `j`/`k`, arrows | Move the selection |
| `enter` | Open or close the selected item's detail |
| `pageup`/`pagedown`, `ctrl+u`/`ctrl+d` | Move by a page |
| `g`/`home`, `shift+g`/`end` | Jump to the first or last item |
| `[` / `]` | Jump to the previous or next user-message batch |
| `t` | Cycle All / Commands / Files / Reads / Other |
| `f` | Toggle fullscreen |
| `esc` / `q` | Hide the panel |

Rows are also clickable: click selects and toggles the item.

## Behavior

- The panel renders every loaded turn in one scrollbox. A subtle divider marks
  each user-message boundary with the batch time and counts. User message text is
  not rendered.
- The panel opens on the latest work and extends the loaded history until it can
  show a batch split. `[` at the oldest loaded batch loads older history.
- Thinking blocks and normal assistant text are excluded. The transcript
  remains the place to read the answer.
- One detail is open at a time, inline under its row, mirroring the native
  blocks: shell command and output, edit diff, write code, read loaded files,
  generic input/output, and nested `execute` calls.
- Output is capped at 300 lines and write content at 200 lines; the tail is
  marked with a `… N more lines` note.
- Subagent rows currently render as `Subagent called` and `enter` does nothing.
  The in-place child work log is the next planned pass.
- Background shell output is not polled yet. A still-running background shell
  gets a `Background` badge and shows the output captured in the tool part.

## Notes

- The panel is discovered from the global plugins directory; no `cli.json`
  entry is required.
- The host keeps one panel per session. With the btw panel open, `alt+w` swaps
  to this panel; `alt+l` swaps back.

# Work log panel

A side panel that shows the session as one continuous log of tool work, styled
like the native transcript. It shares the right pane with the side chat:
opening one replaces the other, and each panel's keys only act while it has
focus.

## Keys

| Key | Action |
| --- | --- |
| `alt+w` | Open the work log, re-focus it, or close it when focused |
| `/worklog` (alias `/wl`) | Same toggle from the prompt |
| `j`/`k`, arrows | Move the selection |
| `alt+j`/`alt+k` | Scroll the view without moving the selection or closing detail |
| `enter` | Open or close the selected item's detail |
| `pageup`/`pagedown`, `ctrl+u`/`ctrl+d` | Move by a page |
| `g`/`home`, `shift+g`/`end` | Jump to the first or last item |
| `[` / `]` | Jump to the previous or next work batch |
| `t` | Cycle All / Commands / Files / Reads / Thoughts / Other |
| `f` | Toggle fullscreen |
| `esc` / `q` | Hide the panel |

Rows are also clickable: click selects and toggles the item. The list keeps its
scroll position when new work arrives during an active turn, and two lines of
space sit between the last row and the footer.

## Behavior

- The panel renders every loaded turn in one scrollbox. A subtle divider marks
  each user-message boundary (Batch) and each assistant text boundary (Assistant)
  with the time and counts. Message text is not rendered.
- The panel opens already at the latest work, without an initial top-to-bottom
  scroll. It extends the loaded history until it can show a batch split; `[` at
  the oldest loaded batch loads older history.
- Thought rows appear in place, initially as non-expandable stubs. A running
  thought shows Thinking… with a spinner; a finished one shows Thought · duration.
  Normal assistant text is not rendered; it breaks the batch like the main
  transcript.
- One detail is open at a time, inline under its row, mirroring the native
  blocks: shell command and output, edit diff, write code, read loaded files, and
  generic input/output. Execute detail shows labeled Code and Output sections
  with TypeScript/JSON syntax highlighting, matching the native execute dialog
  without opening a popup. Nested execute calls remain rows in the list.
- Output is capped at 300 lines and write content at 200 lines; the tail is
  marked with a `… N more lines` note.
- Subagent rows currently render as `Subagent called`; thought and subagent rows
  are intentionally non-expandable for now. The in-place child work log is the
  next planned pass.
- Background shell output is not polled yet. A still-running background shell
  gets a `Background` badge and shows the output captured in the tool part.

## Notes

- The panel is discovered from the global plugins directory; no `cli.json`
  entry is required.
- The host keeps one panel per session. With the side chat panel open, `alt+w`
  swaps to this panel; `alt+l` swaps back.

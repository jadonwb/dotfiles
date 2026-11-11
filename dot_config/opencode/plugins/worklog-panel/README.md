# Work log panel

A side panel that shows the session as one continuous log of tool work, styled
like the native transcript. It shares the right pane with the side chat:
opening one replaces the other, and each panel's keys only act while it has
focus.

## Keys

| Key | Action |
| --- | --- |
| `alt+w` | Open or close the work log |
| `alt+f` | Toggle focus on the work log panel |
| `alt+0` | Reset the panel width to its default |
| `/worklog` (alias `/wl`) | Same toggle from the prompt |
| `j`/`k`, arrows | Move the selection |
| `alt+j`/`alt+k` | Scroll the view without moving the selection or closing detail |
| `enter` | Open or close the selected item's detail |
| `pageup`/`pagedown`, `ctrl+u`/`ctrl+d` | Move by a page |
| `g`/`home`, `shift+g`/`end` | Jump to the first or last item |
| `[` / `]` | Jump to the previous or next work batch |
| `t` | Open the tool filter popup |
| `f` | Toggle fullscreen |
| `esc` / `q` | Hide the panel, or go back one level from a child work log |
| `backspace` | Go back to the parent work log |

Rows are also clickable: click selects and toggles the item. Clicking a long
shell block expands or collapses it. The list keeps its scroll position when new
work arrives during an active turn, and two lines of space sit between the last
row and the footer. `alt+k` stops at the first visible row and `alt+j` at the
last, so neither end can be scrolled past.

## Behavior

- The panel renders every loaded turn in one scrollbox. A subtle divider marks
  each user-message boundary (Batch) and each assistant text boundary (Assistant)
  with the time and counts. Message text is not rendered.
- The panel opens already at the latest work. The scroll area stays transparent
  until the initial bottom position is applied, so there is no visible
  top-to-bottom flash. It extends the loaded history until it can show a batch
  split; `[` at the oldest loaded batch loads older history.
- `t` opens a checkbox popup for the tool groups: Commands, Edits / writes,
  Explored, Subagents, Thoughts, Execute, and Other. Reads, searches, and fetches
  share the Explored group because they render as one Explored row; subagent
  calls have their own category. `j`/`k` and `space` toggle a row; `a` shows all,
  `n` hides all, and `esc` closes. The selection is stored per session, so hidden
  groups stay hidden after reopening the panel. Saved selections are left alone:
  a session that predates the Subagents group keeps it hidden until it is toggled
  on.
- Thought rows appear in place, initially as non-expandable stubs. A running
  thought shows Thinking… with a spinner; a finished one shows Thought · duration.
  Normal assistant text is not rendered; it breaks the batch like the main
  transcript.
- Consecutive reads, searches, and fetches collapse into one `Explored:` row,
  matching the main transcript. `enter` or a click expands it into single-line
  child rows; the group itself has no detail block.
- `enter` or a click on a subagent row opens that child session as a nested
  work log with the same rows, detail, filter, and scrolling. The stats line
  shows `‹ back`, and `esc`, `q`, or `backspace` returns to the parent. The
  parent's selection, open detail, and scroll position are restored. Nested
  subagents stack, so back walks up one level at a time.
- One detail is open at a time, inline under its row, mirroring the native
  blocks: shell command and output, edit diff, write code, and generic
  input/output. Execute detail shows labeled Code and Output sections with
  TypeScript/JSON syntax highlighting, matching the native execute dialog
  without opening a popup. Nested execute calls remain rows in the list. Moving
  the selection with `j`/`k` leaves the open detail in place; it closes only
  when toggled on the same row or replaced by expanding another row. Expanding
  keeps that row visible: if the expanded block would extend past the view, the
  row moves to the top (clamped by the end of the content). `alt+j`/`alt+k`
  still scroll freely without moving the selection.
- Long shell output opens collapsed in the native style: the first two command
  lines and up to ten output lines, with a `(N earlier lines)` note. Clicking the
  block or pressing `space` on the selected shell row expands it to the full
  output.
- Output is capped at 300 lines and write content at 200 lines; the tail is
  marked with a `… N more lines` note.
- Subagent rows match the main transcript (`<Agent> Subagent — description`, with
  the native `✓`/`↳`/`│` icon) and navigate into the child session. Batch
  counts keep subagents in the generic tool count, as the main session does;
  the Subagents filter only controls their visibility. Thought and skill rows
  are intentionally non-expandable; skill content is static, so there is no
  detail to show.
- Background shell output is not polled yet. A still-running background shell
  gets a `Background` badge and shows the output captured in the tool part.

## Notes

- The panel is discovered from the global plugins directory; no `cli.json`
  entry is required.
- The host keeps one panel per session. With the side chat panel open, `alt+w`
  swaps to this panel; `alt+l` swaps back.
- `alt+w` closes the panel whether or not it has focus. `alt+f` toggles focus
  without closing, matching the side chat.

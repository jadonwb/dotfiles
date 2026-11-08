# Minimized

A bar icon and a keyboard-driven list of every window parked on Omarchy's
`special:minimized` workspace, with the workspace, floating state, size, and
position each window needs to come back the way it left.

Hyprland has no minimize. Omarchy hides a window by moving it to
`special:minimized`; the stock dock shows those windows only on floating
workspaces and always restores them to the workspace in front of you. This
plugin works from any workspace and restores each window where it came from.

## Keybindings

| Key | Action |
|---|---|
| `SUPER + ALT + M` | Minimize the focused window (replaces the stock "minimize to the dock") |
| `SUPER + M` | Open the minimized list |
| `j` / `k`, `↓` / `↑` | Move the cursor |
| `Ctrl + d` / `Ctrl + u` | Move five rows |
| `gg` / `G` | First / last row |
| `Enter` | Restore to its original workspace and focus it |
| `t` | Bring it to the current workspace instead |
| `x` or `Delete` | Ask the app to close; if it stops to ask, it comes back with the dialog |
| `r` | Refresh the list |
| `Esc` | Close the panel |

Clicking a row restores it; right-clicking closes it. Middle-clicking the bar
icon refreshes the list.

## What each row shows

A thumbnail of the window, captured with `grim -T` when it is minimized and
refreshed when the panel opens. The app name replaces the Hyprland class: GUI
apps use their desktop entry name, Omarchy TUIs use their own (`Omarchy Update`,
`btop`, `Omarchy Agent`), and a terminal shows what is running in its focused
pane (`nvim`, `opencode`, `omarchy-update`). Wezterm is read through
`wezterm cli`; other terminals use the pty's foreground process. A plain shell
falls back to the terminal's name. The second line is origin workspace, floating
or tiled, and how long ago it was tucked away.

## What is remembered

Minimizing snapshots the window before moving it:

- origin workspace (also written to an `omarchy-minimized-from-<workspace>` tag)
- monitor
- floating vs tiled
- floating position and size
- pinned and fullscreen state

Restoring moves the window back, then puts back the floating geometry only when
Hyprland lost it and only on the same monitor, so a window never lands off
screen after a monitor change. Tiled windows re-enter their workspace's layout;
the exact tile slot is the layout's to decide.

The snapshot lives in `~/.local/state/omarchy/minimized/state.json` and is
pruned whenever a window leaves the minimized workspace, however it left.
Thumbnails live in `~/.cache/omarchy/minimized/` and are pruned the same way.

`x` is a close request, not a kill. If the app answers with a save-changes
dialog, the window comes back to its workspace, focused, and a notification
says why it returned, so the question is never left on the hidden workspace.
The panel never force-closes; that stays an explicit manual action.

## Settings

`alwaysShow` (default `true`) keeps the bar icon visible when nothing is
minimized. Set it to `false` in the bar entry to have the icon appear only while
a window is tucked away:

```json
{ "id": "jadon.minimized", "alwaysShow": false }
```

## Layout

```
manifest.json           bar widget contract
Panel.qml               bar icon + KeyboardPanel list
Minimized.js            pure list/state helpers
bin/omarchy-minimized   minimize, restore, prune, list
i18n/en.json            strings
```

## Limitations

- A window in a Hyprland group is moved out of its group when minimized; group
  membership is not restored.
- Windows minimized by the stock command before this plugin existed have no
  snapshot, so they restore by their origin tag and come back tiled at the
  layout's choice.

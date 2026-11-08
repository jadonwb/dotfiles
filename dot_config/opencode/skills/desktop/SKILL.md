---
name: Desktop
description: Control the live Omarchy desktop from the agent without taking the user's focus — discover Hyprland windows, launch test windows in the background, send bounded keyboard input to an unfocused window, capture it directly, verify, and clean up. Use for testing a running UI, taking a screenshot, typing into an app, or reproducing a desktop bug. Triggers: screenshot, capture window, focus window, type into app, UI test, live test, Hyprland, desktop automation.
---

# Desktop

The desktop is shared. Work in the background by default: Hyprland can launch a
window without focusing it, deliver keys to an unfocused window, and capture that
window directly. Do not take the keyboard or the screen from the user unless the
app requires real focus.

Available: `hyprctl`, `grim`, `slurp`, `wtype`, `wl-copy`, `wl-paste`, `jq`,
`nvim`. There is no pointer-injection tool (`ydotool`, `dotool`, and `wlrctl`
are not installed), so input is keyboard-only.

Hyprland 0.57 dispatchers are Lua expressions. Run them through `hyprctl
dispatch '<expression>'`; the older `dispatcher arg,arg` form is unreliable once
an argument contains `,` or `:`.

## Announce before taking the desktop

Before any command that opens, focuses, moves, or closes a window for a test,
run:

```bash
opencode-announce "Testing the minimized panel" "The panel will open briefly."
```

It sends a normal OpenCode notification and waits two seconds. Those two seconds
are a buffer for the user to stop typing or interacting; the test itself may
take longer. Say what is about to happen, not how long the test will last. A
third argument changes the buffer.

Reading window state, checking `hyprctl` output, and capturing a window need no
announcement. Announce the first action that changes what the user sees.

If the helper is unavailable, the raw form is:

```bash
notify-send --app-name "OpenCode" "Testing the minimized panel" "The panel will open briefly." 2>/dev/null || true
sleep 2
```

## Find the window

```bash
hyprctl -j clients | jq -r '.[] | [.address, .stableId, .class, .title, (.at|join(",")), (.size|join("x")), .workspace.name] | @tsv'
hyprctl -j activewindow | jq -r '[.address, .class, .title] | @tsv'
hyprctl -j monitors | jq -r '.[] | [.name, .x, .y, .width, .height, .scale] | @tsv'
```

- `class` is the app identity and is stable; `title` changes with the document.
- `address` (e.g. `0x55668531cd30`) targets a window for focus, input, and close.
- `stableId` (e.g. `1800001e`) targets a window for capture.
- `workspace.name` starting with `special:` means the window is on a hidden
  workspace. It still receives input and can be captured.
- Save the current `activewindow` address before any work so you can confirm it
  still matches at the end.

## Launch a test window in the background

```bash
cat > /tmp/opencode/probe.sh <<'EOF'
#!/bin/sh
while IFS= read -r line; do printf '%s\n' "$line" >> /tmp/opencode/probe.txt; done
EOF
chmod +x /tmp/opencode/probe.sh

hyprctl dispatch 'hl.dsp.exec_cmd("wezterm start --always-new-process --class agent-probe -- /tmp/opencode/probe.sh", { workspace = "special:agent-probe silent", no_initial_focus = true })'
```

- `no_initial_focus` plus a `silent` workspace keeps the window off the user's
  screen and out of the focus chain.
- Verify immediately: `activewindow` must still be the previous address, and the
  new window's `workspace.name` must be the special workspace.
- Rules are applied by the spawned PID. Apps that delegate to an existing
  instance (wezterm without `--always-new-process`, many browsers) ignore them.
  If the window opened on the current workspace, move it without following:

```bash
hyprctl dispatch "hl.dsp.window.move({ workspace = \"special:agent-probe\", window = \"address:0x...\", follow = false })"
```

- `window.move` focuses the window unless `follow = false`.
- Never use `focuswindow` for setup; it switches the user's workspace or monitor.

## Send keys to an unfocused window

```bash
addr=0x55668531cd30

hyprctl dispatch "hl.dsp.send_shortcut({ mods = \"\", key = \"a\", window = \"address:$addr\" })"
hyprctl dispatch "hl.dsp.send_shortcut({ mods = \"SHIFT\", key = \"a\", window = \"address:$addr\" })"
hyprctl dispatch "hl.dsp.send_shortcut({ mods = \"CTRL\", key = \"s\", window = \"address:$addr\" })"
hyprctl dispatch "hl.dsp.send_shortcut({ mods = \"\", key = \"Return\", window = \"address:$addr\" })"
```

- One key per call. Key names are libxkbcommon names: `a`, `space`, `Return`,
  `Tab`, `Escape`, `BackSpace`, `Left`, `F5`.
- `mods` is a string: `"SHIFT"`, `"CTRL"`, `"ALT"`, `"SUPER"`; combine with a
  space (`"CTRL SHIFT"`).
- Hyprland briefly routes the key to that surface and restores the previous
  focus. `activewindow` is unchanged before and after.
- `window not found` means the address is stale; re-read `clients` and retry.
  The exit status can still be 0, so check the warning text.
- For a held key, use `send_key_state` with `state = "down"` and then `"up"`.
- Do not send while the user is actively typing: the routing is momentary but
  real, and a keystroke can land in the test window.
- Text: one key per character is slow and error-prone for punctuation. Use the
  app's own channel for anything beyond a short sequence — Neovim RPC, `tmux
  send-keys`, the `browse` MCP server for browsers, or a CLI.

## Capture without focus

```bash
addr=0x55668531cd30
sid=$(hyprctl -j clients | jq -r --arg a "$addr" '.[]|select(.address==$a)|.stableId')
grim -T "$sid" /tmp/opencode/window.png
```

- `-T` takes the `stableId`.
- Works while the window is unfocused, occluded, on another workspace, or on a
  hidden special workspace.
- The image is the window's current size times the output scale (a 1254×658
  window at scale 1.5 gives 1881×987). Do not rescale the geometry.
- Read the PNG with the `read` tool.
- Fall back to `grim -g "x,y wxh"` only when `-T` is unavailable; that captures
  whatever is composited in the region, so occluding windows appear.

## Verify

Prove the result with the cheapest evidence that fits:

- the app's own state: Neovim RPC, a file the app writes, its CLI or API
- a second `grim -T` screenshot read with the `read` tool
- `hyprctl -j activewindow` unchanged, and `clients` still listing the window

A dispatched key returning `ok` is not proof that the app received it.

## Clean up

```bash
hyprctl dispatch "hl.dsp.window.close({ window = \"address:0x55668531cd30\" })"
hyprctl -j clients | jq -e --arg a "$addr" 'all(.[]; .address != $a)'
```

- Quit through the app when possible (`:qa!` over RPC, the app's own quit) so it
  can prompt about unsaved work.
- Close every window you launched. Hidden special-workspace windows are easy to
  forget; close them even when the workspace is not visible.
- If the window will not close, ask before `window.kill` or `kill`.
- Remove temporary sockets and screenshots.

## Focused mode (only when needed)

Some apps require real keyboard focus: IME text, pointer grabs, or a test of
focus behavior itself. Then focus, type with `wtype`, and restore:

```bash
prev=$(hyprctl -j activewindow | jq -r .address)
hyprctl dispatch "hl.dsp.focus({ window = \"address:0x...\" })"
sleep 0.5
hyprctl -j activewindow | jq -r .address     # must match the target

wtype -d 25 'text'
wtype -M ctrl -k a -m ctrl

hyprctl dispatch "hl.dsp.focus({ window = \"address:$prev\" })"
```

- `wtype` sends to the focused surface only. Never type without confirming
  `activewindow`.
- `-d` sets the delay between keys, `-s` sleeps before the next option, `-M`/`-m`
  press and release a modifier, `-P`/`-p` press and release a key.
- Do not type secrets, credentials, or payment details. Do not automate
  password prompts, 2FA, captchas, or destructive confirmations; hand off to the
  user.

## Live Neovim test

Use this only when the UI itself is under test: rendering, highlights, layout,
statusline, or a keymap that needs a real terminal. For behavior, a headless
test (`nvim --headless -u NONE -l tests/...`) is cheaper and more reliable.

```bash
sock=/tmp/opencode/nvim.sock
rm -f "$sock"
hyprctl dispatch 'hl.dsp.exec_cmd("wezterm start --always-new-process --class nvim-live -- nvim --listen /tmp/opencode/nvim.sock /tmp/opencode/live.txt", { workspace = "special:agent-test silent", no_initial_focus = true })'

for i in $(seq 1 30); do [ -S "$sock" ] && break; sleep 0.2; done
addr=$(hyprctl -j clients | jq -r '.[]|select(.class=="nvim-live")|.address' | head -1)

nvim --server "$sock" --remote-send 'ihello<Esc>'
nvim --server "$sock" --remote-expr 'getline(1)'

sid=$(hyprctl -j clients | jq -r --arg a "$addr" '.[]|select(.address==$a)|.stableId')
grim -T "$sid" /tmp/opencode/nvim-live.png

nvim --server "$sock" --remote-send ':qa!<CR>'
rm -f "$sock"
```

- RPC sends input without focus and is exact; use it for text.
- `--remote-send` keys are Neovim key notation; `<Esc>` leaves insert mode and
  `<C-\><C-n>` leaves terminal mode.
- Launch without `-u NONE` when the test must load the user's real config.

## Limits

- No pointer injection: no clicks. Use keyboard navigation, the app's API, or
  the `browse` MCP server for browser UIs; say what could not be tested.
- One test window at a time, on its own special workspace.
- Do not fight the user for focus; if they take over, stop.
- Do not drive login, payment, or captcha flows.

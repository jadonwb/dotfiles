local home = os.getenv("HOME") or ""
local hypr_scripts = home .. "/.config/hypr/scripts"
local machine = require("hypr.host")

local function bind(keys, dispatcher, description)
  hl.bind(keys, dispatcher, { description = description })
end

hl.unbind("SUPER + K")
hl.unbind("SUPER + J")
hl.unbind("SUPER + L")
hl.unbind("SUPER + F")
hl.unbind("SUPER + CTRL + T")
hl.unbind("SUPER + SPACE")
hl.unbind("SUPER + ALT + SPACE")
hl.unbind("SUPER + T")
hl.unbind("SUPER + O")
hl.unbind("SUPER + S")
hl.unbind("SUPER + ALT + S")

bind("SUPER + SPACE", hl.dsp.exec_cmd("omarchy-menu"), "Omarchy menu")
bind("SUPER + ALT + SPACE", hl.dsp.exec_cmd("omarchy-launch-walker"), "Launch apps")

bind("SUPER + SHIFT + O", hl.dsp.exec_cmd("omarchy-hyprland-window-pop"), "Pop window out (float & pin)")
bind("SUPER + O", hl.dsp.window.float({ action = "toggle" }), "Toggle window floating/tiling")

bind("SUPER + H", hl.dsp.focus({ direction = "l" }), "Move window focus left")
bind("SUPER + L", hl.dsp.focus({ direction = "r" }), "Move window focus right")
bind("SUPER + K", hl.dsp.focus({ direction = "u" }), "Move window focus up")
bind("SUPER + J", hl.dsp.focus({ direction = "d" }), "Move window focus down")

bind("SUPER + SHIFT + F", hl.dsp.window.fullscreen({ mode = "fullscreen", action = "toggle" }), "Fullscreen")
bind("SUPER + SHIFT + J", hl.dsp.layout("togglesplit"), "Toggle window split")
bind("SUPER + SHIFT + K", hl.dsp.exec_cmd("omarchy-menu-keybindings"), "Show key bindings")
bind("SUPER + SHIFT + L", hl.dsp.exec_cmd("omarchy-hyprland-workspace-layout-toggle"), "Toggle workspace layout")

bind("SUPER + SHIFT + P", hl.dsp.layout("promote"), "Promote (scrolling)")
bind("SUPER + CTRL + LEFT", hl.dsp.layout("swapcol l"), "Swap column left (scrolling)")
bind("SUPER + CTRL + RIGHT", hl.dsp.layout("swapcol r"), "Swap column right (scrolling)")

bind(
  "SUPER + RETURN",
  hl.dsp.exec_cmd([[uwsm-app -- xdg-terminal-exec --dir="$(omarchy-cmd-terminal-cwd)"]]),
  "Terminal"
)
bind(
  "SUPER + ALT + RETURN",
  hl.dsp.exec_cmd(
    [[uwsm-app -- xdg-terminal-exec --dir="$(omarchy-cmd-terminal-cwd)" zsh -c "tmux attach || tmux new -s Work"]]
  ),
  "Tmux"
)
bind("SUPER + B", hl.dsp.exec_cmd("omarchy-launch-browser"), "Browser")
bind("SUPER + ALT + B", hl.dsp.exec_cmd("omarchy-launch-browser --private"), "Browser (private)")

bind("SUPER + U", hl.dsp.workspace.toggle_special("keyboard"), "Toggle special workspace keyboard")
bind("SUPER + Y", hl.dsp.workspace.toggle_special("youtube"), "Toggle special workspace youtube")
bind("SUPER + T", hl.dsp.workspace.toggle_special("activity"), "Toggle special workspace activity")
bind("SUPER + M", hl.dsp.workspace.toggle_special("media"), "Toggle special workspace media")
bind("SUPER + E", hl.dsp.workspace.toggle_special("yazi"), "Toggle special workspace yazi")
bind("SUPER + S", hl.dsp.workspace.toggle_special("scratch"), "Toggle special workspace scratch")
bind("SUPER + ALT + S", hl.dsp.window.move({ workspace = "special:scratch", follow = false }), "Move window to scratch")

if machine.is_personal then
  bind("SUPER + PERIOD", hl.dsp.exec_cmd("uwsm-app -- 1password"), "Passwords")
end

bind("SUPER + SHIFT + G", hl.dsp.exec_cmd(hypr_scripts .. "/gamemode.sh"), "Gamemode")
bind("SUPER + Z", hl.dsp.send_shortcut({ mods = "CTRL", key = "Z" }), "Ctrl Z")
bind("SUPER + SHIFT + W", hl.dsp.exec_cmd([[notify-send 'click window to kill' && hyprctl kill]]), "Kill")

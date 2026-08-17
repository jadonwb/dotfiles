local floats = require("hypr.floats-toggle")
local machine = require("hypr.host")

local function bind(keys, dispatcher, description)
  hl.bind(keys, dispatcher, { description = description })
end

-- hl.unbind("SUPER + CTRL + T")
hl.unbind("SUPER + SPACE")
hl.unbind("SUPER + ALT + SPACE")
-- hl.unbind("SUPER + SHIFT + G")
-- hl.unbind("ALT + TAB")

bind("SUPER + SPACE", hl.dsp.exec_cmd("omarchy-menu"), "Omarchy menu")
bind("SUPER + ALT + SPACE", hl.dsp.exec_cmd("omarchy-launch-walker"), "Launch apps")

bind(
  "SUPER + RETURN",
  hl.dsp.exec_cmd([[uwsm-app -- xdg-terminal-exec --dir="$(omarchy-cmd-terminal-cwd)"]]),
  "Terminal"
)
bind("SUPER + B", hl.dsp.exec_cmd("omarchy-launch-browser"), "Browser")
bind("SUPER + A", hl.dsp.workspace.toggle_special("activity"), "Toggle special workspace activity")
bind("SUPER + E", hl.dsp.workspace.toggle_special("yazi"), "Toggle special workspace yazi")
-- bind("SUPER + SHIFT + G", floats.toggle, "Toggle float drawer (hide/show floats)")

if machine.is_personal then
  bind("SUPER + PERIOD", hl.dsp.exec_cmd("uwsm-app -- 1password"), "Passwords")
end

bind("SUPER + SHIFT + W", hl.dsp.exec_cmd([[notify-send 'click window to kill' && hyprctl kill]]), "Kill")

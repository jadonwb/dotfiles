local float_tui = require("hypr.float-tui")
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
bind("SUPER + ALT + RETURN", hl.dsp.exec_cmd("uwsm-app -- wezterm-launcher"), "Session launcher")
bind("SUPER + B", hl.dsp.exec_cmd("omarchy-launch-browser"), "Browser")
-- TODO: simplify, omarchy-launch-tui auto names them org.omarchy.*, so just provide a single name and the internals will make special:* and use org.omarchy.*
bind(
  "SUPER + E",
  float_tui.new({ class = "org.omarchy.yazi", special = "special:yazi", launch = "omarchy-launch-tui yazi" }),
  "Toggle yazi"
)
bind(
  "SUPER + A",
  float_tui.new({ class = "org.omarchy.btop", special = "special:btop", launch = "omarchy-launch-tui btop" }),
  "Toggle btop"
)
-- bind("SUPER + SHIFT + G", floats.toggle, "Toggle float drawer (hide/show floats)")

if machine.is_personal then
  bind("SUPER + PERIOD", hl.dsp.exec_cmd("uwsm-app -- 1password"), "Passwords")
end

bind("SUPER + SHIFT + W", hl.dsp.exec_cmd([[notify-send 'click window to kill' && hyprctl kill]]), "Kill")

bind("SUPER + CTRL + SHIFT + COMMA", hl.dsp.exec_cmd("makoctl reload"), "Reload notification daemon")

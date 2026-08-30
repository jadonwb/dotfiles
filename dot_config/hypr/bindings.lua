-- Add a new binding.
-- o.bind("SUPER + SHIFT + R", "SSH", "alacritty -e ssh your-server")

-- Change an existing binding by unbinding it first, then binding the key again.
-- This example changes SUPER+SPACE from the launcher to the Omarchy root menu.
-- hl.unbind("SUPER + SPACE")
-- o.bind("SUPER + SPACE", "Omarchy menu", "omarchy-menu toggle root")

-- Disable a default binding without replacing it.
-- hl.unbind("SUPER + SHIFT + B")

-- Logitech MX Keys examples:
-- o.bind("SUPER + SHIFT + S", nil, "omarchy-capture-screenshot")
-- o.bind("SUPER + H", nil, "voxtype record toggle")
-- o.bind("SUPER + PERIOD", nil, "omarchy-shell shell toggle omarchy.emojis")

hl.unbind("SUPER + CTRL + T")
hl.unbind("SUPER + ALT + RETURN")
hl.unbind("SUPER + RETURN")

local float_tui = require("hypr.float-tui")
local machine = require("hypr.host")

o.bind("SUPER + RETURN", "Terminal", "wezterm --config enable_tab_bar=false start --always-new-process")
o.bind("SUPER + ALT + RETURN", "Persistent Terminal", "wezterm start --always-new-process --domain $(hostname)")

-- FIXME!: spawns a blank window, which then intercepts the kill
-- hl.bind("SUPER + SHIFT + W", hl.dsp.exec_cmd([[notify-send 'click window to kill' && hyprctl kill]]))

if machine.is_personal then
  o.bind("SUPER + PERIOD", "Passwords", "1password")
end

-- TODO: simplify, omarchy-launch-tui auto names them org.omarchy.*, so just provide a single name and the internals will make special:* and use org.omarchy.*
o.bind(
  "SUPER + E",
  "Toggle yazi",
  float_tui.new({ class = "org.omarchy.yazi", special = "special:yazi", launch = "omarchy-launch-tui yazi" })
)

o.bind(
  "SUPER + CTRL + T",
  "Toggle btop",
  float_tui.new({ class = "org.omarchy.btop", special = "special:btop", launch = "omarchy-launch-tui btop" })
)

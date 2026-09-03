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

local machine = require("hypr.host")
local window_toggle = require("hypr.window-toggle")

o.bind("SUPER + RETURN", "Terminal", { launch = "wezterm --config enable_tab_bar=false start --always-new-process" })
o.bind("SUPER + ALT + RETURN", "Persistent Terminal", function()
  local command = "wezterm start --always-new-process --domain $(hostname)"

  if not o.shell_succeeds([[pgrep -u "$(id -u)" -f '(^|/)wezterm-mux-server( |$)']]) then
    command = command .. " --attach"
  end

  hl.exec_cmd(o.launch(command))
end)

-- FIXME!: spawns a blank window, which then intercepts the kill
-- hl.bind("SUPER + SHIFT + W", hl.dsp.exec_cmd([[notify-send 'click window to kill' && hyprctl kill]]))

if machine.is_personal then
  o.bind("SUPER + PERIOD", "Passwords", "1password")
end

o.bind("SUPER + E", "Toggle yazi", window_toggle.tui("yazi"))

o.bind("SUPER + CTRL + T", "Toggle btop", window_toggle.tui("btop"))

o.bind(
  "SUPER + Q",
  "Toggle calculator",
  window_toggle.new({
    class = "org.gnome.Calculator",
    special = "special:calculator",
    launch = "gnome-calculator",
  })
)

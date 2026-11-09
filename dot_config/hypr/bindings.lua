-- Add a new binding.
-- o.bind("SUPER + SHIFT + R", "SSH", "alacritty -e ssh your-server")

-- Replace an existing binding with o.rebind, which unbinds the old one first.
-- This example changes SUPER+SPACE from the launcher to the Omarchy root menu.
-- o.rebind("SUPER + SPACE", "Omarchy menu", "omarchy-menu toggle root")

-- Disable a default binding without replacing it.
-- hl.unbind("SUPER + SHIFT + B")

-- Logitech MX Keys examples:
-- o.bind("SUPER + SHIFT + S", nil, "omarchy-capture-screenshot")
-- o.bind("SUPER + H", nil, "voxtype record toggle")
-- o.bind("SUPER + PERIOD", nil, "omarchy-shell shell toggle omarchy.emojis")

local machine = require("hypr.host")
local window_toggle = require("hypr.window-toggle")

-- Tuck the focused window away from any workspace, and open the list of what
-- is hidden. The helper records workspace, floating state, and geometry.
local minimized = (os.getenv("HOME") or "") .. "/.config/omarchy/plugins/jadon.minimized/bin/omarchy-minimized"

o.rebind("SUPER + M", "Minimized windows", { panel = "jadon.minimized" })
o.rebind("SUPER + ALT + M", "Minimize window", minimized .. " minimize")

o.rebind("SUPER + RETURN", "Terminal", { launch = "wezterm --config enable_tab_bar=false start --always-new-process" })
o.rebind("SUPER + ALT + RETURN", "Persistent Terminal", function()
  local command = "wezterm start --always-new-process --domain $(hostname)"

  if not o.shell_succeeds([[pgrep -u "$(id -u)" -f '(^|/)wezterm-mux-server( |$)']]) then
    command = command .. " --attach"
  end

  hl.exec_cmd(o.launch(command))
end)

-- FIXME!: spawns a blank window, which then intercepts the kill
-- hl.bind("SUPER + SHIFT + W", hl.dsp.exec_cmd([[notify-send 'click window to kill' && hyprctl kill]]))

o.bind("SUPER + PERIOD", "Passwords", "1password")

o.bind("SUPER + E", "Toggle Strata", (require("hypr.strata-drawer")))

o.rebind(
  "SUPER + Q",
  "Toggle calculator",
  window_toggle.new({
    class = "org.gnome.Calculator",
    special = "special:calculator",
    launch = "gnome-calculator",
  })
)

-- Strata file-manager shortcuts.
if o.shell_succeeds("command -v strata >/dev/null 2>&1") then
  o.rebind("SUPER + SHIFT + F", "File manager", { launch = "strata" })
  o.rebind("SUPER + ALT + SHIFT + F", "File manager (cwd)", 'uwsm-app -- strata "$(omarchy-cmd-terminal-cwd)"')
end

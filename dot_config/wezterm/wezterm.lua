local wezterm = require("wezterm")
local act = wezterm.action
local config = wezterm.config_builder()

config.color_scheme = "arrowlake_light"

-- WezTerm paints the *current* search match with the terminal selection
-- colors (selection_*) and the *other* matches with
-- copy_mode_inactive_highlight_*. So these two are swapped on purpose:
-- magenta goes on selection_* (current match) and the subtle shade on
-- copy_mode_inactive_* (other matches). See wezterm issue #5888.
config.colors = {
	selection_bg = "#D7A9B1",
	selection_fg = "#54473F",
	copy_mode_inactive_highlight_bg = { Color = "#d4c6b3" },
	copy_mode_inactive_highlight_fg = { Color = "#54473f" },
}

-- config.quit_when_all_windows_are_closed = false -- TODO: how does this interact with the session persistence?

config.hide_tab_bar_if_only_one_tab = true -- TODO: remove when once full tabline.wez?
config.use_fancy_tab_bar = false

config.font = wezterm.font("JetBrains Mono", { weight = "Medium" })
config.font_size = 9

config.underline_thickness = "2.75px"

-- config.freetype_load_target = "Light"
-- config.freetype_render_target = "HorizontalLcd"
config.cell_width = 0.95

config.front_end = "OpenGL"

config.window_close_confirmation = "NeverPrompt"

-- Shared local multiplexer: every GUI window attaches to this unix domain,
-- so tabs/panes persist across windows and survive closing a window.
config.unix_domains = {
	{ name = "unix" },
}

-- Sessions shown in the launcher menu (config.launch_menu). Each entry is a
-- SpawnCommand; picking one spawns a tab in the shared `unix` mux.
local function expand_tilde(path)
	if not path then
		return nil
	end
	if path == "~" then
		return wezterm.home_dir
	end
	if path:sub(1, 2) == "~/" then
		return wezterm.home_dir .. path:sub(2)
	end
	return path
end

local launch_menu = require("sessions")
for _, entry in ipairs(launch_menu) do
	entry.cwd = expand_tilde(entry.cwd)
end
config.launch_menu = launch_menu

-- SUPER + ALT + RETURN opens the launcher directly: the wezterm-session-picker
-- wrapper sets WEZTERM_OPEN_LAUNCHER=1, and this opens the menu once the GUI
-- has attached to the domain.
if os.getenv("WEZTERM_OPEN_LAUNCHER") == "1" then
	local launcher_flags = "FUZZY|LAUNCH_MENU_ITEMS|WORKSPACES|DOMAINS"
	local shown = false
	wezterm.on("gui-attached", function()
		if shown then
			return
		end
		shown = true

		wezterm.time.call_after(0.1, function()
			for _, gui in ipairs(wezterm.gui.gui_windows()) do
				local pane = gui:active_pane()
				if pane then
					gui:perform_action(act.ShowLauncherArgs({ flags = launcher_flags }), pane)
					return
				end
			end
		end)
	end)
end

config.keys = require("keymaps")

return config

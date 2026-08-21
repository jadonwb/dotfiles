local wezterm = require("wezterm")
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

config.quit_when_all_windows_are_closed = true

config.hide_tab_bar_if_only_one_tab = true
config.use_fancy_tab_bar = false

config.enable_scroll_bar = true

config.font = wezterm.font("JetBrains Mono", { weight = "Medium" })
config.font_size = 9

config.underline_thickness = "2.75px"

-- config.freetype_load_target = "Light"
-- config.freetype_render_target = "HorizontalLcd"
config.cell_width = 0.95

config.front_end = "OpenGL"
config.use_ime = false

config.window_close_confirmation = "NeverPrompt"

config.unix_domains = {
	{
		name = "unix",
	},
}

-- wezterm.on("update-status", function(window, _pane)
-- 	local ws = window:active_workspace()
-- 	window:set_right_status(wezterm.format({
-- 		{ Attribute = { Intensity = "Bold" } },
-- 		{ Text = " " .. ws .. " " },
-- 	}))
-- end)

config.keys = require("keymaps")

return config

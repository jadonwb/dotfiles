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

config.hide_tab_bar_if_only_one_tab = false
config.use_fancy_tab_bar = false

config.enable_scroll_bar = true

config.font = wezterm.font("JetBrains Mono", { weight = "Medium" })
config.font_size = 9

config.underline_thickness = "2.75px"

-- config.freetype_load_target = "Light"
-- config.freetype_render_target = "HorizontalLcd"
config.cell_width = 0.95

local function hostname()
	local ok, out = wezterm.run_child_process({ "hostname" })
	if ok and out then
		return out:gsub("%s+$", "")
	end
	return nil
end

config.front_end = (hostname() == "ws205") and "WebGpu" or "OpenGL"
config.use_ime = false

config.window_close_confirmation = "NeverPrompt"

config.unix_domains = {
	{
		name = "unix",
	},
}

config.ssh_domains = require("ssh_domains").build()

config.default_workspace = "Home"

wezterm.on("update-status", function(window, pane)
	local colors = window:effective_config().resolved_palette
	local workspace = window:active_workspace()

	window:set_left_status(wezterm.format({
		{ Background = { Color = colors.tab_bar.active_tab.fg_color } },
		{ Foreground = { Color = colors.tab_bar.active_tab.bg_color } },
		{ Text = " " .. workspace .. " " },
	}))

	window:set_right_status(wezterm.format({
		{ Foreground = { Color = "#ad9b88" } },
		{ Text = hostname() .. " " },
	}))
end)

-- Hide the scrollbar when there is no scrollback or alternate screen is active
wezterm.on("update-status", function(window, pane)
	local overrides = window:get_config_overrides() or {}
	local dimensions = pane:get_dimensions()

	overrides.enable_scroll_bar = dimensions.scrollback_rows > dimensions.viewport_rows
		and not pane:is_alt_screen_active()

	window:set_config_overrides(overrides)
end)

-- config.debug_key_events = true

config.disable_default_key_bindings = true
config.keys = require("keymaps")

return config

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

config.enable_tab_bar = true
config.hide_tab_bar_if_only_one_tab = false
config.use_fancy_tab_bar = false

config.enable_scroll_bar = true

config.font = wezterm.font("JetBrains Mono", { weight = "Medium" })
config.font_size = 9

config.underline_thickness = "2.75px"

-- config.freetype_load_target = "Light"
-- config.freetype_render_target = "HorizontalLcd"
config.cell_width = 0.95

config.front_end = (wezterm.hostname() == "ws205") and "WebGpu" or "OpenGL"
config.use_ime = false

config.window_close_confirmation = "NeverPrompt"

local domains = require("ssh_domains")

config.unix_domains = {
	{
		name = domains.local_name,
	},
}

config.ssh_domains = domains.build()

config.default_workspace = wezterm.hostname()

wezterm.on("update-status", function(window, pane)
	local colors = window:effective_config().resolved_palette
	local workspace = window:active_workspace()

	-- Strip the domain prefix from names like "fwdt:dotfiles".
	local display_workspace = workspace:match("^[^:]+:(.+)$") or workspace

	window:set_left_status(wezterm.format({
		{ Background = { Color = colors.tab_bar.active_tab.fg_color } },
		{ Foreground = { Color = colors.tab_bar.active_tab.bg_color } },
		{ Text = " " .. display_workspace .. " " },
	}))

	window:set_right_status(wezterm.format({
		{ Foreground = { Color = colors.tab_bar.active_tab.fg_color } },
		{ Text = pane:get_user_vars().WEZTERM_HOST .. " " },
	}))

	-- useful debug
	-- local vars = pane:get_user_vars()
	-- window:set_right_status("WEZTERM_PROG=" .. (vars.WEZTERM_PROG or "<nil>"))

	-- Window overrides
	local overrides = window:get_config_overrides() or {}
	local changed = false

	-- Hide the scrollbar when there is no (larger amount of) scrollback
	-- or alternate screen is active
	local dimensions = pane:get_dimensions()
	local enable_scroll_bar = dimensions.scrollback_rows > (dimensions.viewport_rows + 5)
		and not pane:is_alt_screen_active()

	if overrides.enable_scroll_bar ~= enable_scroll_bar then
		overrides.enable_scroll_bar = enable_scroll_bar
		changed = true
	end

	if changed then
		window:set_config_overrides(overrides)
	end
end)

wezterm.on("toggle-tabbar", function(window, _)
	local overrides = window:get_config_overrides() or {}
	local enabled = window:effective_config().enable_tab_bar

	overrides.enable_tab_bar = not enabled
	window:set_config_overrides(overrides)
end)

wezterm.on("show-tabbar", function(window, _)
	if not window:effective_config().enable_tab_bar then
		local overrides = window:get_config_overrides() or {}
		overrides.enable_tab_bar = true
		window:set_config_overrides(overrides)
	end
end)

-- config.debug_key_events = true

config.disable_default_key_bindings = true
config.keys = require("keymaps")

return config

local wezterm = require("wezterm")
local config = wezterm.config_builder()

config.color_scheme = "arrowlake_light"

config.colors = {
	copy_mode_active_highlight_bg = { Color = "#D7A9B1" },
	copy_mode_active_highlight_fg = { Color = "#54473F" },
	copy_mode_inactive_highlight_bg = { Color = "#d4c6b3" },
	copy_mode_inactive_highlight_fg = { Color = "#54473f" },
}

config.quit_when_all_windows_are_closed = false -- TODO: how does this interact with the session persistence?

config.hide_tab_bar_if_only_one_tab = true -- TODO: remove when once full tabline.wez?
config.use_fancy_tab_bar = false

config.font = wezterm.font("JetBrains Mono", { weight = "Medium" })
config.font_size = 9

config.underline_thickness = "2.75px"

-- config.freetype_load_target = "Light"
-- config.freetype_render_target = "HorizontalLcd"
config.cell_width = 0.95

config.front_end = "WebGpu"

config.window_close_confirmation = "NeverPrompt"

config.keys = require("keymaps")
require("copy_mode")(config)

config.status_update_interval = 100

local MAG_BG = "#D7A9B1"
local MAG_FG = "#54473F"

local function is_magenta(value)
	if type(value) == "string" then
		return value:lower() == MAG_BG:lower()
	elseif type(value) == "table" then
		local v = value.Color or value.AnsiColor or value.Default
		return type(v) == "string" and v:lower() == MAG_BG:lower()
	end
	return false
end

local function in_copy_or_search(win)
	local t = win:active_key_table()
	return t == "copy_mode" or t == "search_mode"
end

wezterm.on("update-status", function(win, pane)
	local overrides = win:get_config_overrides() or {}
	local want = in_copy_or_search(win)
	local have = overrides.colors ~= nil and is_magenta(overrides.colors.selection_bg)

	if want ~= have then
		if want then
			overrides.colors = win:effective_config().colors
			overrides.colors.selection_bg = MAG_BG
			overrides.colors.selection_fg = MAG_FG
		else
			overrides.colors = nil
		end
		win:set_config_overrides(overrides)
	end
end)

return config

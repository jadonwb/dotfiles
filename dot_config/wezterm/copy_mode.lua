local wezterm = require("wezterm")
local act = wezterm.action

local function apply(config)
	local copy_mode = nil
	local search_mode = nil

	if wezterm.gui then
		copy_mode = wezterm.gui.default_key_tables().copy_mode

		search_mode = wezterm.gui.default_key_tables().search_mode
		for _, entry in ipairs(search_mode) do
			if entry.key == "Enter" and entry.mods == "NONE" then
				entry.action = act.CopyMode("NextMatch")
			end
		end
		table.insert(search_mode, { key = "Enter", mods = "SHIFT", action = act.CopyMode("PriorMatch") })
	end

	config.key_tables = {
		copy_mode = copy_mode,
		search_mode = search_mode,
	}
end

return apply

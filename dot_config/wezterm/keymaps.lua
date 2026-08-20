local wezterm = require("wezterm")
local act = wezterm.action

local function basename(path)
	return path:match("([^/]+)$") or path
end

local function is_neovim(pane)
	local info = pane:get_foreground_process_info()
	if not info or not info.executable then
		return false
	end
	return basename(info.executable) == "nvim"
end

local function scroll_or_forward(key, delta)
	return wezterm.action_callback(function(win, pane)
		if is_neovim(pane) then
			win:perform_action(act.SendKey({ key = key, mods = "ALT" }), pane)
		else
			win:perform_action(act.ScrollByLine(delta), pane)
		end
	end)
end

local keys = {
	-- tab navigation
	{ key = "LeftArrow", mods = "ALT", action = act.ActivateTabRelative(-1) },
	{ key = "RightArrow", mods = "ALT", action = act.ActivateTabRelative(1) },
	-- tab move/swap
	{ key = "LeftArrow", mods = "ALT|SHIFT", action = act.MoveTabRelative(-1) },
	{ key = "RightArrow", mods = "ALT|SHIFT", action = act.MoveTabRelative(1) },
	-- panes / tabs
	{ key = "x", mods = "ALT", action = act.CloseCurrentPane({ confirm = false }) },
	{ key = "c", mods = "ALT", action = act.SpawnTab("CurrentPaneDomain") },
	-- scroll, or forward to neovim
	{ key = "j", mods = "ALT", action = scroll_or_forward("j", 2) },
	{ key = "k", mods = "ALT", action = scroll_or_forward("k", -2) },
	-- copy mode / search entry
	{ key = "v", mods = "ALT", action = act.ActivateCopyMode },
	{ key = "/", mods = "ALT", action = act.Search({ CaseSensitiveString = "" }) },
	-- Alt-v is the sole copy-mode entry: disable the default Ctrl+Shift+X
	{ key = "X", mods = "CTRL|SHIFT", action = act.DisableDefaultAssignment },
}

for i = 1, 9 do
	table.insert(keys, { key = tostring(i), mods = "ALT", action = act.ActivateTab(i - 1) })
end

return keys

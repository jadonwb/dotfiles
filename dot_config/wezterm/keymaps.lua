local wezterm = require("wezterm")
local act = wezterm.action
local launcher = require("launcher")

local tui_programs = {
	nvim = true,
	vim = true,
	vi = true,

	yazi = true,

	opencode = true,
	oc = true,

	lazygit = true,
}

local function should_forward(pane)
	local prog = pane:get_user_vars().WEZTERM_PROG or ""

	local command = prog:match("^%s*([^%s]+)")
	if not command then
		return false
	end

	-- Handle paths like /usr/bin/nvim
	command = command:match("([^/]+)$") or command

	return tui_programs[command] == true
end

local function scroll_or_forward(key, delta)
	return wezterm.action_callback(function(win, pane)
		if should_forward(pane) then
			win:perform_action(
				act.SendKey({
					key = key,
					mods = "ALT",
				}),
				pane
			)
		else
			win:perform_action(act.ScrollByLine(delta), pane)
		end
	end)
end

local keys = {
	--copy/paste
	{ key = "Insert", mods = "CTRL", action = wezterm.action.CopyTo("Clipboard") },
	{ key = "Insert", mods = "SHIFT", action = wezterm.action.PasteFrom("Clipboard") },
	-- tab navigation
	{ key = "LeftArrow", mods = "ALT", action = act.ActivateTabRelative(-1) },
	{ key = "RightArrow", mods = "ALT", action = act.ActivateTabRelative(1) },
	{ key = "p", mods = "ALT", action = act.ActivateTabRelative(-1) },
	{ key = "n", mods = "ALT", action = act.ActivateTabRelative(1) },
	-- tab move/swap
	{ key = "LeftArrow", mods = "ALT|SHIFT", action = act.MoveTabRelative(-1) },
	{ key = "RightArrow", mods = "ALT|SHIFT", action = act.MoveTabRelative(1) },
	-- panes / tabs
	{ key = "x", mods = "ALT", action = act.CloseCurrentPane({ confirm = false }) },
	{ key = "c", mods = "ALT", action = act.SpawnTab("CurrentPaneDomain") },
	-- launcher: hub = workspaces + sessions + submenus (zoxide, machines, rename)
	{ key = "s", mods = "ALT", action = launcher.action_main() },
	-- scroll, or forward to neovim
	{ key = "j", mods = "ALT", action = scroll_or_forward("j", 2) },
	{ key = "k", mods = "ALT", action = scroll_or_forward("k", -2) },
	-- copy mode / search entry
	{ key = "v", mods = "ALT", action = act.ActivateCopyMode },
	{ key = "/", mods = "ALT", action = act.Search({ CaseSensitiveString = "" }) },
	-- Alt-v is the sole copy-mode entry: disable the default Ctrl+Shift+X
	{ key = "X", mods = "CTRL|SHIFT", action = act.DisableDefaultAssignment },
	{ key = "L", mods = "CTRL|SHIFT", action = act.ShowDebugOverlay },
}

for i = 1, 9 do
	table.insert(keys, { key = tostring(i), mods = "ALT", action = act.ActivateTab(i - 1) })
end

return keys

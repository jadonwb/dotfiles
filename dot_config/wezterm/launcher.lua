-- Custom launcher: a fuzzy InputSelector that replaces the built-in
-- `ShowLauncher` menu. Sections, in order:
--
--   * active workspaces (switch)
--   * preconfigured sessions (open as a workspace, spawning cwd/cmd only if new)
--   * zoxide directories (open as a workspace)
--   * commands (new tab, create workspace, rename tab/workspace)
--
-- Sessions whose workspace is already open are hidden here (they show up in the
-- "active workspaces" section instead).

local wezterm = require("wezterm")
local act = wezterm.action
local sessions = require("sessions")

local M = {}

local COL = {
	ws = "#7aa2f7",      -- blue: existing workspaces
	session = "#9ece6a", -- green: preconfigured sessions
	zoxide = "#565f89",  -- muted: zoxide directories
	cmd = "#e0af68",     -- orange: commands
}

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

local function styled(text, color, bold)
	local fmt = {}
	if bold then
		table.insert(fmt, { Attribute = { Intensity = "Bold" } })
	end
	if color then
		table.insert(fmt, { Foreground = { Color = color } })
	end
	table.insert(fmt, { Text = text })
	return wezterm.format(fmt)
end

local function build()
	local choices = {}
	local actions = {}
	local counter = 0

	local function add(label, action)
		counter = counter + 1
		local id = tostring(counter)
		table.insert(choices, { id = id, label = label })
		actions[id] = action
	end

	local names = wezterm.mux.get_workspace_names()
	local active = wezterm.mux.get_active_workspace()

	local open = {}
	for _, n in ipairs(names) do
		open[n] = true
	end

	-- 1. Active workspace first, then the rest (alphabetical).
	local active_shown = false
	if open[active] then
		add(styled("↳ " .. active, COL.ws, true), act.SwitchToWorkspace({ name = active }))
		active_shown = true
	end
	for _, n in ipairs(names) do
		if not (active_shown and n == active) then
			add(styled("↳ " .. n, COL.ws), act.SwitchToWorkspace({ name = n }))
		end
	end

	-- 2. Preconfigured sessions, hiding any that are already open.
	local used = {}
	for _, n in ipairs(names) do
		used[n] = true
	end
	for _, s in ipairs(sessions) do
		if not open[s.label] then
			used[s.label] = true
			add(styled(s.label, COL.session), act.SwitchToWorkspace({
				name = s.label,
				spawn = { cwd = expand_tilde(s.cwd), args = s.args },
			}))
		end
	end

	-- 3. Zoxide directories.
	local ok, stdout = wezterm.run_child_process({ "zoxide", "query", "-l" })
	if ok and stdout then
		for dir in stdout:gmatch("[^\r\n]+") do
			if dir ~= "" then
				local basename = dir:match("([^/]+)/?$")
				local name = basename
				if open[name] then
					name = nil -- already open; shown in workspaces
				elseif used[name] then
					name = dir -- basename collides; use full path
				end
				if name then
					used[name] = true
					add(styled("z " .. name, COL.zoxide), act.SwitchToWorkspace({
						name = name,
						spawn = { cwd = dir },
					}))
				end
			end
		end
	end

	-- 4. Commands.
	add(styled("+ new tab", COL.cmd, true), act.SpawnTab("CurrentPaneDomain"))
	add(styled("+ new workspace", COL.cmd), function(window, pane)
		window:perform_action(act.PromptInputLine({
			description = "New workspace name",
			action = wezterm.action_callback(function(w, p, line)
				if line and line ~= "" then
					w:perform_action(act.SwitchToWorkspace({ name = line }), p)
				end
			end),
		}), pane)
	end)
	add(styled("rename tab", COL.cmd), function(window, pane)
		window:perform_action(act.PromptInputLine({
			description = "New tab name",
			action = wezterm.action_callback(function(w, p, line)
				if line then
					local tab = w:active_tab()
					if tab then
						tab:set_title(line)
					end
				end
			end),
		}), pane)
	end)
	add(styled("rename workspace", COL.cmd), function(window, pane)
		window:perform_action(act.PromptInputLine({
			description = "New workspace name",
			action = wezterm.action_callback(function(w, p, line)
				if line and line ~= "" then
					wezterm.mux.rename_workspace(wezterm.mux.get_active_workspace(), line)
				end
			end),
		}), pane)
	end)

	return choices, actions
end

function M.show(window, pane)
	local choices, actions = build()
	window:perform_action(act.InputSelector({
		title = "Sessions & Workspaces",
		choices = choices,
		fuzzy = true,
		action = wezterm.action_callback(function(win, pan, id, label)
			if not id then
				return
			end
			local a = actions[id]
			if a then
				if type(a) == "function" then
					a(win, pan)
				else
					win:perform_action(a, pan)
				end
			end
		end),
	}), pane)
end

-- Keybinding entry point: returns an action that opens the launcher.
function M.action()
	return wezterm.action_callback(function(window, pane)
		M.show(window, pane)
	end)
end

return M

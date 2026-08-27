-- Custom launcher: a single fuzzy hub (ALT+s) with submenus.
--
--   hub (ALT+s):  workspaces, sessions, zoxide, machines, rename, + new workspace
--     zoxide →    second-level picker of zoxide dirs + open path
--     machines →  second-level picker of domains (attach / new tab)
--
-- Sessions are opened as whole workspaces on a domain (the local `unix` domain
-- by default, or an ssh domain for remote sessions). Windows attach to the
-- shared `unix` domain on startup (via the wezterm-omarchy wrapper), so
-- workspaces persist across window close/reopen. Pick a session to switch to it
-- or create it. Labels are colored with the theme's own ANSI palette via
-- AnsiColor names.

local wezterm = require("wezterm")
local act = wezterm.action
local sessions = require("sessions")

local M = {}

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

local function display_path(path)
	local home = wezterm.home_dir
	if path == home then
		return "home"
	end
	if path:sub(1, #home + 1) == home .. "/" then
		return "~/" .. path:sub(#home + 2)
	end
	return path
end

local function styled(text, ansi, bold)
	local fmt = {}
	if bold then
		table.insert(fmt, { Attribute = { Intensity = "Bold" } })
	end
	if ansi then
		table.insert(fmt, { Foreground = { AnsiColor = ansi } })
	end
	table.insert(fmt, { Text = text })
	return wezterm.format(fmt)
end

-- Collects choices + a map of id -> action function(win, pan).
local function new_builder()
	local choices = {}
	local actions = {}
	local n = 0
	local function add(label, fn)
		n = n + 1
		local id = tostring(n)
		table.insert(choices, { id = id, label = label })
		actions[id] = fn
	end
	return add, function()
		return choices, actions
	end
end

-- Open a session as a workspace: SwitchToWorkspace atomically creates the
-- workspace (spawning a persistent window on `domain`) only if it doesn't
-- already exist, then switches to it. Defaults to the local `unix` domain.
local function open_workspace(win, pan, name, cwd, args, domain)
	win:perform_action(
		act.SwitchToWorkspace({
			name = name,
			spawn = { domain = { DomainName = domain or "unix" }, cwd = cwd, args = args },
		}),
		pan
	)
end

-- ---- hub: quick switch -----------------------------------------------
local function build_main()
	local add, get = new_builder()

	local names = wezterm.mux.get_workspace_names()
	local active = wezterm.mux.get_active_workspace()

	local open = {}
	for _, n in ipairs(names) do
		open[n] = true
	end

	-- 1. Active workspace first, then the rest.
	local active_shown = false
	if open[active] then
		add(styled("↳ " .. active, "Blue", true), function(win, pan)
			win:perform_action(act.SwitchToWorkspace({ name = active }), pan)
		end)
		active_shown = true
	end
	for _, n in ipairs(names) do
		if not (active_shown and n == active) then
			add(styled("↳ " .. n, "Blue"), function(win, pan)
				win:perform_action(act.SwitchToWorkspace({ name = n }), pan)
			end)
		end
	end

	-- 2. Preconfigured sessions, hiding any that are already open.
	for _, s in ipairs(sessions) do
		local label = s.label
		if not open[label] then
			local cwd = expand_tilde(s.cwd)
			local args = s.args
			add(styled(label, "Green"), function(win, pan)
				open_workspace(win, pan, label, cwd, args, s.domain)
			end)
		end
	end

	-- 3. Submenus.
	add(styled("zoxide →", "Fuchsia", true), function(win, pan)
		M.zoxide(win, pan)
	end)
	add(styled("machines →", "Yellow", true), function(win, pan)
		M.machines(win, pan)
	end)

	-- 4. New workspace / renames.
	add(styled("+ new workspace", "Yellow"), function(win, pan)
		win:perform_action(
			act.PromptInputLine({
				description = "New workspace name",
				action = wezterm.action_callback(function(w, p, line)
					if line and line ~= "" then
						w:perform_action(act.SwitchToWorkspace({ name = line }), p)
					end
				end),
			}),
			pan
		)
	end)

	add(styled("rename tab", "Yellow"), function(win, pan)
		win:perform_action(
			act.PromptInputLine({
				description = "New tab name",
				action = wezterm.action_callback(function(w, p, line)
					if line then
						local tab = w:active_tab()
						if tab then
							tab:set_title(line)
						end
					end
				end),
			}),
			pan
		)
	end)

	add(styled("rename workspace", "Yellow"), function(win, pan)
		win:perform_action(
			act.PromptInputLine({
				description = "New workspace name",
				action = wezterm.action_callback(function(w, p, line)
					if line and line ~= "" then
						wezterm.mux.rename_workspace(wezterm.mux.get_active_workspace(), line)
					end
				end),
			}),
			pan
		)
	end)

	return get()
end

-- ---- zoxide submenu ----------------------------------------------------
local function build_zoxide()
	local add, get = new_builder()

	local ok, stdout = wezterm.run_child_process({ "zoxide", "query", "-l" })
	if ok and stdout then
		local used = {}
		for dir in stdout:gmatch("[^\r\n]+") do
			if dir ~= "" then
				local basename = dir:match("([^/]+)/?$") or dir
				local name = basename
				if used[name] then
					name = dir
				end
				used[name] = true
				add(styled(display_path(dir), "Fuchsia"), function(win, pan)
					open_workspace(win, pan, name, dir, nil)
				end)
			end
		end
	end

	add(styled("+ open path", "Yellow", true), function(win, pan)
		win:perform_action(
			act.PromptInputLine({
				description = "Path to open",
				action = wezterm.action_callback(function(w, p, line)
					if line and line ~= "" then
						local path = expand_tilde(line)
						local name = path:match("([^/]+)/?$") or path
						open_workspace(w, p, name, path, nil)
					end
				end),
			}),
			pan
		)
	end)

	return get()
end

-- ---- machines submenu: domains ----------------------------------------
local function build_machines()
	local add, get = new_builder()

	for _, domain in ipairs(wezterm.mux.all_domains()) do
		local name = domain:name()
		if domain:state() == "Detached" then
			add(styled("attach " .. name, "Yellow"), function(win, pan)
				win:perform_action(act.AttachDomain(name), pan)
			end)
		else
			add(styled("new tab in " .. name, "Yellow"), function(win, pan)
				win:perform_action(act.SpawnTab(name), pan)
			end)
		end
	end

	return get()
end

local function show(window, pane, title, build)
	local choices, actions = build()
	window:perform_action(
		act.InputSelector({
			title = title,
			choices = choices,
			fuzzy = true,
			action = wezterm.action_callback(function(win, pan, id, label)
				if not id then
					return
				end
				local fn = actions[id]
				if fn then
					fn(win, pan)
				end
			end),
		}),
		pane
	)
end

function M.main(window, pane)
	show(window, pane, "Sessions", build_main)
end

function M.zoxide(window, pane)
	show(window, pane, "Zoxide", build_zoxide)
end

function M.machines(window, pane)
	show(window, pane, "Machines", build_machines)
end

function M.action_main()
	return wezterm.action_callback(function(window, pane)
		M.main(window, pane)
	end)
end

return M

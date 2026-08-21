-- Custom launcher: two fuzzy InputSelector menus replacing the built-in
-- `ShowLauncher`.
--
--   main    (ALT+s):         active workspaces, sessions, zoxide dirs
--   utility (ALT+SHIFT+s):   domains (new tab / attach), new workspace,
--                            rename tab, rename workspace
--
-- Sessions are opened as whole workspaces. Persistence requires spawning into
-- the shared `unix` domain explicitly (an omitted domain defaults to "local",
-- which dies with the window). The active workspace is per-GUI-process, so a
-- fresh window still starts at "default"; re-attach by picking a session here.
-- Labels are colored with the theme's own ANSI palette via AnsiColor names.

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

local function workspace_exists(name)
	for _, ws in ipairs(wezterm.mux.get_workspace_names()) do
		if ws == name then
			return true
		end
	end
	return false
end

-- Open a session as a workspace: spawn a persistent window in the unix domain
-- only if the workspace is new, then switch to it.
local function open_workspace(name, cwd, args)
	if not workspace_exists(name) then
		wezterm.mux.spawn_window({
			domain = { DomainName = "unix" },
			workspace = name,
			cwd = cwd,
			args = args,
		})
	end
	wezterm.mux.set_active_workspace(name)
end

-- ---- main menu: quick switch -------------------------------------------
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
		add(styled("↳ " .. active, "Blue", true), function()
			wezterm.mux.set_active_workspace(active)
		end)
		active_shown = true
	end
	for _, n in ipairs(names) do
		if not (active_shown and n == active) then
			add(styled("↳ " .. n, "Blue"), function()
				wezterm.mux.set_active_workspace(n)
			end)
		end
	end

	-- 2. Preconfigured sessions, hiding any that are already open.
	local used = {}
	for _, n in ipairs(names) do
		used[n] = true
	end
	for _, s in ipairs(sessions) do
		local label = s.label
		if not open[label] then
			used[label] = true
			local cwd = expand_tilde(s.cwd)
			local args = s.args
			add(styled(label, "Green"), function()
				open_workspace(label, cwd, args)
			end)
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
					name = nil
				elseif used[name] then
					name = dir
				end
				if name then
					used[name] = true
					add(styled("z " .. name, "Fuchsia"), function()
						open_workspace(name, dir, nil)
					end)
				end
			end
		end
	end

	return get()
end

-- ---- utility menu: domains + commands ----------------------------------
local function build_utility()
	local add, get = new_builder()

	-- Domains: attach detached ones, or spawn a new tab in attached ones.
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

	add(styled("+ new workspace", "Yellow", true), function(win, pan)
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

function M.utility(window, pane)
	show(window, pane, "Commands", build_utility)
end

function M.action_main()
	return wezterm.action_callback(function(window, pane)
		M.main(window, pane)
	end)
end

function M.action_utility()
	return wezterm.action_callback(function(window, pane)
		M.utility(window, pane)
	end)
end

-- The WEZTERM_OPEN_LAUNCHER hook in wezterm.lua calls M.show.
M.show = M.main

return M

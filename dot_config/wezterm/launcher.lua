-- Custom launcher: a single fuzzy hub (ALT+s) with submenus.
--
--   hub (ALT+s):  workspaces (all domains), sessions, submenus
--     machines →  second-level picker of hosts to attach (ssh)
--     commands →  second-level picker of + new workspace / rename tab / rename workspace
--     zoxide →    second-level picker of zoxide dirs + open path (last)
--
-- The local `unix` domain is a headless persistent mux (wezterm-mux-server)
-- holding your named sessions. New windows open unattached; picking a session,
-- zoxide dir, host, or + new workspace attaches that domain (awaited) before
-- switching. Remote workspaces are shown namespaced as "host: workspace";
-- local ones are bare. Labels are colored with the theme's own ANSI palette via
-- AnsiColor names.

local wezterm = require("wezterm")
local act = wezterm.action
local sessions = require("sessions")
local ssh = require("ssh_domains")

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

local function is_local_domain(name)
	return name == "unix" or name == "local"
end

-- Attach a domain (awaited) if it isn't already attached. Must be called from
-- an async action-callback context.
local function attach_domain(name)
	local dom = wezterm.mux.get_domain(name)
	if dom and dom:state() == "Detached" then
		dom:attach()
	end
end

-- Domain name of a mux window (from its first pane).
local function window_domain(win)
	for _, tab in ipairs(win:tabs()) do
		for _, pane in ipairs(tab:panes()) do
			return pane:get_domain_name()
		end
	end
	return nil
end

-- All workspaces across every attached domain: { domain, workspace, anchor }.
local function collect_workspaces()
	local out = {}
	local seen = {}
	for _, win in ipairs(wezterm.mux.all_windows()) do
		local ws = win:get_workspace()
		local domain = window_domain(win)
		if domain then
			local key = domain .. "\0" .. ws
			if not seen[key] then
				seen[key] = true
				out[#out + 1] = { domain = domain, workspace = ws, anchor = win }
			end
		end
	end
	return out
end

local function workspace_label(e)
	if is_local_domain(e.domain) then
		return e.workspace
	end
	if e.workspace:sub(1, #e.domain + 1) == e.domain .. ":" then
		return e.workspace
	end
	return e.domain .. ": " .. e.workspace
end

-- Switch to an existing workspace, attaching its domain first if needed and
-- namespacing remote workspaces so names are unambiguous across machines.
local function switch_to_workspace(win, pan, e)
	attach_domain(e.domain)

	local name = e.workspace
	if not is_local_domain(e.domain) then
		name = e.domain .. ":" .. e.workspace
		if e.workspace ~= name then
			for _, w in ipairs(wezterm.mux.all_windows()) do
				if w:get_workspace() == e.workspace and window_domain(w) == e.domain then
					w:set_workspace(name)
				end
			end
		end
	end

	win:perform_action(act.SwitchToWorkspace({ name = name }), pan)
end

-- Open a session as a workspace, attaching its domain first (awaited), then
-- creating the workspace (spawning a persistent window on `domain`) only if it
-- doesn't already exist. Defaults to the local `unix` domain.
local function open_workspace(win, pan, name, cwd, args, domain)
	domain = domain or "unix"
	attach_domain(domain)
	win:perform_action(
		act.SwitchToWorkspace({
			name = name,
			spawn = { domain = { DomainName = domain }, cwd = cwd, args = args },
		}),
		pan
	)
end

-- ---- hub ----------------------------------------------------------------
local function build_main()
	local add, get = new_builder()

	local active = wezterm.mux.get_active_workspace()
	local workspaces = collect_workspaces()

	table.sort(workspaces, function(a, b)
		local aa = (a.workspace == active) and 0 or 1
		local ba = (b.workspace == active) and 0 or 1
		if aa ~= ba then
			return aa < ba
		end
		local al = is_local_domain(a.domain) and 0 or 1
		local bl = is_local_domain(b.domain) and 0 or 1
		if al ~= bl then
			return al < bl
		end
		return workspace_label(a) < workspace_label(b)
	end)

	local open = {}
	for _, e in ipairs(workspaces) do
		open[e.workspace] = true
	end

	-- 1. Workspaces across all attached domains.
	for _, e in ipairs(workspaces) do
		-- ignore current attached
		if e.workspace ~= active then
			add(styled(workspace_label(e), "Navy", false), function(win, pan)
				switch_to_workspace(win, pan, e)
			end)
		end
	end

	-- 2. Preconfigured sessions, hiding any that are already open.
	for _, s in ipairs(sessions) do
		local label = s.label
		local domain = s.domain or "unix"
		local target = is_local_domain(domain) and label or (domain .. ":" .. label)
		if not open[label] and not open[target] then
			local cwd = expand_tilde(s.cwd)
			local args = s.args
			add(styled(label, "Green"), function(win, pan)
				open_workspace(win, pan, label, cwd, args, domain)
			end)
		end
	end

	-- 3. Submenus: machines, commands, zoxide (last).
	add(styled("machines →", "Teal", true), function(win, pan)
		M.machines(win, pan)
	end)
	add(styled("commands →", "Olive", true), function(win, pan)
		M.commands(win, pan)
	end)
	add(styled("zoxide →", "Purple", true), function(win, pan)
		M.zoxide(win, pan)
	end)

	return get()
end

-- ---- zoxide submenu ------------------------------------------------------
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

-- ---- machines submenu: attach to a host --------------------------------
local function build_machines()
	local add, get = new_builder()

	local host_set = {}
	for _, n in ipairs(ssh.host_names()) do
		host_set[n] = true
	end

	for _, domain in ipairs(wezterm.mux.all_domains()) do
		local name = domain:name()
		if host_set[name] then
			add(styled(name, "Teal"), function(win, pan)
				attach_domain(name)
				M.main(win, pan)
			end)
		end
	end

	return get()
end

-- ---- commands submenu: new workspace + renames ---------------------------
local function build_commands()
	local add, get = new_builder()

	add(styled("+ new workspace", "Yellow"), function(win, pan)
		win:perform_action(
			act.PromptInputLine({
				description = "New workspace name",
				action = wezterm.action_callback(function(w, p, line)
					if line and line ~= "" then
						open_workspace(w, p, line, nil, nil, "unix")
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

function M.zoxide(window, pane)
	show(window, pane, "Zoxide", build_zoxide)
end

function M.machines(window, pane)
	show(window, pane, "Machines", build_machines)
end

function M.commands(window, pane)
	show(window, pane, "Commands", build_commands)
end

function M.action_main()
	return wezterm.action_callback(function(window, pane)
		M.main(window, pane)
	end)
end

return M

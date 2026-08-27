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

-- Attach an SSH/Unix mux domain.
--
-- domain:attach() imports whatever windows/tabs/panes already exist in that
-- mux server. Importantly, it does NOT create a pane if the remote mux is
-- empty.
local function attach_domain(name)
	local domain = wezterm.mux.get_domain(name)
	if not domain then
		wezterm.log_error("unknown mux domain: " .. tostring(name))
		return false
	end

	if domain:state() == "Detached" then
		domain:attach()
	end

	return true
end

-- Determine which mux domain owns a MuxWindow.
local function window_domain(window)
	for _, tab in ipairs(window:tabs()) do
		for _, pane in ipairs(tab:panes()) do
			return pane:get_domain_name()
		end
	end

	return nil
end

-- Collect the workspaces represented by the mux windows currently visible to
-- this GUI/mux client.
--
-- A domain attachment imports its remote mux windows. Once imported, those
-- windows appear in wezterm.mux.all_windows().
local function collect_workspaces()
	local result = {}
	local seen = {}

	for _, window in ipairs(wezterm.mux.all_windows()) do
		local workspace = window:get_workspace()
		local domain = window_domain(window)

		if domain then
			local key = domain .. "\0" .. workspace

			if not seen[key] then
				seen[key] = true

				result[#result + 1] = {
					domain = domain,
					workspace = workspace,
				}
			end
		end
	end

	return result
end

-- Domain names are presentation metadata only.
--
-- Do NOT rename the actual remote workspace to add the host name.
local function workspace_label(entry)
	if is_local_domain(entry.domain) then
		return entry.workspace
	end

	return entry.domain .. ": " .. entry.workspace
end

local function switch_to_workspace(win, pane, entry)
	win:perform_action(
		act.SwitchToWorkspace({
			name = entry.workspace,
		}),
		pane
	)
end

local function open_workspace(win, pane, name, cwd, args, domain)
	domain = domain or "unix"

	attach_domain(domain)

	win:perform_action(
		act.SwitchToWorkspace({
			name = name,
			spawn = {
				domain = { DomainName = domain },
				cwd = cwd,
				args = args,
			},
		}),
		pane
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

	for _, entry in ipairs(workspaces) do
		local key = entry.domain .. "\0" .. entry.workspace
		open[key] = true
	end

	-- Existing workspaces from every currently attached mux domain.
	for _, entry in ipairs(workspaces) do
		if entry.workspace ~= active or not is_local_domain(entry.domain) then
			add(styled(workspace_label(entry), "Navy", false), function(win, pane)
				switch_to_workspace(win, pane, entry)
			end)
		end
	end

	-- Preconfigured sessions.
	for _, session in ipairs(sessions) do
		local domain = session.domain or "unix"
		local key = domain .. "\0" .. session.label

		if not open[key] then
			local cwd = expand_tilde(session.cwd)
			local args = session.args

			add(styled(session.label, "Green"), function(win, pane)
				open_workspace(win, pane, session.label, cwd, args, domain)
			end)
		end
	end

	add(styled("machines →", "Teal", true), function(win, pane)
		M.machines(win, pane)
	end)

	add(styled("commands →", "Olive", true), function(win, pane)
		M.commands(win, pane)
	end)

	add(styled("zoxide →", "Purple", true), function(win, pane)
		M.zoxide(win, pane)
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

-- ---- machines submenu -----------------------------------------------------
--
-- Selecting a machine has exactly one job:
--
--     attach that remote mux domain
--
-- Attaching imports that machine's existing mux windows/tabs/panes into this
-- client. We deliberately do not immediately open another InputSelector from
-- inside this InputSelector callback.

local function build_machines()
	local add, get = new_builder()

	local host_set = {}
	for _, name in ipairs(ssh.host_names()) do
		host_set[name] = true
	end

	for _, domain in ipairs(wezterm.mux.all_domains()) do
		local name = domain:name()

		if host_set[name] then
			local state = domain:state()

			local label
			if state == "Attached" then
				label = name .. "  [attached]"
			else
				label = name
			end

			add(styled(label, "Teal"), function()
				attach_domain(name)
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

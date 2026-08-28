local wezterm = require("wezterm")
local act = wezterm.action
local sessions = require("sessions")
local domains = require("ssh_domains")

local M = {}

-- ---- helpers -------------------------------------------------------------

local function shell_quote(s)
	return "'" .. tostring(s):gsub("'", "'\\''") .. "'"
end

local function shell_path(path)
	if path == "~" then
		return "~"
	end

	if path:sub(1, 2) == "~/" then
		return "~/" .. shell_quote(path:sub(3))
	end

	return shell_quote(path)
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
		table.insert(fmt, {
			Attribute = { Intensity = "Bold" },
		})
	end

	if ansi then
		table.insert(fmt, {
			Foreground = { AnsiColor = ansi },
		})
	end

	table.insert(fmt, { Text = text })

	return wezterm.format(fmt)
end

local function new_builder()
	local choices = {}
	local actions = {}
	local n = 0

	local function add(label, fn)
		n = n + 1
		local id = tostring(n)

		table.insert(choices, {
			id = id,
			label = label,
		})

		actions[id] = fn
	end

	return add, function()
		return choices, actions
	end
end

local function show(window, pane, title, build)
	local choices, actions = build()

	window:perform_action(
		act.InputSelector({
			title = title,
			choices = choices,
			fuzzy = true,

			action = wezterm.action_callback(function(win, pan, id, _label)
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

-- ---- domain state --------------------------------------------------------

local function domain_names()
	local names = { domains.local_name }
	local seen = { [domains.local_name] = true }

	for _, name in ipairs(domains.ssh_names()) do
		if not seen[name] then
			seen[name] = true
			names[#names + 1] = name
		end
	end

	table.sort(names, function(a, b)
		if a == domains.local_name then
			return true
		end
		if b == domains.local_name then
			return false
		end
		return a < b
	end)

	return names
end

local function attach_domain(name)
	local domain = wezterm.mux.get_domain(name)

	if not domain then
		wezterm.log_error("unknown mux domain: " .. tostring(name))
		return false
	end

	if domain:state() == "Detached" then
		domain:attach()
	end

	return domain:state() == "Attached"
end

local function window_has_domain(window, domain_name)
	for _, tab in ipairs(window:tabs()) do
		for _, pane in ipairs(tab:panes()) do
			if pane:get_domain_name() == domain_name then
				return true
			end
		end
	end

	return false
end

local function detach_domain(name)
	local domain = wezterm.mux.get_domain(name)

	if domain and domain:state() == "Attached" then
		domain:detach()
	end
end

-- ---- workspace naming ----------------------------------------------------

local function qualify_workspace(domain_name, name)
	if name == domain_name then
		return name
	end

	local prefix = domain_name .. ":"

	if name:sub(1, #prefix) == prefix then
		return name
	end

	return prefix .. name
end

local function session_workspace(session, domain_name)
	if session.root then
		return domain_name
	end

	return qualify_workspace(domain_name, session.workspace or session.label)
end

local function domain_workspaces(domain_name)
	local result = {}
	local seen = {}

	for _, window in ipairs(wezterm.mux.all_windows()) do
		if window_has_domain(window, domain_name) then
			local workspace = window:get_workspace()

			if not seen[workspace] then
				seen[workspace] = true
				result[#result + 1] = workspace
			end
		end
	end

	table.sort(result)
	return result
end

local function switch_to_workspace(window, pane, workspace)
	window:perform_action(
		act.SwitchToWorkspace({
			name = workspace,
		}),
		pane
	)
end

local function open_workspace(window, pane, name, cwd, args, domain_name)
	if not attach_domain(domain_name) then
		return
	end

	local workspace = qualify_workspace(domain_name, name)

	window:perform_action(
		act.SwitchToWorkspace({
			name = workspace,

			spawn = {
				domain = {
					DomainName = domain_name,
				},
				cwd = cwd,
				args = args,
			},
		}),
		pane
	)
end

local function open_session(window, pane, session, domain_name)
	if not attach_domain(domain_name) then
		return
	end

	local workspace = session_workspace(session, domain_name)

	-- Existing workspace: just switch.
	for _, name in ipairs(wezterm.mux.get_workspace_names()) do
		if name == workspace then
			window:perform_action(
				act.SwitchToWorkspace({
					name = workspace,
				}),
				pane
			)
			return
		end
	end

	-- New workspace: create the remote pane with NO cwd/args.
	-- I think this is needed due to a bug where setting args
	-- or cwd causes the local panes env to leak into the new pane in the other domain
	window:perform_action(
		act.SwitchToWorkspace({
			name = workspace,
			spawn = {
				domain = {
					DomainName = domain_name,
				},
			},
		}),
		pane
	)

	-- Then initialize the already-correct remote shell.
	wezterm.time.call_after(0.1, function()
		local remote_pane = window:active_pane()

		if not remote_pane then
			return
		end

		local commands = {}

		if session.cwd then
			commands[#commands + 1] = "cd " .. shell_path(session.cwd)
		end

		if session.args and #session.args > 0 then
			local parts = {}

			for _, arg in ipairs(session.args) do
				parts[#parts + 1] = arg -- TODO: quoting?
				-- parts[#parts + 1] = shell_quote(arg)
			end

			commands[#commands + 1] = table.concat(parts, " ")
		end

		for _, command in ipairs(commands) do
			remote_pane:send_text(command .. "\n")
		end
	end)
end

-- ---- session definitions -------------------------------------------------

local function session_domains(session)
	if session.domains then
		return session.domains
	end

	if type(session.domain) == "table" then
		return session.domain
	end
	if type(session.domain) == "string" then
		return { session.domain }
	end

	return { domains.local_name }
end

local function session_has_domain(session, domain_name)
	for _, name in ipairs(session_domains(session)) do
		if name == domain_name then
			return true
		end
	end

	return false
end

local function sessions_for_domain(domain_name)
	local result = {}

	for _, session in ipairs(sessions) do
		if session_has_domain(session, domain_name) then
			result[#result + 1] = session
		end
	end

	return result
end

-- ---- domain workspace picker --------------------------------------------

local function build_domain_workspaces(domain_name)
	local add, get = new_builder()
	local open = {}

	for _, workspace in ipairs(domain_workspaces(domain_name)) do
		open[workspace] = true

		add(styled(workspace, "Navy"), function(window, pane)
			switch_to_workspace(window, pane, workspace)
		end)
	end

	for _, session in ipairs(sessions_for_domain(domain_name)) do
		local workspace = session_workspace(session, domain_name)

		if not open[workspace] then
			add(styled(workspace, "Green"), function(window, pane)
				open_session(window, pane, session, domain_name)
			end)
		end
	end

	add(styled("+ new workspace", "Yellow", true), function(window, pane)
		window:perform_action(
			act.PromptInputLine({
				description = "New workspace on " .. domain_name,

				action = wezterm.action_callback(function(w, p, name)
					if not name or name == "" then
						return
					end

					open_workspace(w, p, name, nil, nil, domain_name)
				end),
			}),
			pane
		)
	end)

	return get()
end

function M.domain_workspaces(window, pane, domain_name)
	show(window, pane, "Domain: " .. domain_name, function()
		return build_domain_workspaces(domain_name)
	end)
end

-- ---- domain submenu ------------------------------------------------------

local function build_domain(domain_name)
	local add, get = new_builder()

	local domain = wezterm.mux.get_domain(domain_name)

	if not domain then
		return get()
	end

	-- Preconfigured sessions for this domain.
	--
	-- These are always shown. SwitchToWorkspace only uses the spawn definition
	-- when the workspace does not already exist, so selecting an already-open
	-- session simply switches to it.
	for _, session in ipairs(sessions_for_domain(domain_name)) do
		add(styled(session.label, "Green"), function(window, pane)
			open_session(window, pane, session, domain_name)
		end)
	end

	-- Create a tab from this domain in the current MuxWindow/workspace.
	add(styled("+ new tab", "Yellow", true), function(window, _pane)
		if not attach_domain(domain_name) then
			return
		end

		window:mux_window():spawn_tab({
			domain = {
				DomainName = domain_name,
			},
		})
	end)

	-- Create a new workspace whose initial pane belongs to this domain.
	add(styled("+ new workspace", "Yellow", true), function(window, pane)
		window:perform_action(
			act.PromptInputLine({
				description = "New workspace on " .. domain_name,

				action = wezterm.action_callback(function(w, p, name)
					if not name or name == "" then
						return
					end

					open_workspace(w, p, name, nil, nil, domain_name)
				end),
			}),
			pane
		)
	end)

	-- Explicit connection control/status goes last.
	if domain:state() == "Attached" then
		add(styled("detach " .. domain_name, "Teal"), function()
			detach_domain(domain_name)
		end)
	else
		add(styled("attach " .. domain_name, "Teal"), function(window, pane)
			if not attach_domain(domain_name) then
				return
			end

			-- Once explicitly attached, open the same domain menu again so
			-- the user can immediately choose a session/new workspace/tab.
			wezterm.time.call_after(0.05, function()
				if domain:state() ~= "Attached" then
					return
				end

				local active = window:active_pane()

				if active then
					M.domain(window, active, domain_name)
				end
			end)
		end)
	end

	return get()
end

-- ---- main hub ------------------------------------------------------------

local function build_main()
	local add, get = new_builder()
	local active_workspace = wezterm.mux.get_active_workspace()

	-- All currently active persistent workspaces first, regardless of domain.
	local seen = {}
	local workspaces = {}

	for _, domain_name in ipairs(domain_names()) do
		local domain = wezterm.mux.get_domain(domain_name)

		if domain and domain:state() == "Attached" then
			for _, workspace in ipairs(domain_workspaces(domain_name)) do
				if not seen[workspace] then
					seen[workspace] = true
					workspaces[#workspaces + 1] = workspace
				end
			end
		end
	end

	table.sort(workspaces, function(a, b)
		if a == active_workspace then
			return true
		end

		if b == active_workspace then
			return false
		end

		return a < b
	end)

	for _, workspace in ipairs(workspaces) do
		-- Don't offer the workspace we're already viewing.
		if workspace ~= active_workspace then
			add(styled(workspace, "Navy"), function(window, pane)
				switch_to_workspace(window, pane, workspace)
			end)
		end
	end

	-- One submenu per configured domain.
	for _, domain_name in ipairs(domain_names()) do
		add(styled(domain_name .. " →", "Teal", true), function(window, pane)
			M.domain(window, pane, domain_name)
		end)
	end

	add(styled("rename →", "Olive", true), function(window, pane)
		M.rename(window, pane)
	end)

	return get()
end

-- ---- zoxide --------------------------------------------------------------

local function build_zoxide()
	local add, get = new_builder()

	local ok, stdout = wezterm.run_child_process({
		"zoxide",
		"query",
		"-l",
	})

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

				add(styled(display_path(dir), "Fuchsia"), function(window, pane)
					open_workspace(window, pane, name, dir, nil, domains.local_name)
				end)
			end
		end
	end

	add(styled("+ open path", "Yellow", true), function(window, pane)
		window:perform_action(
			act.PromptInputLine({
				description = "Path to open",

				action = wezterm.action_callback(function(w, p, line)
					if not line or line == "" then
						return
					end

					local path = line
					local name = path:match("([^/]+)/?$") or path

					open_workspace(w, p, name, path, nil, domains.local_name)
				end),
			}),
			pane
		)
	end)

	return get()
end

-- ---- rename --------------------------------------------------------------

local function build_rename()
	local add, get = new_builder()

	add(styled("rename tab", "Yellow"), function(window, pane)
		window:perform_action(
			act.PromptInputLine({
				description = "New tab name",

				action = wezterm.action_callback(function(w, _p, line)
					if line then
						local tab = w:active_tab()
						if tab then
							tab:set_title(line)
						end
					end
				end),
			}),
			pane
		)
	end)

	add(styled("rename workspace", "Yellow"), function(window, pane)
		window:perform_action(
			act.PromptInputLine({
				description = "New workspace name",

				action = wezterm.action_callback(function(_w, _p, line)
					if line and line ~= "" then
						wezterm.mux.rename_workspace(wezterm.mux.get_active_workspace(), line)
					end
				end),
			}),
			pane
		)
	end)

	return get()
end

-- ---- public entry points -------------------------------------------------

function M.main(window, pane)
	show(window, pane, "Sessions", build_main)
end

function M.domain(window, pane, domain_name)
	show(window, pane, domain_name, function()
		return build_domain(domain_name)
	end)
end

function M.zoxide(window, pane)
	show(window, pane, "Zoxide", build_zoxide)
end

function M.rename(window, pane)
	show(window, pane, "Rename", build_rename)
end

function M.action_main()
	return wezterm.action_callback(function(window, pane)
		M.main(window, pane)
	end)
end

return M

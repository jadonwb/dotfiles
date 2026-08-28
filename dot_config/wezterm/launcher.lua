local wezterm = require("wezterm")
local act = wezterm.action
local sessions = require("sessions")
local domains = require("ssh_domains")

local M = {}

-- ---- helpers -------------------------------------------------------------

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

local function shell_quote(arg)
	arg = tostring(arg)
	return "'" .. arg:gsub("'", "'\\''") .. "'"
end

-- Session commands are intentionally started through an interactive login zsh.
-- This sources the normal zsh startup files and lets the launched program
-- inherit the same shell/WezTerm integration environment as an interactive
-- terminal.
local function shell_wrap(args)
	if not args or #args == 0 then
		return nil
	end

	local quoted = {}
	for _, arg in ipairs(args) do
		quoted[#quoted + 1] = shell_quote(arg)
	end

	return {
		"zsh",
		"-lic",
		"exec " .. table.concat(quoted, " "),
	}
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

local function attached_domain_names()
	local result = {}

	for _, name in ipairs(domain_names()) do
		local domain = wezterm.mux.get_domain(name)
		if domain and domain:state() == "Attached" then
			result[#result + 1] = name
		end
	end

	return result
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

	window:perform_action(
		act.SwitchToWorkspace({
			name = workspace,

			spawn = {
				domain = {
					DomainName = domain_name,
				},
				cwd = expand_tilde(session.cwd),
				args = shell_wrap(session.args),
			},
		}),
		pane
	)
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

local function build_domain_workspaces(domain_name, scratch_pane)
	local add, get = new_builder()
	local open = {}

	for _, workspace in ipairs(domain_workspaces(domain_name)) do
		open[workspace] = true

		add(styled(workspace, "Navy"), function(window, pane)
			switch_to_workspace(window, pane, workspace, scratch_pane)
		end)
	end

	for _, session in ipairs(sessions_for_domain(domain_name)) do
		local workspace = session_workspace(session, domain_name)

		if not open[workspace] then
			add(styled(workspace, "Green"), function(window, pane)
				open_session(window, pane, session, domain_name, scratch_pane)
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

					open_workspace(w, p, name, nil, nil, domain_name, scratch_pane)
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

-- ---- domains attach/detach ----------------------------------------------

local function build_domains()
	local add, get = new_builder()

	for _, name in ipairs(domain_names()) do
		local domain = wezterm.mux.get_domain(name)

		if domain then
			if domain:state() == "Attached" then
				add(styled("detach " .. name, "Teal"), function()
					detach_domain(name)
				end)
			else
				add(styled("attach " .. name, "Teal"), function(window, _pane)
					if not attach_domain(name) then
						return
					end

					wezterm.time.call_after(0.05, function()
						if domain:state() ~= "Attached" then
							return
						end

						local active = window:active_pane()

						if active then
							M.domain_workspaces(window, active, name)
						end
					end)
				end)
			end
		end
	end

	return get()
end

-- ---- per-domain "new" submenu -------------------------------------------

local function build_domain_new(domain_name)
	local add, get = new_builder()

	add(styled("+ new workspace", "Yellow"), function(window, pane)
		window:perform_action(
			act.PromptInputLine({
				description = "New workspace on " .. domain_name,

				action = wezterm.action_callback(function(w, p, name)
					if not name or name == "" then
						return
					end

					open_workspace(w, p, name, nil, nil, domain_name, nil)
				end),
			}),
			pane
		)
	end)

	add(styled("+ new tab", "Yellow"), function(window, _pane)
		if not attach_domain(domain_name) then
			return
		end

		window:mux_window():spawn_tab({
			domain = {
				DomainName = domain_name,
			},
		})
	end)

	return get()
end

function M.domain_new(window, pane, domain_name)
	show(window, pane, domain_name .. ":new", function()
		return build_domain_new(domain_name)
	end)
end

-- ---- main hub ------------------------------------------------------------

local function build_main()
	local add, get = new_builder()
	local active_workspace = wezterm.mux.get_active_workspace()

	for _, domain_name in ipairs(attached_domain_names()) do
		local open = {}

		for _, workspace in ipairs(domain_workspaces(domain_name)) do
			open[workspace] = true

			if workspace ~= active_workspace then
				add(styled(workspace, "Navy"), function(window, pane)
					switch_to_workspace(window, pane, workspace, nil)
				end)
			end
		end

		for _, session in ipairs(sessions_for_domain(domain_name)) do
			local workspace = session_workspace(session, domain_name)

			if not open[workspace] then
				add(styled(workspace, "Green"), function(window, pane)
					open_session(window, pane, session, domain_name, nil)
				end)
			end
		end

		add(styled(domain_name .. ":new →", "Yellow", true), function(window, pane)
			M.domain_new(window, pane, domain_name)
		end)
	end

	add(styled("domains →", "Teal", true), function(window, pane)
		M.domains(window, pane, nil)
	end)

	add(styled("rename →", "Olive", true), function(window, pane)
		M.rename(window, pane)
	end)

	local local_domain = wezterm.mux.get_domain(domains.local_name)
	if local_domain and local_domain:state() == "Attached" then
		add(styled("zoxide →", "Purple", true), function(window, pane)
			M.zoxide(window, pane)
		end)
	end

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
					open_workspace(window, pane, name, dir, nil, domains.local_name, nil)
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

					local path = expand_tilde(line)
					local name = path:match("([^/]+)/?$") or path

					open_workspace(w, p, name, path, nil, domains.local_name, nil)
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
	if pane:get_domain_name() == "local" then
		M.domains(window, pane)
		return
	end

	show(window, pane, "Sessions", build_main)
end

function M.domains(window, pane)
	show(window, pane, "Domains", build_domains)
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

local wezterm = require("wezterm")
local act = wezterm.action
local sessions = require("sessions")
local ssh = require("ssh_domains")

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

-- Build InputSelector choices while keeping the action separate from the
-- rendered label.
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

-- ---- domains -------------------------------------------------------------

-- Domains that we explicitly want exposed through the launcher.
--
-- `local` is intentionally NOT here. It is the one-off ephemeral domain that
-- Super+Return starts in.
local function domain_names()
	local names = { "unix" }
	local seen = { unix = true }

	for _, name in ipairs(ssh.host_names()) do
		if not seen[name] then
			seen[name] = true
			names[#names + 1] = name
		end
	end

	table.sort(names, function(a, b)
		if a == "unix" then
			return true
		end

		if b == "unix" then
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

local function window_is_local_only(window)
	local found = false

	for _, tab in ipairs(window:tabs()) do
		for _, pane in ipairs(tab:panes()) do
			found = true

			if pane:get_domain_name() ~= "local" then
				return false
			end
		end
	end

	return found
end

-- Find this GUI process's non-persistent workspace.
--
-- This is useful when detaching the domain that backs the currently visible
-- pane: switch back to the scratch workspace first, then detach.
local function local_scratch_workspace()
	for _, window in ipairs(wezterm.mux.all_windows()) do
		if window_is_local_only(window) then
			return window:get_workspace()
		end
	end

	return nil
end

local function detach_domain(win, pane, name)
	local domain = wezterm.mux.get_domain(name)

	if not domain or domain:state() ~= "Attached" then
		return
	end

	-- If we're viewing some other domain, this domain can simply disappear.
	if pane:get_domain_name() ~= name then
		domain:detach()
		return
	end

	-- We're currently sitting inside the domain we're about to detach.
	-- Return this GUI to its ephemeral local workspace first.
	local scratch = local_scratch_workspace()

	if not scratch then
		domain:detach()
		return
	end

	win:perform_action(
		act.SwitchToWorkspace({
			name = scratch,
		}),
		pane
	)

	-- Let SwitchToWorkspace leave the current action callback before removing
	-- the domain that contained the old pane.
	wezterm.time.call_after(0.05, function()
		if domain:state() == "Attached" then
			domain:detach()
		end
	end)
end

-- ---- workspaces ----------------------------------------------------------

-- Workspace names are global once multiple mux domains have been attached.
--
-- New persistent workspaces therefore use:
--
--   unix on ws205:   ws205:bitbake
--   unix on fwdt:    fwdt:source
--   SSH domain fwdt: fwdt:build
--
-- The owner's bare hostname/domain is also allowed:
--
--   ws205
--   fwdt
local function qualify_workspace(domain_name, name)
	local owner = domain_name == "unix" and wezterm.hostname() or domain_name

	if name == owner then
		return name
	end

	local prefix = owner .. ":"

	if name:sub(1, #prefix) == prefix then
		return name
	end

	return prefix .. name
end

local function window_is_persistent(window)
	for _, tab in ipairs(window:tabs()) do
		for _, pane in ipairs(tab:panes()) do
			if pane:get_domain_name() ~= "local" then
				return true
			end
		end
	end

	return false
end

-- Persistent workspaces visible to this GUI.
--
-- The throwaway built-in `local` workspace is intentionally omitted.
local function collect_workspaces()
	local result = {}
	local seen = {}

	for _, window in ipairs(wezterm.mux.all_windows()) do
		if window_is_persistent(window) then
			local workspace = window:get_workspace()

			if not seen[workspace] then
				seen[workspace] = true
				result[#result + 1] = workspace
			end
		end
	end

	return result
end

-- Return the workspaces that currently contain at least one pane from a
-- particular domain.
--
-- Note that this deliberately does NOT claim that the workspace "belongs" to
-- that domain. A workspace can eventually contain panes from multiple domains.
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

local function switch_to_workspace(win, pane, workspace)
	win:perform_action(
		act.SwitchToWorkspace({
			name = workspace,
		}),
		pane
	)
end

-- Open an existing workspace or create it on the requested domain.
--
-- `name` is the friendly/unqualified name. This function applies the global
-- workspace naming convention.
local function open_workspace(win, pane, name, cwd, args, domain_name)
	domain_name = domain_name or "unix"

	if not attach_domain(domain_name) then
		return
	end

	local workspace = qualify_workspace(domain_name, name)

	win:perform_action(
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

-- ---- domain workspace picker --------------------------------------------

local function build_domain_workspaces(domain_name)
	local add, get = new_builder()

	for _, workspace in ipairs(domain_workspaces(domain_name)) do
		add(styled(workspace, "Navy"), function(win, pane)
			switch_to_workspace(win, pane, workspace)
		end)
	end

	add(styled("+ new workspace", "Yellow", true), function(win, pane)
		win:perform_action(
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

-- ---- domains submenu -----------------------------------------------------

local function build_domains()
	local add, get = new_builder()

	for _, name in ipairs(domain_names()) do
		local domain = wezterm.mux.get_domain(name)

		if domain then
			if domain:state() == "Attached" then
				add(styled("detach " .. name, "Teal"), function(win, pane)
					detach_domain(win, pane, name)
				end)
			else
				add(styled("attach " .. name, "Teal"), function(win, _pane)
					if not attach_domain(name) then
						return
					end

					-- domain:attach() has completed at this point, including
					-- authentication if required.
					--
					-- Defer opening the next InputSelector just enough to let
					-- the Domains selector disappear first.
					wezterm.time.call_after(0.05, function()
						if domain:state() ~= "Attached" then
							return
						end

						local active = win:active_pane()

						if active then
							M.domain_workspaces(win, active, name)
						end
					end)
				end)
			end
		end
	end

	return get()
end

-- ---- main hub ------------------------------------------------------------

local function build_main()
	local add, get = new_builder()

	local active = wezterm.mux.get_active_workspace()
	local workspaces = collect_workspaces()

	table.sort(workspaces, function(a, b)
		if a == active then
			return true
		end

		if b == active then
			return false
		end

		return a < b
	end)

	local open = {}

	for _, workspace in ipairs(workspaces) do
		open[workspace] = true
	end

	-- Existing persistent workspaces.
	for _, workspace in ipairs(workspaces) do
		if workspace ~= active then
			add(styled(workspace, "Navy"), function(win, pane)
				switch_to_workspace(win, pane, workspace)
			end)
		end
	end

	-- Preconfigured sessions.
	--
	-- They default to the local persistent `unix` mux, but a session may
	-- explicitly specify an SSH domain.
	for _, session in ipairs(sessions) do
		local domain_name = session.domain or "unix"

		local workspace = qualify_workspace(domain_name, session.label)

		if not open[workspace] then
			local cwd = expand_tilde(session.cwd)
			local args = session.args

			add(styled(workspace, "Green"), function(win, pane)
				open_workspace(win, pane, session.label, cwd, args, domain_name)
			end)
		end
	end

	add(styled("domains →", "Teal", true), function(win, pane)
		M.domains(win, pane)
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

				add(styled(display_path(dir), "Fuchsia"), function(win, pane)
					open_workspace(win, pane, name, dir, nil, "unix")
				end)
			end
		end
	end

	add(styled("+ open path", "Yellow", true), function(win, pane)
		win:perform_action(
			act.PromptInputLine({
				description = "Path to open",

				action = wezterm.action_callback(function(w, p, line)
					if not line or line == "" then
						return
					end

					local path = expand_tilde(line)

					local name = path:match("([^/]+)/?$") or path

					open_workspace(w, p, name, path, nil, "unix")
				end),
			}),
			pane
		)
	end)

	return get()
end

-- ---- commands submenu ---------------------------------------------------

local function build_commands()
	local add, get = new_builder()

	add(styled("+ new workspace", "Yellow"), function(win, pane)
		win:perform_action(
			act.PromptInputLine({
				description = "New local workspace",

				action = wezterm.action_callback(function(w, p, line)
					if line and line ~= "" then
						open_workspace(w, p, line, nil, nil, "unix")
					end
				end),
			}),
			pane
		)
	end)

	add(styled("rename tab", "Yellow"), function(win, pane)
		win:perform_action(
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

	add(styled("rename workspace", "Yellow"), function(win, pane)
		win:perform_action(
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
	-- Super+Return starts in the built-in local domain.
	--
	-- While we're still in that ephemeral state, Alt-s does not expose
	-- persistent workspaces/sessions at all. The only operation offered is
	-- entering one of the persistent mux domains.
	if pane:get_domain_name() == "local" then
		M.domains(window, pane)
		return
	end

	show(window, pane, "Sessions", build_main)
end

function M.zoxide(window, pane)
	show(window, pane, "Zoxide", build_zoxide)
end

function M.domains(window, pane)
	show(window, pane, "Domains", build_domains)
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

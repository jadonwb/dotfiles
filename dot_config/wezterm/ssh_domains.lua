-- SSH domains for the launcher: auto-discovered from ~/.ssh/config, with an
-- optional per-host override table. All domains use WezTerm multiplexing so
-- remote panes persist across disconnects (requires wezterm-mux-server on the
-- remote host; set remote_wezterm_path below if it isn't on the remote $PATH).

local wezterm = require("wezterm")

local M = {}

-- Optional overrides/additions keyed by domain name (ssh config alias or host).
-- Overrides merge onto the auto-discovered host; a key not present in
-- ~/.ssh/config creates a new domain (set remote_address/username if the key
-- isn't an ssh alias on its own).
M.hosts = {
	["work"] = {
		remote_address = "ws205",
		username = "jadon.brutcher",
		-- remote_wezterm_path = "/home/jadon/.local/bin/wezterm",
	},
}

local function build_domain(name, o)
	o = o or {}
	return {
		name = name,
		remote_address = o.remote_address or name,
		username = o.username,
		multiplexing = "WezTerm",
		remote_wezterm_path = o.remote_wezterm_path,
		no_agent_auth = o.no_agent_auth,
		local_echo_threshold_ms = o.local_echo_threshold_ms,
	}
end

function M.build()
	local seen = {}
	local domains = {}

	for host in pairs(wezterm.enumerate_ssh_hosts()) do
		seen[host] = true
		table.insert(domains, build_domain(host, M.hosts[host]))
	end

	for host, overrides in pairs(M.hosts) do
		if not seen[host] then
			table.insert(domains, build_domain(host, overrides))
		end
	end

	table.sort(domains, function(a, b)
		return a.name < b.name
	end)
	return domains
end

return M

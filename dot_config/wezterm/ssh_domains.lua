-- SSH domains for the launcher: discovered by parsing ~/.ssh/config ourselves,
-- with an optional per-host override table. All domains use WezTerm
-- multiplexing so remote panes persist across disconnects (requires
-- wezterm-mux-server on the remote host; set remote_wezterm_path below if it
-- isn't on the remote $PATH).
--
-- We parse ~/.ssh/config directly instead of wezterm.enumerate_ssh_hosts()
-- because the latter reads the file via a different home-dir resolution that
-- returned empty here. Resolving HostName/User ourselves also makes the
-- connection independent of WezTerm's own ssh-config resolution.

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
	},
	["fwdt"] = {
		remote_address = "fwdt",
		username = "jadon",
	},
}

-- Parse ~/.ssh/config: returns a map alias -> { remote_address, username }.
-- Handles Host / HostName / User; skips wildcard (* / ?) and negated (!) aliases.
local function parse_ssh_config()
	local path = wezterm.home_dir .. "/.ssh/config"
	local f = io.open(path, "r")
	if not f then
		return {}
	end

	local hosts = {}
	local current = nil
	for line in f:lines() do
		local kw, rest = line:match("^%s*([%w%-]+)%s*(.*)$")
		if kw then
			kw = kw:lower()
			if kw == "host" then
				current = nil
				for alias in rest:gmatch("%S+") do
					local c = alias:sub(1, 1)
					if c ~= "*" and c ~= "!" and c ~= "?" then
						current = alias
						hosts[current] = hosts[current] or {}
						break
					end
				end
			elseif current and kw == "hostname" then
				hosts[current].remote_address = rest:match("%S+")
			elseif current and kw == "user" then
				hosts[current].username = rest:match("%S+")
			end
		end
	end
	f:close()
	return hosts
end

function M.build()
	local parsed = parse_ssh_config()

	local seen = {}
	local names = {}
	local function add_name(n)
		if not seen[n] then
			seen[n] = true
			names[#names + 1] = n
		end
	end
	for alias in pairs(parsed) do
		add_name(alias)
	end
	for alias in pairs(M.hosts) do
		add_name(alias)
	end
	table.sort(names)

	local domains = {}
	for _, alias in ipairs(names) do
		local cfg = parsed[alias] or {}
		local o = M.hosts[alias] or {}
		domains[#domains + 1] = {
			name = alias,
			remote_address = o.remote_address or cfg.remote_address or alias,
			username = o.username or cfg.username,
			multiplexing = "WezTerm",
			remote_wezterm_path = o.remote_wezterm_path,
			no_agent_auth = o.no_agent_auth,
			local_echo_threshold_ms = o.local_echo_threshold_ms,
		}
	end
	return domains
end

function M.host_names()
	local names = {}
	for _, d in ipairs(M.build()) do
		names[#names + 1] = d.name
	end
	return names
end

return M

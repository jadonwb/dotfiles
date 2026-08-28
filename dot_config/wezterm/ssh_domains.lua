local wezterm = require("wezterm")

local M = {}

M.local_name = (wezterm.hostname() == "ws205") and "work" or wezterm.hostname()

-- Optional presentation-name overrides for concrete Host entries in
-- ~/.ssh/config. remote_address remains the SSH config alias so WezTerm applies
-- User, HostName, IdentityFile, Include, ProxyJump, etc. itself.
M.name_overrides = {
	ws205 = "work",
}

local function discovered()
	return wezterm.enumerate_ssh_hosts()
end

function M.build()
	local result = {}

	for host, _config in pairs(discovered()) do
		result[#result + 1] = {
			name = M.name_overrides[host] or host,
			remote_address = host,
			multiplexing = "WezTerm",
			assume_shell = "Posix",
		}
	end

	table.sort(result, function(a, b)
		return a.name < b.name
	end)

	return result
end

function M.ssh_names()
	local result = {}

	for _, domain in ipairs(M.build()) do
		result[#result + 1] = domain.name
	end

	return result
end

return M

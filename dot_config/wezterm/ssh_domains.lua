local wezterm = require("wezterm")

local M = {}

M.local_name = wezterm.hostname()

local function include_host(host)
	return not host:match(".host") and not host:match("machine/.host")
end

function M.build()
	local result = {}

	for host, _config in pairs(wezterm.enumerate_ssh_hosts()) do
		if include_host(host) then
			result[#result + 1] = {
				name = host,

				-- Keep the original SSH alias here so WezTerm applies the
				-- effective ~/.ssh/config settings for this host.
				remote_address = host,

				multiplexing = "WezTerm",
				assume_shell = "Posix",
			}
		end
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

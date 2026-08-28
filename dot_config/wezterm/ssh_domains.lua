local wezterm = require("wezterm")

local M = {}

M.local_name = wezterm.hostname()

local function include_domain(domain)
	local host = domain.name:gsub("^SSHMUX:", ""):gsub("^SSH:", "")

	return not host:match("^%.") and not host:match("/%.")
end

local all_domains = wezterm.default_ssh_domains()

local mux_domains = {}
local domain_info = {}

for _, domain in ipairs(all_domains) do
	if domain.name:match("^SSHMUX:") and include_domain(domain) then
		local host = domain.name:gsub("^SSHMUX:", "")

		-- Keep your nice short domain names.
		domain.name = host
		domain.assume_shell = "Posix"

		mux_domains[#mux_domains + 1] = domain

		-- enumerate_ssh_hosts is still useful for metadata like cwd expansion.
		local ssh = wezterm.enumerate_ssh_hosts()[host]
		if ssh then
			domain_info[host] = {
				host = host,
				user = ssh.user,
			}
		end
	end
end

table.sort(mux_domains, function(a, b)
	return a.name < b.name
end)

function M.build()
	return mux_domains
end

function M.ssh_names()
	local result = {}

	for _, domain in ipairs(mux_domains) do
		result[#result + 1] = domain.name
	end

	return result
end

function M.username(name)
	local info = domain_info[name]
	return info and info.user or nil
end

return M

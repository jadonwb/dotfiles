-- Preconfigured persistent sessions.
--
-- Fields:
--   label      launcher/session name
--   domains    domains on which this session is available
--   cwd        initial working directory
--   args       optional program + arguments
--   root       use the bare domain name as the workspace name
--              instead of "domain:label"
--
-- launcher.lua starts any session with `args` through:
--
--   zsh -lic 'exec ...'
--
-- so the program inherits the normal interactive zsh/WezTerm integration
-- environment.

local common = {
	"work",
	"fwdt",
	"omapad",
}

return {
	{ label = "home", root = true, domains = common, cwd = "~" },
	{ label = "source code", domains = common, cwd = "~/c" },
	{ label = "dotfiles", domains = common, cwd = "~/.local/share/chezmoi", args = { "nvim" } },
	{ label = "neovim", domains = common, cwd = "~/.config/nvim", args = { "nvim" } },

	{ label = "bitbake", domains = { "work" }, cwd = "~/Work/fusion2/dms-yocto/" },
	{ label = "fusion", domains = { "work" }, cwd = "~/Work/fusion2/Fusion_2s_i.MX/" },
	{ label = "radar", domains = { "work" }, cwd = "~/Work/radar/" },

	{ label = "llama-toolboxes", domains = { "fwdt" }, cwd = "~/c/amd-strix-halo-toolboxes/" },
	{ label = "vllm-toolboxes", domains = { "fwdt" }, cwd = "~/c/amd-strix-halo-vllm-toolboxes/" },
	{ label = "comfyui-toolboxes", domains = { "fwdt" }, cwd = "~/c/amd-strix-halo-image-video-toolboxes/" },
}

return {
	{
		"jadonwb/arrowlake.nvim",
		opts = {
			style = "light",
			transparent = true,
			styles = {
				functions = { bold = true },
			},
			lualine_bold = true,
			border_style = "rounded",
		},
		import = "arrowlake.plugin_defaults",
		keys = {
			{
				"<leader>uH",
				function()
					require("arrowlake").toggle_transparency()
				end,
				desc = "Toggle Transparecny",
			},
		},
	},
	{
		"LazyVim/LazyVim",
		opts = {
			colorscheme = "arrowlake-light",
		},
	},
}

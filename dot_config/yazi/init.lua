-- https://github.com/yazi-rs/plugins/tree/main/git.yazi
th.git = th.git or {}

th.git.added_sign = ""

th.git.deleted_sign = ""

th.git.ignored_sign = ""

th.git.modified_sign = ""

th.git.untracked_sign = ""

th.git.updated_sign = ""

require("git"):setup()

require("full-border"):setup({
	-- Available values: ui.Border.PLAIN, ui.Border.ROUNDED
	type = ui.Border.ROUNDED,
})

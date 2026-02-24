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

Status:children_add(function()
	local h = cx.active.current.hovered
	if not h or ya.target_family() ~= "unix" then
		return ""
	end

	return ui.Line({
		ui.Span(ya.user_name(h.cha.uid) or tostring(h.cha.uid)):fg("magenta"),
		":",
		ui.Span(ya.group_name(h.cha.gid) or tostring(h.cha.gid)):fg("magenta"),
		" ",
	})
end, 500, Status.RIGHT)

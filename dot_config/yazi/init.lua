-- https://github.com/yazi-rs/plugins/tree/main/git.yazi
th.git = th.git or {}

th.git.added_sign = ""

th.git.deleted_sign = ""

th.git.ignored_sign = ""

th.git.modified_sign = ""

th.git.untracked_sign = ""

th.git.updated_sign = ""

require("git"):setup()

require("close-and-restore-tab"):setup()

-- YAZI_TREE=1 selects an embedded per-launch mode (tree on, preview hidden) so
-- the first frame is already tree-shaped; plain launches keep normal defaults.
local embedded_tree = os.getenv("YAZI_TREE") == "1"

require("tree"):setup({
	style = "indent",
	startup = { tree = embedded_tree, preview = not embedded_tree },
	filter_mode = "adopt",
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

hl.workspace_rule({
  workspace = "special:yazi",
  on_created_empty = "omarchy-launch-tui yazi",
})

hl.workspace_rule({
  workspace = "special:activity",
  on_created_empty = "omarchy-launch-tui btop",
})

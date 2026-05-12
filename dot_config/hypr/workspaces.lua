hl.workspace_rule({
  workspace = "special:yazi",
  on_created_empty = "omarchy-launch-tui yazi",
})

hl.workspace_rule({
  workspace = "special:activity",
  on_created_empty = "omarchy-launch-tui btop",
})

hl.workspace_rule({
  workspace = "special:youtube",
  on_created_empty = [[omarchy-launch-webapp "https://youtube.com/"]],
})

hl.workspace_rule({
  workspace = "special:keyboard",
  on_created_empty = [[omarchy-launch-webapp "https://my.moergo.com/go60/##/" && omarchy-launch-webapp "https://my.moergo.com/glove80/##/"]],
  layout = "scrolling",
  layout_opts = { direction = "up" },
})

hl.workspace_rule({
  workspace = "special:scratch",
  on_created_empty = [[uwsm-app -- xdg-terminal-exec --dir="$HOME/Documents/notes" --command nvim]],
  layout = "scrolling",
  layout_opts = { direction = "right" },
})

hl.workspace_rule({
  workspace = "special:media",
  on_created_empty = [[omarchy-launch-webapp "https://www.icloud.com/" && omarchy-launch-webapp "https://www.reddit.com/" && omarchy-launch-webapp "https://music.apple.com" && vesktop]],
  layout = "scrolling",
  layout_opts = { direction = "right" },
})

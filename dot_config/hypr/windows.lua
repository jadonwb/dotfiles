hl.window_rule({
  name = "chromium-browser-opacity",
  match = { tag = "chromium-based-browser" },
  opacity = "0.95 override 0.9 override",
})

hl.window_rule({
  name = "yazi",
  match = { class = "org.omarchy.yazi" },
  float = true,
  center = true,
  size = { "(monitor_w*0.8)", "(monitor_h*0.8)" },
})

hl.window_rule({
  name = "gstreamer",
  match = { class = "GStreamer" },
  no_anim = true,
  rounding = 0,
  opacity = "1.0 override 1.0 override",
  float = true,
  center = true,
})

hl.window_rule({
  name = "btop-tag",
  match = { class = "org.omarchy.btop" },
  tag = "-floating-window",
})

hl.window_rule({
  name = "btop-size",
  match = { class = "org.omarchy.btop" },
  float = true,
  center = true,
  size = { "(monitor_w*0.8)", "(monitor_h*0.9)" },
})

hl.window_rule({
  name = "vesktop-media",
  match = { class = "vesktop" },
  workspace = "special:media",
})

hl.window_rule({
  name = "screensaver",
  match = { class = "^(org\\.omarchy\\.screensaver)$" },
  no_anim = true,
  rounding = 0,
})

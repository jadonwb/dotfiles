hl.config({
  general = {
    border_size = 3,
    layout = "scrolling",
  },

  decoration = {
    shadow = {
      enabled = true,
      range = 15,
      render_power = 5,
      color = "rgba(0a0a1eee)",
      offset = { 0, 0 },
    },

    blur = {
      enabled = true,
      size = 2,
      passes = 3,
      contrast = 1.1,
      brightness = 1.1,
      vibrancy = 0.2,
      vibrancy_darkness = 0.2,
      noise = 0.03,
      ignore_opacity = true,
      new_optimizations = true,
    },

    active_opacity = 0.95,
    inactive_opacity = 0.93,
    fullscreen_opacity = 1.0,
  },

  animations = {
    enabled = true,
  },

  scrolling = {
    direction = "right",
    column_width = 0.97,
  },
})

-- Uncomment to avoid overly wide single-window layouts on wide screens.
-- hl.config({
--   layout = {
--     single_window_aspect_ratio = { 1, 1 },
--   },
-- })

hl.curve("calm", {
  type = "bezier",
  points = { { 0.25, 0.9 }, { 0.35, 1.0 } },
})

hl.curve("settle", {
  type = "bezier",
  points = { { 0.3, 1.1 }, { 0.8, 1.02 } },
})

hl.animation({ leaf = "windows", enabled = true, speed = 4, bezier = "calm" })
hl.animation({ leaf = "windowsIn", enabled = true, speed = 4, bezier = "calm" })
hl.animation({ leaf = "windowsOut", enabled = true, speed = 1, bezier = "calm" })
hl.animation({ leaf = "windowsMove", enabled = true, speed = 4, bezier = "calm" })

hl.animation({ leaf = "fade", enabled = true, speed = 3.5, bezier = "calm" })
hl.animation({ leaf = "fadeIn", enabled = true, speed = 3.5, bezier = "calm" })
hl.animation({ leaf = "fadeOut", enabled = true, speed = 2.5, bezier = "calm" })

hl.animation({ leaf = "layers", enabled = true, speed = 3.5, bezier = "calm" })
hl.animation({ leaf = "layersIn", enabled = true, speed = 3.5, bezier = "calm" })
hl.animation({ leaf = "layersOut", enabled = true, speed = 2.5, bezier = "calm" })

hl.animation({ leaf = "workspacesIn", enabled = true, speed = 4.5, bezier = "settle", style = "slide top" })
hl.animation({ leaf = "workspacesOut", enabled = true, speed = 4.5, bezier = "settle", style = "slide top" })
hl.animation({ leaf = "specialWorkspaceIn", enabled = true, speed = 4.5, bezier = "settle", style = "slide bottom" })
hl.animation({ leaf = "specialWorkspaceOut", enabled = true, speed = 4, bezier = "settle", style = "slide top" })

hl.layer_rule({
  match = { namespace = "walker" },
  blur = true,
  ignore_alpha = 0,
})

hl.layer_rule({
  match = { namespace = "waybar" },
  blur = true,
  ignore_alpha = 0.1,
})

hl.layer_rule({
  match = { namespace = "notifications" },
  blur = true,
  ignore_alpha = 0,
})

hl.layer_rule({
  match = { namespace = "swayosd" },
  blur = true,
})

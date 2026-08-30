-- Change the default Omarchy look'n'feel.

local machine = require("hypr.host")

-- https://wiki.hypr.land/Configuring/Basics/Variables/#general
hl.config({
  general = {
    gaps_in = 5,
    gaps_out = 10,
    border_size = 3,

    layout = "scrolling",
  },
})

-- https://wiki.hypr.land/Configuring/Basics/Variables/#decoration
hl.config({
  decoration = {
    -- Use round window corners.
    rounding = 4,

    -- Dim unfocused windows (0.0 = no dim, 1.0 = fully dimmed).
    dim_inactive = true,
    dim_strength = 0.1,

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
})

-- https://wiki.hypr.land/Configuring/Basics/Variables/#animations
-- hl.config({
--   animations = {
--     -- Disable all animations.
--     enabled = false,
--   },
-- })

-- https://wiki.hypr.land/Configuring/Basics/Variables/#layout
-- hl.config({
--   layout = {
--     -- Avoid overly wide single-window layouts on wide screens.
--     single_window_aspect_ratio = { 1, 1 },
--   },
-- })

-- https://wiki.hypr.land/Configuring/Layouts/Scrolling-Layout/
hl.config({
  scrolling = {
    direction = machine.hostname == "omapad" and "down" or "right",
    column_width = 1.0,
    focus_fit_method = 0,
  },
})

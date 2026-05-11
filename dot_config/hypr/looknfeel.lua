-- Change the default Omarchy look'n'feel.

-- https://wiki.hypr.land/Configuring/Basics/Variables/#general
hl.config({
  general = {
    -- No gaps between windows or borders.
    gaps_in = 3,
    gaps_out = 5,
    border_size = 3,

    -- Change to niri-like side-scrolling layout.
    layout = "scrolling",
  },
})

-- https://wiki.hypr.land/Configuring/Basics/Variables/#decoration
hl.config({
  decoration = {
    rounding = 14,
    shadow = {
        enabled = true,
        range = 15,
        render_power = 5,
        -- color = rgba(0a0a1eee), -- #0a0a1e ee
        -- offset = 0 0,
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
        -- new_optimizations = on
    },

    active_opacity = 0.95,
    inactive_opacity = 0.93,
    fullscreen_opacity = 1.0,
  },
})

-- https://wiki.hypr.land/Configuring/Basics/Variables/#animations
hl.config({
  animations = {
    -- Disable all animations.
    enabled = true,
  },
})

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
    -- See only one column per screen instead of two.
    direction = "right",
    column_width = 0.97,
  },
})

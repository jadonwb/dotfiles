-- Keep only your personal input overrides here. Uncommented settings below
-- replace Omarchy's defaults.

-- Keyboard layout and options.
-- See https://wiki.hypr.land/Configuring/Basics/Variables/#input
hl.config({
  input = {
    -- Use multiple keyboard layouts and switch between them with Left Alt + Right Alt.
    -- kb_layout = "us,dk,eu",
    kb_options = "compose:caps,shift:both_capslock_cancel,grp:alts_toggle",

    -- Use a specific keyboard variant if needed (e.g. intl for international keyboards).
    -- kb_variant = "intl",

    -- Change speed of keyboard repeat.
    repeat_rate = 60,
    repeat_delay = 300,

    -- Start with numlock on by default.
    -- numlock_by_default = true,

    -- Increase sensitivity for mouse/trackpad (default: 0).
    sensitivity = 0.6,

    -- Turn off mouse acceleration (default: adaptive).
    -- accel_profile = "flat",

    touchpad = {
      -- Use natural (inverse) scrolling.
      natural_scroll = true,

      -- Use two-finger clicks for right-click instead of lower-right corner.
      clickfinger_behavior = true,

      -- Control the speed of your scrolling.
      scroll_factor = 0.3,

      -- Enable the touchpad while typing.
      disable_while_typing = false,

      -- Left-click-and-drag with three fingers.
      -- drag_3fg = 1,
    },
  },
})

-- App-specific touchpad scroll speeds.
-- o.window("(Alacritty|kitty|foot)", { scroll_touchpad = 1.5 })
-- o.window("com.mitchellh.ghostty", { scroll_touchpad = 0.2 })

-- Enable touchpad gestures for changing workspaces.
-- See https://wiki.hypr.land/Configuring/Advanced-and-Cool/Gestures/

-- Replace this with the same animation as the keybind workspace switch
-- hl.gesture({ fingers = 3, direction = "horizontal", action = "workspace" })

hl.gesture({
  fingers = 3,
  direction = "left",
  action = function()
    local ws = hl.get_active_workspace()
    if ws == nil then
      return
    end

    -- Don't advance past the first empty workspace.
    if #ws:get_windows() == 0 then
      return
    end

    hl.dispatch(hl.dsp.focus({ workspace = "+1" }))
  end,
})

hl.gesture({
  fingers = 3,
  direction = "right",
  action = function()
    hl.dispatch(hl.dsp.focus({ workspace = "-1" }))
  end,
})

-- Enable touchpad gestures for moving focus (helpful on scrolling layout).
hl.gesture({
  fingers = 3,
  direction = "down",
  action = function()
    hl.dispatch(hl.dsp.focus({ direction = "u" }))
  end,
})
hl.gesture({
  fingers = 3,
  direction = "up",
  action = function()
    hl.dispatch(hl.dsp.focus({ direction = "d" }))
  end,
})

-- A dedicated Strata drawer, independent of ordinary file-manager windows.
local window_toggle = require("hypr.window-toggle")
local tag = "strata-drawer"
local pending_until = 0
local launch_generation = 0

-- Placement must happen at map time, before the scrolling layout focuses the
-- window. Keep this rule disabled except while a drawer launch is pending.
local launch_rule = hl.window_rule({
  name = "strata-drawer-launch",
  enabled = false,
  match = { class = "^io\\.github\\.lgse\\.Strata$" },
  float = true,
  center = true,
  size = { "(monitor_w*0.8)", "(monitor_h*0.8)" },
})

hl.on("window.open", function(window)
  if pending_until == 0 or os.time() > pending_until
      or window.class ~= "io.github.lgse.Strata" then
    return
  end
  pending_until = 0
  launch_rule:set_enabled(false)
  hl.dispatch(hl.dsp.window.tag({ tag = "+" .. tag, window = window }))
  if not window.floating then
    hl.dispatch(hl.dsp.window.float({ action = "toggle", window = window }))
  end
  local monitor = window.monitor
  if monitor then
    hl.dispatch(hl.dsp.window.resize({
      x = math.floor(monitor.width / monitor.scale * 0.8),
      y = math.floor(monitor.height / monitor.scale * 0.8),
      window = window,
    }))
  end
  hl.dispatch(hl.dsp.window.center({ window = window }))
end)

return window_toggle.new({
  class = "io.github.lgse.Strata",
  tag = tag,
  special = "special:strata",
  on_show = function(window)
    hl.dispatch(hl.dsp.window.center({ window = window }))
  end,
  launch = function()
    if os.time() <= pending_until then return end
    pending_until = os.time() + 10
    launch_generation = launch_generation + 1
    local generation = launch_generation
    launch_rule:set_enabled(true)
    hl.timer(function()
      if generation ~= launch_generation then return end
      pending_until = 0
      launch_rule:set_enabled(false)
    end, { timeout = 10000, type = "oneshot" })
    hl.exec_cmd("uwsm-app -- strata")
  end,
})

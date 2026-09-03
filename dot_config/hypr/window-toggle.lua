-- Toggle a window by class between the active workspace and a dedicated
-- special workspace:
--   visible on current workspace -> hide to special workspace
--   hidden -> summon to current workspace
--   visible elsewhere -> move to current workspace
--   not running -> launch
--
-- Works for both GUI applications and floating TUIs.
--
-- Usage:
--   window_toggle.new({
--     class = "org.gnome.Calculator",
--     special = "special:calculator",
--     launch = "gnome-calculator",
--   })
--   window_toggle.tui("yazi")
--   window_toggle.tui("btop")

local M = {}

function M.new(config)
  local app_class = config.class
  local special = config.special
  local launch = config.launch

  local function move_to(workspace, window)
    hl.dispatch(hl.dsp.window.move({
      workspace = workspace,
      window = window,
      follow = false,
    }))
  end

  local function focus(window)
    hl.dispatch(hl.dsp.focus({ window = window }))
  end

  return function()
    local ws = hl.get_active_workspace()
    if not ws then
      return
    end

    local current, elsewhere, hidden

    for _, window in ipairs(hl.get_windows() or {}) do
      if window.class == app_class and window.workspace then
        if window.workspace.special then
          hidden = window
        elseif window.workspace.id == ws.id then
          current = window
        else
          elsewhere = window
        end
      end
    end

    if hidden then
      move_to(ws.id, hidden)
      focus(hidden)
    elseif current then
      move_to(special, current)
    elseif elsewhere then
      move_to(ws.id, elsewhere)
      focus(elsewhere)
    else
      hl.dispatch(hl.dsp.exec_cmd(launch))
    end
  end
end

-- Convenience constructor for Omarchy floating TUIs, preserving the
-- org.omarchy.<name> class and omarchy-launch-tui naming conventions.
function M.tui(name)
  return M.new({
    class = "org.omarchy." .. name,
    special = "special:" .. name,
    launch = "omarchy-launch-tui " .. name,
  })
end

return M

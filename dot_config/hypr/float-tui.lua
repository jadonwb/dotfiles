-- Toggle a floating Omarchy TUI:
--   visible on current workspace -> hide to special workspace
--   hidden -> summon to current workspace
--   visible elsewhere -> move to current workspace
--   not running -> launch
--
-- Usage:
--   float_tui.new("yazi")
--   float_tui.new("btop")

local M = {}

function M.new(name)
  local app_class = "org.omarchy." .. name
  local special = "special:" .. name
  local launch = "omarchy-launch-tui " .. name

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

return M

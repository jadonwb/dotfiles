-- Toggle a floating TUI: summon to the current workspace, hide to special, or launch.
--
-- Usage:
--   float_tui.new({
--     class = "org.omarchy.yazi",
--     special = "special:yazi",
--     launch = "omarchy-launch-tui yazi",
--   })

local M = {}

function M.new(opts)
  local app_class = opts.class -- e.g. "org.omarchy.yazi"
  local special = opts.special -- e.g. "special:yazi"
  local launch = opts.launch -- e.g. "omarchy-launch-tui yazi"

  local function find_in(workspace)
    for _, w in ipairs(hl.get_workspace_windows(workspace) or {}) do
      if w.class == app_class then
        return w
      end
    end
    return nil
  end

  local function move_to(workspace, window)
    hl.dispatch(hl.dsp.window.move({ workspace = workspace, window = window, follow = false }))
  end

  local function focus(window)
    hl.dispatch(hl.dsp.focus({ window = window }))
  end

  return function()
    local ws = hl.get_active_workspace()
    if not ws then
      return
    end

    -- Hidden in the special drawer: bring it back to the current workspace.
    local hidden = find_in(special)
    if hidden then
      move_to(ws.id, hidden)
      focus(hidden)
      return
    end

    -- Scan for a visible instance (current workspace or elsewhere).
    local current, elsewhere
    for _, w in ipairs(hl.get_windows() or {}) do
      if w.class == app_class and w.workspace and not w.workspace.special then
        if w.workspace.id == ws.id then
          current = w
        else
          elsewhere = w
        end
      end
    end

    if current then
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

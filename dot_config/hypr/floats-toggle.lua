-- Toggle floating window drawer — stash or restore the active float.
-- Keybinding: SUPER + SHIFT + G

local M = {}

function M.toggle()
  local special = hl.get_workspace_windows("special:floats")
  if special and #special > 0 then
    M.restore()
  else
    M.stash()
  end
end

function M.stash()
  local w = hl.get_active_window()
  if not w or not w.floating then return end

  hl.dispatch(hl.dsp.window.move({
    workspace = "special:floats",
    window    = w,
    follow    = false,
  }))
end

function M.restore()
  local special = hl.get_workspace_windows("special:floats")
  if not special or #special == 0 then return end

  local ws = hl.get_active_workspace()
  local w = special[1]

  hl.dispatch(hl.dsp.window.move({
    workspace = ws.id,
    window    = w,
    follow    = false,
  }))

  hl.dispatch(hl.dsp.focus({ window = w }))
end

return M

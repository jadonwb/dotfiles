-- Omarchy palette adapter. Read data only; themes cannot execute Lua here.
local M = {}
function M.apply(config, wezterm)
  local current = wezterm.home_dir .. "/.local/state/omarchy/current"
  wezterm.add_to_config_reload_watch_list(current .. "/theme.name")
  local file = io.open(current .. "/theme/wezterm.json", "r")
  if not file then return false end
  local raw = file:read("*a")
  file:close()
  local ok, colors = pcall(wezterm.json_parse, raw)
  if not ok or type(colors) ~= "table" then
    wezterm.log_error("Omarchy palette is invalid; keeping the configured fallback")
    return false
  end
  config.colors = colors
  return true
end
return M

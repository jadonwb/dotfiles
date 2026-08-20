local wezterm = require("wezterm")
local config = wezterm.config_builder()

config.color_scheme = "arrowlake_light"

config.use_fancy_tab_bar = false

config.font = wezterm.font("JetBrains Mono", { weight = "Medium" })
config.font_size = 9

config.underline_thickness = "2.75px"

-- config.freetype_load_target = "Light"
-- config.freetype_render_target = "HorizontalLcd"
config.cell_width = 0.95

config.front_end = "WebGpu"

config.window_close_confirmation = "NeverPrompt"

config.keys = require("keymaps")

return config

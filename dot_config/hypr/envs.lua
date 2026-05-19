-- Add new environment variable
-- hl.env("ENV_VAR", "value")

local machine = require("hypr.host")

local function join_path(...)
  local segments = {}

  for i = 1, select("#", ...) do
    local value = select(i, ...)
    if value and value ~= "" then
      table.insert(segments, value)
    end
  end

  return table.concat(segments, ":")
end

if machine.is_work then
  hl.env(
    "PATH",
    join_path(
      os.getenv("HOME") .. "/.local/bin",
      os.getenv("HOME") .. "/.local/share/omarchy/bin",
      os.getenv("HOME") .. "/.nix-profile/bin",
      "/nix/var/nix/profiles/default/bin",
      os.getenv("PATH") or "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    )
  )

  hl.env("NVD_BACKEND", "direct")
  hl.env("WLR_NO_HARDWARE_CURSORS", "1")
  hl.env("GBM_BACKEND", "nvidia-drm")
  hl.env("__GLX_VENDOR_LIBRARY_NAME", "nvidia")
  hl.env("LIBVA_DRIVER_NAME", "nvidia")
  hl.env("__GL_GSYNC_ALLOWED", "1")
  hl.env("__GL_VRR_ALLOWED", "1")
  hl.env("OGL_DEDICATED_HW_STATE_PER_CONTEXT", "ENABLE_ROBUST")
  hl.env("WLR_DRM_NO_ATOMIC", "1")
end

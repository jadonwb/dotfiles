-- Add new environment variable
-- hl.env("ENV_VAR", "value")

local machine = require("hypr.host")

if machine.is_work then
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

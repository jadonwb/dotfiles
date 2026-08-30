-- Extra autostart processes.
-- o.launch_on_start("my-service")
local machine = require("hypr.host")
if machine.hostname == "omapad" then
  o.exec_on_start("systemctl --user start kanata-homerow.service")
end

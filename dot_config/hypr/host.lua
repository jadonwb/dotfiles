local function trim(value)
  return (value:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function read_first_line(path)
  local file = io.open(path, "r")
  if not file then
    return nil
  end

  local value = file:read("*l")
  file:close()

  if not value or value == "" then
    return nil
  end

  return trim(value)
end

local function read_env(name)
  local value = os.getenv(name)
  if not value or value == "" then
    return nil
  end

  return trim(value)
end

local hostname = read_first_line("/proc/sys/kernel/hostname")
  or read_first_line("/etc/hostname")
  or read_env("HOSTNAME")
  or ""

local machine_type = ({
  fwdt = "personal",
  omapad = "personal",
  ws205 = "work",
})[hostname]

return {
  hostname = hostname,
  type = machine_type,
  is_personal = machine_type == "personal",
  is_work = machine_type == "work",
}

// Pure helpers for the minimized-window list. The panel owns the processes and
// the cursor; everything that can be reasoned about from data lives here.
//
// A saved entry is written by bin/omarchy-minimized at minimize time:
//   { address, class, title, workspace: { id, name }, monitor,
//     floating, at: [x, y], size: [w, h], pinned, fullscreen, minimizedAt }
// Clients are the objects from `hyprctl clients -j`. A window minimized by the
// stock command has no entry, only an omarchy-minimized-from-<workspace> tag.

var MINIMIZED_WORKSPACE = "special:minimized"
var ORIGIN_PREFIX = "omarchy-minimized-from-"

function isMinimizedWorkspace(name) {
  return String(name || "") === MINIMIZED_WORKSPACE
}

function parseState(text) {
  try {
    var parsed = JSON.parse(text || "{}")
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return ({})
    var windows = parsed.windows
    return windows && typeof windows === "object" && !Array.isArray(windows) ? windows : ({})
  } catch (e) {
    return ({})
  }
}

// The origin tag is the fallback for windows this plugin did not minimize.
// Stock tags carry a numeric workspace id; a special workspace is sanitized
// into the same tag shape and read back as a special name.
function originFromTags(tags) {
  var list = tags || []
  for (var i = 0; i < list.length; i++) {
    var tag = String(list[i] || "")
    if (tag.indexOf(ORIGIN_PREFIX) !== 0) continue
    var value = tag.slice(ORIGIN_PREFIX.length)
    if (/^[0-9]+$/.test(value)) return { id: Number(value), name: value }
    if (value !== "") return { id: null, name: "special:" + value }
  }
  return null
}

function workspaceOf(client, saved) {
  if (saved && saved.workspace) return saved.workspace
  return originFromTags(client ? client.tags : null)
}

function workspaceText(workspace, strings) {
  if (!workspace) return strings.t("minimized.unknownOrigin")
  var name = String(workspace.name || "")
  if (name.indexOf("special:") === 0) return strings.t("minimized.fromSpecial").arg(name.slice(8))
  if (workspace.id !== undefined && workspace.id !== null) return strings.t("minimized.fromWorkspace").arg(workspace.id)
  if (name !== "") return strings.t("minimized.fromWorkspace").arg(name)
  return strings.t("minimized.unknownOrigin")
}

function ageText(minimizedAt, nowMs, strings) {
  if (!minimizedAt) return ""
  var seconds = Math.max(0, Math.floor((Number(nowMs) - Number(minimizedAt)) / 1000))
  if (seconds < 60) return strings.t("minimized.justNow")
  var minutes = Math.floor(seconds / 60)
  if (minutes < 60) return strings.t("minimized.minutesAgo").arg(minutes)
  var hours = Math.floor(minutes / 60)
  if (hours < 24) return strings.t("minimized.hoursAgo").arg(hours)
  return strings.t("minimized.daysAgo").arg(Math.floor(hours / 24))
}

function buildRows(clients, savedWindows, strings) {
  var rows = []
  var state = savedWindows || ({})
  var list = clients || []

  for (var i = 0; i < list.length; i++) {
    var client = list[i]
    if (!client || !client.workspace || !isMinimizedWorkspace(client.workspace.name)) continue

    var saved = state[client.address] || null
    var workspace = workspaceOf(client, saved)
    var className = String(client.class || client.initialClass || "")
    var floating = saved && saved.floating !== undefined ? saved.floating === true : client.floating === true
    var minimizedAt = saved && saved.minimizedAt ? Number(saved.minimizedAt) : 0

    rows.push({
      address: String(client.address || ""),
      title: String(client.title || className || strings.t("minimized.untitled")),
      className: className,
      floating: floating,
      pinned: client.pinned === true || (saved !== null && saved.pinned === true),
      workspace: workspace,
      hasState: saved !== null,
      minimizedAt: minimizedAt,
      origin: workspaceText(workspace, strings),
      kind: floating ? strings.t("minimized.floating") : strings.t("minimized.tiled")
    })
  }

  // Newest first, the way the list grows while the user works. Windows with no
  // saved entry (stock minimize) sort by class after the ones that have one.
  rows.sort(function(a, b) {
    if (a.minimizedAt !== b.minimizedAt) return b.minimizedAt - a.minimizedAt
    return a.className.localeCompare(b.className) || a.title.localeCompare(b.title)
  })

  return rows
}

if (typeof module !== "undefined") {
  module.exports = {
    MINIMIZED_WORKSPACE: MINIMIZED_WORKSPACE,
    isMinimizedWorkspace: isMinimizedWorkspace,
    parseState: parseState,
    originFromTags: originFromTags,
    ageText: ageText,
    buildRows: buildRows
  }
}

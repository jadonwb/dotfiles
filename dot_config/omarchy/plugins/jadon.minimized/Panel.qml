import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Minimized.js" as Minimized

// A bar icon, a count, and one keyboard-driven list of everything parked on
// special:minimized. A window is minimized by bin/omarchy-minimized, which
// records its workspace, monitor, floating state, and geometry first; this
// panel only reads that record and asks the helper to put the window back.
Panel {
  id: root
  moduleName: "jadon.minimized"
  ipcTarget: "jadon.minimized"

  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string configHome: Quickshell.env("XDG_CONFIG_HOME") || root.home + "/.config"
  readonly property string stateHome: Quickshell.env("XDG_STATE_HOME") || root.home + "/.local/state"
  readonly property string statePath: root.stateHome + "/omarchy/minimized/state.json"
  readonly property string cacheHome: Quickshell.env("XDG_CACHE_HOME") || root.home + "/.cache"
  readonly property string previewDir: root.cacheHome + "/omarchy/minimized"
  readonly property string scriptPath: root.configHome + "/omarchy/plugins/jadon.minimized/bin/omarchy-minimized"

  property int previewRevision: 0

  readonly property color foreground: root.bar ? root.bar.foreground : Commons.Color.foreground
  readonly property color dim: Qt.darker(root.foreground, 1.6)
  readonly property string fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
  readonly property color hoverFill: root.bar ? Style.hoverFillFor(root.foreground, Commons.Color.accent) : "transparent"
  readonly property color selectedFill: root.bar ? Style.selectedFillFor(root.foreground, Commons.Color.accent) : "transparent"

  Commons.Translations { id: strings; directory: Qt.resolvedUrl("i18n") }

  property var savedWindows: ({})
  property string stateRaw: ""
  property var clients: []
  property string clientsSignature: ""
  property bool cursorActive: false
  property string selectedAddress: ""
  property bool gPending: false
  property double nowMs: Date.now()

  readonly property bool alwaysShow: root.setting("alwaysShow", true) === true

  // Hyprland events drive this, so the count stays right with the panel shut.
  readonly property int minimizedCount: {
    var values = Hyprland.toplevels ? Hyprland.toplevels.values : []
    var count = 0
    for (var i = 0; i < values.length; i++) {
      var workspace = values[i] ? values[i].workspace : null
      if (workspace && Minimized.isMinimizedWorkspace(workspace.name)) count++
    }
    return count
  }

  readonly property var rows: {
    var catalog = strings.strings
    return Minimized.buildRows(root.clients, root.savedWindows, strings)
  }

  visible: root.alwaysShow || root.minimizedCount > 0
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // With the icon hidden there is nothing to anchor an empty panel to, and
  // nothing to show anyway.
  function open() {
    if (!root.alwaysShow && root.minimizedCount === 0) return
    root.controller.show()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.open()
  }

  onOpenedChanged: {
    if (root.opened) {
      root.nowMs = Date.now()
      root.cursorActive = false
      root.gPending = false
      root.refreshClients()
      root.refreshPreviews()
      stateFile.reload()
      Qt.callLater(root.clampSelection)
    } else {
      root.gPending = false
    }
  }

  // ------------------------------------------------------------- rows

  function cursorIndex() {
    for (var i = 0; i < root.rows.length; i++)
      if (root.rows[i].address === root.selectedAddress) return i
    return -1
  }

  function rowAt(index) {
    return index >= 0 && index < root.rows.length ? root.rows[index] : null
  }

  function clampSelection() {
    if (root.rows.length === 0) {
      root.selectedAddress = ""
      root.cursorActive = false
      return
    }
    if (root.cursorIndex() < 0) root.selectedAddress = root.rows[0].address
  }

  function moveCursor(delta) {
    if (root.rows.length === 0) return
    root.cursorActive = true
    var index = root.cursorIndex()
    if (index < 0) index = delta > 0 ? -1 : 0
    var next = (index + delta + root.rows.length) % root.rows.length
    root.selectedAddress = root.rows[next].address
  }

  function selectAbsolute(index) {
    if (root.rows.length === 0) return
    root.cursorActive = true
    root.selectedAddress = root.rows[Math.max(0, Math.min(index, root.rows.length - 1))].address
  }

  onRowsChanged: root.clampSelection()

  // ------------------------------------------------------------- data

  function refreshClients() {
    if (clientsProc.running) return
    clientsProc.running = true
  }

  function applyClients(raw) {
    try {
      var parsed = JSON.parse(raw)
      var list = Array.isArray(parsed) ? parsed : []
      var minimized = []
      for (var i = 0; i < list.length; i++) {
        var client = list[i]
        if (client && client.workspace && Minimized.isMinimizedWorkspace(client.workspace.name))
          minimized.push(client)
      }
      // The poll runs every second. Reassigning an identical list would reset
      // the ListView model and rebuild every row under the cursor, so only a
      // real change reaches the view.
      var signature = JSON.stringify(minimized.map(function(client) {
        return [client.address, client.class, client.title, client.floating, client.pinned]
      }))
      if (signature === root.clientsSignature) return
      root.clientsSignature = signature
      root.clients = minimized
    } catch (e) {
      console.warn("minimized", "Ignoring bad client list", e)
    }
  }

  function applyState(raw) {
    // The helper writes the file by rename, which can replace the inode the
    // watch was on. The open tick re-reads it; a raw-text guard keeps an
    // unchanged file from rebuilding the list.
    if (raw === root.stateRaw) return
    root.stateRaw = raw
    root.savedWindows = Minimized.parseState(raw)
  }

  Process {
    id: clientsProc
    command: ["hyprctl", "clients", "-j"]

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyClients(text)
    }

    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: if (text.trim() !== "") console.warn("minimized", text.trim())
    }
  }

  FileView {
    id: stateFile
    path: root.statePath
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: root.applyState(text())
    onLoadFailed: root.applyState("")
    onFileChanged: reload()
  }

  Process {
    id: actionProc
    running: false
    onExited: {
      root.refreshClients()
      refreshSoon.restart()
    }

    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: if (text.trim() !== "") console.warn("minimized", text.trim())
    }
  }

  // Thumbnails are captured at minimize time. This refreshes them when the
  // panel opens, so a window whose content moved on (an update running in the
  // terminal) shows what it looks like now.
  Process {
    id: previewsProc
    command: [root.scriptPath, "previews"]
    running: false
    onExited: root.previewRevision++

    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: if (text.trim() !== "") console.warn("minimized/previews", text.trim())
    }
  }

  Timer {
    id: refreshSoon
    interval: 350
    repeat: false
    onTriggered: root.refreshClients()
  }

  // Only while open: hyprctl is cheap, but it is still a process per tick.
  Timer {
    interval: 1000
    repeat: true
    running: root.opened
    onTriggered: {
      root.refreshClients()
      stateFile.reload()
    }
  }

  // Ages are rendered from this rather than baked into the rows, so a tick
  // refreshes the text without rebuilding the list under the cursor.
  Timer {
    interval: 30000
    repeat: true
    running: root.opened
    onTriggered: root.nowMs = Date.now()
  }

  // ------------------------------------------------------------- actions

  function runAction(args) {
    if (actionProc.running) return
    actionProc.command = [root.scriptPath].concat(args)
    actionProc.running = true
  }

  function restore(row, here) {
    if (!row) return
    root.close()
    root.runAction(["restore", row.address].concat(here ? ["--here"] : []))
  }

  function closeWindow(row) {
    if (!row) return
    Quickshell.execDetached([
      "hyprctl",
      "dispatch",
      "hl.dsp.window.close({ window = \"address:" + row.address + "\" })"
    ])
    refreshSoon.restart()
  }

  function handleText(key, modifiers) {
    if (modifiers & Qt.ControlModifier) {
      if (key === "d" || key === "D") root.moveCursor(5)
      else if (key === "u" || key === "U") root.moveCursor(-5)
      return
    }

    if (key === "g") {
      if (root.gPending) {
        root.selectAbsolute(0)
        root.gPending = false
      } else {
        root.gPending = true
        gTimer.restart()
      }
      return
    }

    root.gPending = false
    if (key === "G") root.selectAbsolute(root.rows.length - 1)
    else if (key === "t" || key === "T") root.restore(root.rowAt(root.cursorIndex()), true)
    else if (key === "r" || key === "R") {
      root.refreshClients()
      stateFile.reload()
    }
  }

  Timer {
    id: gTimer
    interval: 600
    repeat: false
    onTriggered: root.gPending = false
  }

  function iconSource(appId) {
    var name = String(appId || "")
    if (name === "") return ""
    try {
      var entry = DesktopEntries.heuristicLookup(name)
      if (entry && entry.icon) name = entry.icon
    } catch (e) {
      // An app with no desktop entry keeps its class as the icon name.
    }
    return Quickshell.iconPath(name, true) || ""
  }

  function refreshPreviews() {
    if (!previewsProc.running) previewsProc.running = true
  }

  // A version query makes Qt reload the file after a fresh capture instead of
  // serving the thumbnail it already has in its image cache.
  function previewSource(address) {
    return "file://" + root.previewDir + "/" + address + ".png?v=" + root.previewRevision
  }

  // The snapshot's label is the app or the process inside a terminal. Without
  // one (a window minimized by the stock command), the desktop entry names the
  // app; the class is only a last resort.
  function appLabel(row) {
    if (!row) return strings.t("minimized.untitled")
    if (row.app !== "") return row.app
    return root.desktopAppName(row.className)
  }

  function desktopAppName(className) {
    var name = String(className || "")
    if (name === "") return strings.t("minimized.untitled")
    try {
      var entry = DesktopEntries.heuristicLookup(name)
      if (entry && entry.name) return entry.name
    } catch (e) {
      // No entry: name it from the class.
    }
    return root.prettyClassName(name)
  }

  function prettyClassName(className) {
    var name = String(className || "").replace(/\.desktop$/i, "")
    if (name.indexOf("org.omarchy.") === 0) name = name.slice("org.omarchy.".length)
    // Reverse-DNS ids end in the thing a person calls the app:
    // org.wezfurlong.wezterm is "wezterm".
    var parts = name.split(".")
    if (parts.length > 1) name = parts[parts.length - 1]
    name = name.replace(/[-_]+/g, " ").trim()
    if (name === "") return strings.t("minimized.untitled")
    return name.replace(/\b[a-z]/g, function(letter) { return letter.toUpperCase() })
  }

  // ------------------------------------------------------------- bar

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰖮"
    labelText: root.minimizedCount > 0 ? Commons.I18n.formatNumber(root.minimizedCount) : ""
    opacity: root.minimizedCount > 0 ? 1.0 : 0.55
    tooltipText: root.minimizedCount > 0
      ? strings.tn("minimized.barTooltip", root.minimizedCount).arg(Commons.I18n.formatNumber(root.minimizedCount))
      : strings.t("minimized.barTooltipEmpty")
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.MiddleButton) root.refreshClients()
      else root.toggle()
    }
  }

  // ------------------------------------------------------------- panel

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: panel.loadedContent
    contentWidth: panel.fittedContentWidth(Style.space(500))
    contentHeight: panel.fittedContentHeight(panel.loadedContentHeight, Style.space(620))

    content: PanelKeyCatcher {
      id: keyCatcher
      implicitHeight: column.implicitHeight
      anchors.fill: parent
      onMoveRequested: function(dx, dy) { if (dy !== 0) root.moveCursor(dy) }
      onActivateRequested: root.restore(root.rowAt(root.cursorIndex()), false)
      onCloseRequested: root.close()
      onDeleteRequested: root.closeWindow(root.rowAt(root.cursorIndex()))
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(text, modifiers) { root.handleText(text, modifiers) }

      Column {
        id: column
        anchors.fill: parent
        spacing: Style.space(12)

        Item {
          width: parent.width
          implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight)

          Text {
            id: heroIcon
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText
            text: "󰖮"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.display
            opacity: root.rows.length > 0 ? 1.0 : 0.55
          }

          Column {
            id: heroLabels
            anchors.left: heroIcon.right
            anchors.right: parent.right
            anchors.leftMargin: Style.space(12)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: strings.t("minimized.title")
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.heading
              font.bold: true
              elide: Text.ElideRight
            }

            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: strings.tn("minimized.count", root.rows.length).arg(Commons.I18n.formatNumber(root.rows.length))
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }
          }
        }

        PanelSeparator {
          visible: root.rows.length > 0
          height: visible ? implicitHeight : 0
          foreground: root.foreground
        }

        ListView {
          id: listView
          width: parent.width
          height: Math.min(contentHeight, Style.space(480))
          visible: root.rows.length > 0
          spacing: Style.space(4)
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          interactive: contentHeight > height
          currentIndex: root.cursorIndex()
          model: root.rows

          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          onCurrentIndexChanged: if (currentIndex >= 0) Qt.callLater(keepCurrentVisible)
          function keepCurrentVisible() {
            if (currentIndex >= 0) positionViewAtIndex(currentIndex, ListView.Contain)
          }

          delegate: CursorSurface {
            id: rowSurface
            required property var modelData
            required property int index

            readonly property bool chosen: modelData.address === root.selectedAddress
            readonly property string iconSource: root.iconSource(modelData.className)
            readonly property string appLabel: root.appLabel(modelData)
            readonly property string previewSource: root.previewSource(modelData.address)
            readonly property string subtitle: {
              var parts = [modelData.origin, modelData.kind]
              var age = Minimized.ageText(modelData.minimizedAt, root.nowMs, strings)
              if (age !== "") parts.push(age)
              return parts.join("  ·  ")
            }

            width: ListView.view.width
            implicitHeight: contentRow.height + Style.space(12)
            hasCursor: root.cursorActive && chosen
            current: !root.cursorActive && chosen
            foreground: root.foreground
            fill: root.hoverFill
            currentFill: root.selectedFill

            MouseArea {
              anchors.fill: parent
              hoverEnabled: true
              acceptedButtons: Qt.LeftButton | Qt.RightButton
              onEntered: {
                root.selectedAddress = rowSurface.modelData.address
                root.cursorActive = true
              }
              onClicked: function(mouse) {
                if (mouse.button === Qt.RightButton) root.closeWindow(rowSurface.modelData)
                else root.restore(rowSurface.modelData, false)
              }
            }

            Item {
              id: contentRow
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.space(8)
              anchors.rightMargin: Style.space(8)
              height: Math.max(previewFrame.height, titleColumn.implicitHeight)

              Rectangle {
                id: previewFrame
                width: Style.space(192)
                height: Style.space(108)
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                radius: Style.cornerRadius
                color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
                border.width: 1
                border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.16)
                clip: true

                Image {
                  id: previewImage
                  anchors.fill: parent
                  source: rowSurface.previewSource
                  visible: status === Image.Ready
                  fillMode: Image.PreserveAspectCrop
                  asynchronous: true
                  cache: false
                  sourceSize: Qt.size(384, 216)
                }

                Image {
                  anchors.centerIn: parent
                  visible: previewImage.status !== Image.Ready && rowSurface.iconSource !== ""
                  source: rowSurface.iconSource
                  sourceSize: Qt.size(48, 48)
                  asynchronous: true
                  fillMode: Image.PreserveAspectFit
                  opacity: 0.7
                }

                Text {
                  anchors.centerIn: parent
                  visible: previewImage.status !== Image.Ready && rowSurface.iconSource === ""
                  textFormat: Text.PlainText
                  text: "󰖯"
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.iconLarge
                }
              }

              Column {
                id: titleColumn
                anchors.left: previewFrame.right
                anchors.leftMargin: Style.space(14)
                anchors.right: parent.right
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(3)

                Text {
                  width: parent.width
                  textFormat: Text.PlainText
                  text: rowSurface.appLabel
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.subtitle
                  font.bold: true
                  elide: Text.ElideRight
                }

                Text {
                  width: parent.width
                  textFormat: Text.PlainText
                  text: rowSurface.subtitle
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                }
              }
            }
          }
        }

        Column {
          visible: root.rows.length === 0
          width: parent.width
          spacing: Style.space(6)

          Text {
            width: parent.width
            textFormat: Text.PlainText
            text: strings.t("minimized.empty")
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            horizontalAlignment: Text.AlignHCenter
          }

          Text {
            width: parent.width
            textFormat: Text.PlainText
            text: strings.t("minimized.emptyHint")
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
          }
        }

        Text {
          width: parent.width
          visible: root.rows.length > 0
          textFormat: Text.PlainText
          text: strings.t("minimized.hint")
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          horizontalAlignment: Text.AlignRight
          wrapMode: Text.WordWrap
        }
      }
    }
  }
}

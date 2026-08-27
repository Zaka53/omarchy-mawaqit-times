import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Single-file bar widget + panel, in the same style as the built-in
// plugins that don't need a separate BarWidget.qml (e.g. nothing-ear):
// the manifest points its barWidget entry point straight at this file.
Panel {
  id: root
  moduleName: "io.github.zaka53.mawaqit-times"
  ipcTarget: "mawaqit-times"
  manageIpc: false

  property bool editingMosque: false
  property string configuredMosque: ""
  property var report: null
  property string errorMessage: ""
  property bool loading: false
  // Local calendar date ("YYYY-MM-DD") the current `report` was fetched
  // on; compared against Model.todayLocalDate() to cap automatic fetches
  // to once per day.
  property string fetchedDate: ""

  // Bumped every 30s purely so the "next prayer" bindings below re-evaluate
  // between fetches, since nothing else about `report` changes as time passes.
  property int tick: 0

  readonly property bool showEditor: editingMosque || configuredMosque === ""
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property var next: { root.tick; return Model.nextPrayer(root.report, Date.now()) }
  readonly property string barLabel: computeBarLabel()
  readonly property string barTooltip: computeBarTooltip()
  readonly property string heroMeta: computeHeroMeta()

  // Resolved from this file's own location, so the plugin keeps working
  // under any checkout path.
  readonly property string scriptPath:
    decodeURIComponent(Qt.resolvedUrl("scripts/mawaqit_times.py").toString().replace(/^file:\/\//, ""))
  readonly property string settingsIoScript:
    decodeURIComponent(Qt.resolvedUrl("scripts/settings_io.py").toString().replace(/^file:\/\//, ""))
  readonly property string settingsPath:
    Quickshell.env("HOME") + "/.local/state/omarchy/settings/mawaqit-times.json"

  // Caps how much of the fetch helper's stdout we'll act on. The helper's
  // own HTTP read is bounded (see mawaqit_times.py), so real output is at
  // most a few KB; this is a defensive backstop, not the primary limit.
  readonly property int maxHelperOutputChars: 1048576

  function computeBarLabel() {
    root.tick
    if (!root.report) return "Prayer times"
    var n = root.next
    return n ? (n.label + " " + n.time) : "Prayer times"
  }

  function computeBarTooltip() {
    root.tick
    if (root.configuredMosque === "") return "Click to set your mosque"
    if (!root.report) return root.errorMessage !== "" ? root.errorMessage : "Loading prayer times…"
    var n = root.next
    if (!n) return root.report.name
    return root.report.name + " — " + n.label + (n.tomorrow ? " tomorrow" : "") + " in " + Model.formatCountdown(n.minutesUntil)
  }

  function computeHeroMeta() {
    root.tick
    if (root.configuredMosque === "") return ""
    if (!root.report) return root.errorMessage !== "" ? root.errorMessage : (root.loading ? "Loading…" : "")
    var n = root.next
    if (!n) return ""
    return n.label + (n.tomorrow ? " tomorrow" : "") + " in " + Model.formatCountdown(n.minutesUntil)
  }

  // `force` bypasses the once-a-day cache (used for manual refreshes and
  // for a newly configured mosque); otherwise a fetch only happens when
  // `fetchedDate` isn't today.
  function refresh(force) {
    if (root.configuredMosque === "" || fetchProc.running) return
    if (!force && root.fetchedDate === Model.todayLocalDate()) return
    root.loading = true
    fetchProc.command = ["/usr/bin/python3", root.scriptPath, root.configuredMosque]
    fetchProc.running = true
  }

  // Settings persistence goes through settings_io.py rather than a raw
  // FileView: the path is fixed and predictable, so reads/writes are routed
  // through a helper that refuses to follow a symlink planted there, won't
  // block on a FIFO planted there, and bounds how much it will read.
  function loadSettings() {
    if (settingsReadProc.running) return
    settingsReadProc.command = ["/usr/bin/python3", root.settingsIoScript, "read", root.settingsPath]
    settingsReadProc.running = true
  }

  function saveSettings(jsonText) {
    if (settingsWriteProc.running) return
    settingsWriteProc.command = ["/usr/bin/python3", root.settingsIoScript, "write", root.settingsPath, jsonText]
    settingsWriteProc.running = true
  }

  function startEditingMosque() {
    editingMosque = true
    Qt.callLater(function() {
      mosqueField.text = root.configuredMosque
      mosqueField.selectAll()
      mosqueField.forceActiveFocus()
    })
  }

  function cancelEditingMosque() {
    if (root.configuredMosque === "") return
    editingMosque = false
    Qt.callLater(function() { if (keyCatcher) keyCatcher.forceActiveFocus() })
  }

  function commitMosque(text) {
    var value = String(text || "").trim()
    editingMosque = false
    if (value === root.configuredMosque) return
    root.configuredMosque = value
    root.report = null
    root.errorMessage = ""
    root.fetchedDate = ""
    root.saveSettings(JSON.stringify({ mosque: value, fetchedDate: "", report: null }))
    Qt.callLater(function() { root.refresh(true) })
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: if (opened) {
    root.loadSettings()
    root.refresh()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  Process {
    id: settingsReadProc
    running: false
    command: []
    stdout: StdioCollector { id: settingsReadStdout; waitForEnd: true }
    onExited: function(exitCode) {
      var raw = String(settingsReadStdout.text || "").trim()
      var result = null
      try {
        result = JSON.parse(raw)
      } catch (e) {
        result = null
      }
      if (!result || !result.ok) {
        root.configuredMosque = ""
        root.fetchedDate = ""
        root.report = null
        return
      }
      var parsed = Model.parseSettingsFile(result.exists ? result.text : "")
      root.configuredMosque = parsed.mosque
      root.fetchedDate = parsed.fetchedDate
      root.report = parsed.report
    }
  }

  Process {
    id: settingsWriteProc
    running: false
    command: []
    // Without a stdout collector Quickshell never fully reaps the process,
    // so `running` gets stuck true after the first write and every later
    // saveSettings() call silently no-ops on the running-guard.
    stdout: StdioCollector { id: settingsWriteStdout; waitForEnd: true }
    onExited: function(exitCode) {
      var result = null
      try {
        result = JSON.parse(String(settingsWriteStdout.text || "").trim())
      } catch (e) {
        result = null
      }
      if (!result || !result.ok) console.warn("mawaqit-times: failed to save settings")
    }
  }

  // The first read can race shell startup, leaving a stored mosque unhonored
  // until the next write (same fix the weather plugin uses for its location
  // file). A no-op once the first read already landed correctly.
  Timer {
    interval: 1500
    running: true
    onTriggered: root.loadSettings()
  }

  Timer {
    interval: 30000
    running: true
    repeat: true
    onTriggered: root.tick++
  }

  Process {
    id: fetchProc
    running: false
    command: []
    stdout: StdioCollector { id: fetchStdout; waitForEnd: true }
    stderr: StdioCollector { id: fetchStderr; waitForEnd: true }
    onExited: function(exitCode) {
      root.loading = false
      var raw = String(fetchStdout.text || "").trim()
      if (raw === "") {
        root.errorMessage = String(fetchStderr.text || "").trim() || "The prayer-times helper produced no output"
        return
      }
      if (raw.length > root.maxHelperOutputChars) {
        root.errorMessage = "The prayer-times helper produced too much output"
        return
      }
      var parsed
      try {
        parsed = JSON.parse(raw)
      } catch (e) {
        root.errorMessage = "Could not parse the prayer-times helper's output"
        return
      }
      if (!parsed.ok) {
        root.errorMessage = parsed.error || "Could not fetch prayer times"
        return
      }
      root.errorMessage = ""
      root.report = parsed
      root.fetchedDate = Model.todayLocalDate()
      root.saveSettings(JSON.stringify({
        mosque: root.configuredMosque,
        fetchedDate: root.fetchedDate,
        report: parsed
      }))
    }
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { root.refresh(true); return "ok" }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.barLabel
    tooltipText: root.barTooltip

    onPressed: function(b) {
      if (b === Qt.MiddleButton) root.refresh(true)
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(320))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: root.showEditor
      onReturnRequested: root.startEditingMosque()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        width: parent.width
        spacing: Style.space(14)

        PanelHero {
          width: parent.width
          title: root.report ? root.report.name : (root.configuredMosque !== "" ? root.configuredMosque : "Mawaqit Prayer Times")
          meta: root.heroMeta
          foreground: root.foreground
          fontFamily: root.fontFamily
        }

        // ---- Mosque editor: shown until a mosque is configured, or while
        //      the name in the hero is clicked to change it.
        Column {
          visible: root.showEditor
          width: parent.width
          spacing: Style.space(8)

          Text {
            text: "Mosque slug or mawaqit.net link"
            color: Qt.darker(root.foreground, 1.4)
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          TextField {
            id: mosqueField
            width: parent.width
            placeholderText: "e.g. islamic-center-brooklyn"
            foreground: root.foreground
            font.family: root.fontFamily
            text: root.configuredMosque

            Keys.onPressed: function(event) {
              if (event.key === Qt.Key_Escape) {
                root.cancelEditingMosque()
                event.accepted = true
              } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                root.commitMosque(mosqueField.text)
                event.accepted = true
              }
            }
          }

          Text {
            visible: root.configuredMosque !== ""
            text: "Enter to save, Escape to cancel"
            color: Qt.darker(root.foreground, 1.6)
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }

        Row {
          visible: !root.showEditor
          spacing: Style.space(6)

          TapHandler { onTapped: root.startEditingMosque() }
          HoverHandler { cursorShape: Qt.PointingHandCursor }

          Text {
            text: "✎ change mosque"
            color: Qt.darker(root.foreground, 1.5)
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }
        }

        Rectangle {
          visible: !root.showEditor && (root.report !== null)
          width: parent.width
          height: Style.spacing.hairline
          color: root.foreground
          opacity: 0.12
        }

        Text {
          visible: !root.showEditor && root.errorMessage !== "" && !root.report
          width: parent.width
          text: root.errorMessage
          color: root.bar ? root.bar.urgent : Color.urgent
          wrapMode: Text.WordWrap
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
        }

        Text {
          visible: !root.showEditor && root.loading && !root.report
          text: "Fetching prayer times…"
          color: Qt.darker(root.foreground, 1.5)
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          font.italic: true
        }

        Column {
          visible: !root.showEditor && root.report !== null
          width: parent.width
          spacing: Style.space(6)

          Repeater {
            model: root.report ? root.report.labels : []

            PrayerRow {
              required property var modelData
              required property int index
              width: parent.width
              label: modelData
              time: root.report.times[index]
              highlighted: root.next !== null && root.next.index === index
              foreground: root.foreground
              fontFamily: root.fontFamily
            }
          }
        }

        Column {
          visible: !root.showEditor && root.report !== null
          width: parent.width
          spacing: Style.space(6)

          PrayerRow {
            visible: root.report && root.report.shuruq !== ""
            width: parent.width
            label: "Sunrise"
            time: root.report ? root.report.shuruq : ""
            dim: true
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          PrayerRow {
            visible: root.report && root.report.jumua !== ""
            width: parent.width
            label: "Jumu'a"
            time: root.report ? root.report.jumua : ""
            dim: true
            foreground: root.foreground
            fontFamily: root.fontFamily
          }
        }
      }
    }
  }

  // One prayer/sunrise/jumu'a row: label on the left, time on the right.
  // `highlighted` marks the next upcoming prayer; `dim` marks secondary rows
  // (sunrise, jumu'a) that aren't part of the five daily prayers.
  component PrayerRow: Item {
    id: prayerRow
    property string label: ""
    property string time: ""
    property bool highlighted: false
    property bool dim: false
    property color foreground: Color.foreground
    property string fontFamily: Style.font.family

    implicitHeight: Math.max(labelText.implicitHeight, timeText.implicitHeight)

    Text {
      id: labelText
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      text: prayerRow.label
      color: prayerRow.highlighted ? Color.accent : (prayerRow.dim ? Qt.darker(prayerRow.foreground, 1.5) : prayerRow.foreground)
      font.family: prayerRow.fontFamily
      font.pixelSize: prayerRow.dim ? Style.font.bodySmall : Style.font.body
      font.bold: prayerRow.highlighted
    }

    Text {
      id: timeText
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      text: prayerRow.time
      color: prayerRow.highlighted ? Color.accent : (prayerRow.dim ? Qt.darker(prayerRow.foreground, 1.5) : prayerRow.foreground)
      font.family: prayerRow.fontFamily
      font.pixelSize: prayerRow.dim ? Style.font.bodySmall : Style.font.body
      font.bold: prayerRow.highlighted
    }
  }
}

// Pure helpers for the Mawaqit prayer-times widget: settings-file parsing
// and the "which prayer is next" arithmetic. Kept separate from the QML so
// the time math can be reasoned about without the panel's UI state.

function parseSettingsFile(text) {
  var raw = String(text || "").trim()
  if (raw === "") return { mosque: "" }
  try {
    var parsed = JSON.parse(raw)
    return { mosque: typeof parsed.mosque === "string" ? parsed.mosque : "" }
  } catch (e) {
    return { mosque: "" }
  }
}

function minutesFromHHMM(value) {
  var match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim())
  if (!match) return NaN
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10)
}

// Minutes since local midnight, projected forward from the moment the
// report was fetched. The python helper resolves "now" against the
// mosque's own timezone, so this stays correct even when it differs from
// the machine's local timezone; it is only the elapsed-since-fetch part
// that runs on the client clock.
function currentDayMinutes(report, nowMs) {
  var elapsed = Math.floor((nowMs - report.fetchedAtEpochMs) / 60000)
  var minutes = (report.nowLocalMinutes + elapsed) % 1440
  return minutes < 0 ? minutes + 1440 : minutes
}

// Returns null when the report has no usable times, otherwise
// { index, label, time, minutesUntil, tomorrow }.
function nextPrayer(report, nowMs) {
  if (!report || !Array.isArray(report.times) || report.times.length !== 5) return null

  var dayMinutes = currentDayMinutes(report, nowMs)
  for (var i = 0; i < report.times.length; i++) {
    var minutes = minutesFromHHMM(report.times[i])
    if (!isNaN(minutes) && minutes > dayMinutes) {
      return { index: i, label: report.labels[i], time: report.times[i], minutesUntil: minutes - dayMinutes, tomorrow: false }
    }
  }

  var fajr = minutesFromHHMM(report.times[0])
  if (isNaN(fajr)) return null
  return { index: 0, label: report.labels[0], time: report.times[0], minutesUntil: (1440 - dayMinutes) + fajr, tomorrow: true }
}

function formatCountdown(minutesUntil) {
  var minutes = Math.max(0, Math.round(minutesUntil))
  if (minutes === 0) return "now"
  var hours = Math.floor(minutes / 60)
  var rest = minutes % 60
  if (hours === 0) return rest + "m"
  return hours + "h" + (rest > 0 ? " " + rest + "m" : "")
}

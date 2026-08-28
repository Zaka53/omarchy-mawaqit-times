// Pure helpers for the Mawaqit prayer-times widget: settings-file parsing
// and the "which prayer is next" arithmetic. Kept separate from the QML so
// the time math can be reasoned about without the panel's UI state.

// Same bound mawaqit_times.py applies to a mosque page's "name" field via
// sanitize_display(), reused here so a plain slug and a full mawaqit.net
// URL both fit comfortably while anything wildly oversized is rejected.
var MAX_MOSQUE_LEN = 200
var MOSQUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-\/:?=&%]*$/

var MAX_NAME_LEN = 200
var MAX_LABEL_LEN = 64
var MAX_AUX_LEN = 64
var MIN_VALID_EPOCH_MS = Date.UTC(2020, 0, 1)
var ONE_DAY_MS = 24 * 60 * 60 * 1000

function isBoundedPlainText(value, maxLen) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLen && !/[<>\r\n\t]/.test(value)
}

function isValidTimeString(value) {
  return typeof value === "string" && /^([01]?\d|2[0-3]):[0-5]\d$/.test(value)
}

// Returns "" for an empty/unconfigured mosque (a legitimate value), or null
// if `value` is non-empty but doesn't look like a safe slug/URL. `value`
// ends up both as a Process argv element and as a URL path component in
// mawaqit_times.py, so this bounds its length and restricts it to a
// conservative character set rather than trusting it verbatim.
function validateMosque(value) {
  if (typeof value !== "string") return null
  if (value === "") return ""
  if (value.length > MAX_MOSQUE_LEN) return null
  return MOSQUE_PATTERN.test(value) ? value : null
}

// Strict schema check for a prayer-time report, applied identically to a
// freshly-fetched report (before it's trusted or persisted) and to a report
// reloaded from the cached settings file. Any field that doesn't match
// results in the whole report being rejected (returns null) rather than
// partially trusting it, since this is the last gate before the data
// reaches QML (Repeater model counts, Text bindings) unsanitized.
function validateReport(report) {
  if (!report || typeof report !== "object") return null

  if (!isBoundedPlainText(report.name, MAX_NAME_LEN)) return null

  if (!Array.isArray(report.labels) || report.labels.length !== 5) return null
  for (var i = 0; i < report.labels.length; i++) {
    if (!isBoundedPlainText(report.labels[i], MAX_LABEL_LEN)) return null
  }

  if (!Array.isArray(report.times) || report.times.length !== 5) return null
  for (var j = 0; j < report.times.length; j++) {
    if (!isValidTimeString(report.times[j])) return null
  }

  if (typeof report.shuruq !== "string" || (report.shuruq !== "" && !isValidTimeString(report.shuruq))) return null
  if (typeof report.jumua !== "string" || (report.jumua !== "" && !isValidTimeString(report.jumua))) return null

  if (typeof report.fetchedAtEpochMs !== "number" || !isFinite(report.fetchedAtEpochMs)) return null
  if (report.fetchedAtEpochMs < MIN_VALID_EPOCH_MS || report.fetchedAtEpochMs > Date.now() + ONE_DAY_MS) return null

  if (typeof report.nowLocalMinutes !== "number" || !Number.isInteger(report.nowLocalMinutes)) return null
  if (report.nowLocalMinutes < 0 || report.nowLocalMinutes >= 1440) return null

  if (report.slug !== undefined && !isBoundedPlainText(report.slug, MAX_AUX_LEN)) return null
  if (report.timezone !== undefined && !isBoundedPlainText(report.timezone, MAX_AUX_LEN)) return null

  return report
}

function parseSettingsFile(text) {
  var raw = String(text || "").trim()
  if (raw === "") return { mosque: "", fetchedDate: "", report: null }
  try {
    var parsed = JSON.parse(raw)
    var mosque = validateMosque(typeof parsed.mosque === "string" ? parsed.mosque : "")
    return {
      mosque: mosque === null ? "" : mosque,
      fetchedDate: typeof parsed.fetchedDate === "string" ? parsed.fetchedDate : "",
      report: validateReport(parsed.report)
    }
  } catch (e) {
    return { mosque: "", fetchedDate: "", report: null }
  }
}

// Local (device) calendar date as "YYYY-MM-DD", used purely as a cache
// freshness flag for the once-a-day mawaqit.net fetch.
function todayLocalDate() {
  var d = new Date()
  var m = String(d.getMonth() + 1).padStart(2, "0")
  var day = String(d.getDate()).padStart(2, "0")
  return d.getFullYear() + "-" + m + "-" + day
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

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

// Characters no displayed field may contain: markup-capable angle brackets,
// C0/C1 control characters (incl. CR/LF/TAB/NUL), the Unicode line and
// paragraph separators (which break a line even in Text.PlainText), and the
// invisible bidi-control / zero-width characters that can reorder or hide
// the surrounding text (e.g. U+202E RIGHT-TO-LEFT OVERRIDE). ZWNJ/ZWJ
// (U+200C/U+200D) stay allowed, since Persian and other scripts use them
// in ordinary words. mawaqit_times.py strips the same set from fresh data
// (see sanitize_display), so only a planted cache can trip this.
var UNSAFE_TEXT = /[<>\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/

function isBoundedPlainText(value, maxLen) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLen && !UNSAFE_TEXT.test(value)
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
//
// On success it returns a new object holding only the known fields (arrays
// copied too), never the input itself: anything else the input carried
// (the helper's "ok" flag, or arbitrary extra keys in a planted cache) is
// dropped here instead of being kept in memory and written back to disk.
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

  // Optional: a report cached before iqama support existed simply has no
  // `iqama` field, and a mosque that publishes no iqama calendar sends five
  // empty strings, so both stay valid and just render without iqama times.
  if (report.iqama !== undefined) {
    if (!Array.isArray(report.iqama) || report.iqama.length !== 5) return null
    for (var k = 0; k < report.iqama.length; k++) {
      var iqama = report.iqama[k]
      if (typeof iqama !== "string") return null
      if (iqama !== "" && !isValidTimeString(iqama)) return null
    }
  }

  if (typeof report.shuruq !== "string" || (report.shuruq !== "" && !isValidTimeString(report.shuruq))) return null
  if (typeof report.jumua !== "string" || (report.jumua !== "" && !isValidTimeString(report.jumua))) return null

  if (typeof report.fetchedAtEpochMs !== "number" || !isFinite(report.fetchedAtEpochMs)) return null
  if (report.fetchedAtEpochMs < MIN_VALID_EPOCH_MS || report.fetchedAtEpochMs > Date.now() + ONE_DAY_MS) return null

  if (typeof report.nowLocalMinutes !== "number" || !Number.isInteger(report.nowLocalMinutes)) return null
  if (report.nowLocalMinutes < 0 || report.nowLocalMinutes >= 1440) return null

  // The slug is derived from the configured mosque value, so it shares that
  // bound rather than the tighter one used for the timezone.
  if (report.slug !== undefined && !isBoundedPlainText(report.slug, MAX_MOSQUE_LEN)) return null
  if (report.timezone !== undefined && !isBoundedPlainText(report.timezone, MAX_AUX_LEN)) return null

  var clean = {
    name: report.name,
    labels: report.labels.slice(),
    times: report.times.slice(),
    shuruq: report.shuruq,
    jumua: report.jumua,
    fetchedAtEpochMs: report.fetchedAtEpochMs,
    nowLocalMinutes: report.nowLocalMinutes
  }
  if (report.iqama !== undefined) clean.iqama = report.iqama.slice()
  if (report.slug !== undefined) clean.slug = report.slug
  if (report.timezone !== undefined) clean.timezone = report.timezone
  return clean
}

// The cache-freshness date persisted next to the report: "YYYY-MM-DD" (the
// format todayLocalDate() writes), or "" for anything else.
function validateFetchedDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ""
}

// ---- Saved mosques: a short list of { mosque, name } entries the user can
// switch between from the panel. `mosque` is the slug or link exactly as
// entered (it's what gets passed to the fetch helper); `name` is the mosque's
// display name from its report, or "" when it wasn't known at save time.

var MAX_SAVED_MOSQUES = 20

// Identity used to tell whether two mosque values point at the same mosque,
// so a bare slug and its full mawaqit.net link aren't saved twice. Mirrors
// mosque_slug() in mawaqit_times.py, plus case-folding since slugs are
// lowercase on mawaqit.net.
function mosqueKey(value) {
  var raw = String(value || "").trim()
  var match = /mawaqit\.net\/[a-z]{2}\/(?:m\/)?([^\/?#]+)/.exec(raw)
  return (match ? match[1] : raw).toLowerCase()
}

// Strict check for a saved-mosque list loaded from disk. Unlike a report,
// one bad entry only drops that entry: the rest of the list is still the
// user's own data and worth keeping. Duplicates (by mosqueKey) and anything
// past MAX_SAVED_MOSQUES are dropped too.
function validateSavedMosques(list) {
  if (!Array.isArray(list)) return []
  var result = []
  var seen = {}
  for (var i = 0; i < list.length && result.length < MAX_SAVED_MOSQUES; i++) {
    var entry = list[i]
    if (!entry || typeof entry !== "object") continue
    var mosque = validateMosque(entry.mosque)
    if (!mosque) continue
    var key = mosqueKey(mosque)
    if (seen[key]) continue
    seen[key] = true
    var name = isBoundedPlainText(entry.name, MAX_NAME_LEN) ? entry.name : ""
    result.push({ mosque: mosque, name: name })
  }
  return result
}

function isMosqueSaved(list, mosque) {
  if (!Array.isArray(list) || !mosque) return false
  var key = mosqueKey(mosque)
  for (var i = 0; i < list.length; i++) {
    if (mosqueKey(list[i].mosque) === key) return true
  }
  return false
}

// Returns a new list with `mosque` added at the end, or the existing entry
// for it renamed in place. Returns the list unchanged when `mosque` isn't
// valid or the list is already full.
function addSavedMosque(list, mosque, name) {
  var current = validateSavedMosques(list)
  var value = validateMosque(mosque)
  if (!value) return current
  var cleanName = isBoundedPlainText(name, MAX_NAME_LEN) ? name : ""
  var key = mosqueKey(value)
  for (var i = 0; i < current.length; i++) {
    if (mosqueKey(current[i].mosque) === key) {
      if (cleanName !== "") current[i] = { mosque: current[i].mosque, name: cleanName }
      return current
    }
  }
  if (current.length >= MAX_SAVED_MOSQUES) return current
  current.push({ mosque: value, name: cleanName })
  return current
}

// Returns a new list with `mosque` (matched by mosqueKey) removed.
function removeSavedMosque(list, mosque) {
  var key = mosqueKey(mosque)
  return validateSavedMosques(list).filter(function(entry) { return mosqueKey(entry.mosque) !== key })
}

// What a saved entry shows in the panel: its name, or the slug/link itself
// when no name was known when it was saved.
function savedMosqueLabel(entry) {
  return entry && entry.name ? entry.name : (entry ? entry.mosque : "")
}

function parseSettingsFile(text) {
  var raw = String(text || "").trim()
  if (raw === "") return { mosque: "", fetchedDate: "", report: null, saved: [] }
  try {
    var parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object")
    var mosque = validateMosque(typeof parsed.mosque === "string" ? parsed.mosque : "")
    var report = validateReport(parsed.report)
    return {
      mosque: mosque === null ? "" : mosque,
      // A rejected report also drops its fetch date, so the once-a-day
      // cache doesn't keep the panel empty until tomorrow: the next
      // refresh() sees no fresh data and fetches again.
      fetchedDate: report ? validateFetchedDate(parsed.fetchedDate) : "",
      report: report,
      saved: validateSavedMosques(parsed.saved)
    }
  } catch (e) {
    return { mosque: "", fetchedDate: "", report: null, saved: [] }
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

// Display label for the shuruq (sunrise) time, shared by the panel row and
// the "next" countdown so both name it the same way.
var SHURUQ_LABEL = "Shuruk"

// Returns null when the report has no usable times, otherwise
// { index, label, time, minutesUntil, tomorrow, shuruq }. Shuruq counts as
// a step in the day's sequence (Fajr, Shuruk, Dhuhr, ...) even though it
// isn't a prayer: when it's the next upcoming time it's returned with
// `shuruq: true` and `index: -1`, since it has no slot in report.times.
function nextPrayer(report, nowMs) {
  if (!report || !Array.isArray(report.times) || report.times.length !== 5) return null

  var dayMinutes = currentDayMinutes(report, nowMs)
  var shuruq = minutesFromHHMM(report.shuruq)
  for (var i = 0; i < report.times.length; i++) {
    var minutes = minutesFromHHMM(report.times[i])
    if (!isNaN(minutes) && minutes > dayMinutes) {
      if (!isNaN(shuruq) && shuruq > dayMinutes && shuruq < minutes) {
        return { index: -1, label: SHURUQ_LABEL, time: report.shuruq, minutesUntil: shuruq - dayMinutes, tomorrow: false, shuruq: true }
      }
      return { index: i, label: report.labels[i], time: report.times[i], minutesUntil: minutes - dayMinutes, tomorrow: false, shuruq: false }
    }
  }

  var fajr = minutesFromHHMM(report.times[0])
  if (isNaN(fajr)) return null
  return { index: 0, label: report.labels[0], time: report.times[0], minutesUntil: (1440 - dayMinutes) + fajr, tomorrow: true, shuruq: false }
}

// Iqama time for prayer `index`, or "" when the report predates iqama
// support or the mosque publishes no value for that prayer. Keeps the QML
// binding from having to guard the field's absence itself.
function iqamaFor(report, index) {
  if (!report || !Array.isArray(report.iqama)) return ""
  var value = report.iqama[index]
  return typeof value === "string" ? value : ""
}

var MAX_MESSAGE_LEN = 300

// Makes a message from outside the plugin (the helper's error text, its
// stderr) safe to show: no markup-capable angle brackets, control
// characters collapsed to spaces, and a bounded length. Anything that isn't
// a string becomes "", so a caller can fall back to its own wording.
function displayMessage(value) {
  if (typeof value !== "string") return ""
  var text = value.replace(/[<>\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, "")
    .replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim()
  return text.length > MAX_MESSAGE_LEN ? text.slice(0, MAX_MESSAGE_LEN - 1) + "…" : text
}

function formatCountdown(minutesUntil) {
  var minutes = Math.max(0, Math.round(minutesUntil))
  if (minutes === 0) return "now"
  var hours = Math.floor(minutes / 60)
  var rest = minutes % 60
  if (hours === 0) return rest + "m"
  return hours + "h" + (rest > 0 ? " " + rest + "m" : "")
}

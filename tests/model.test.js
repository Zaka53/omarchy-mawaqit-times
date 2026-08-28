// Tests for Model.js, the plugin's pure settings-parsing / prayer-time
// helper functions. Model.js is a plain QML JS module (no module.exports,
// since QML's `import "Model.js" as Model` expects a flat script whose
// top-level function declarations become properties of the imported
// namespace) so it's loaded here by evaluating its source directly rather
// than via require().
//
// Run with: node --test tests/

const fs = require("node:fs");
const path = require("node:path");
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

function loadModel() {
  const src = fs.readFileSync(path.join(__dirname, "..", "Model.js"), "utf8");
  const exportedNames = [
    "parseSettingsFile",
    "validateReport",
    "validateMosque",
    "todayLocalDate",
    "minutesFromHHMM",
    "currentDayMinutes",
    "nextPrayer",
    "formatCountdown"
  ];
  const body = src + "\n;return {" + exportedNames.map(n => n).join(",") + "};";
  return new Function(body)();
}

const Model = loadModel();

function makeReport(overrides) {
  return Object.assign({
    ok: true,
    slug: "islamic-center-brooklyn",
    name: "Islamic Center of Brooklyn",
    timezone: "America/New_York",
    labels: ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"],
    times: ["05:12", "13:05", "16:45", "19:58", "21:20"],
    shuruq: "06:16",
    jumua: "13:00",
    fetchedAtEpochMs: Date.now(),
    nowLocalMinutes: 275
  }, overrides || {});
}

describe("validateMosque", () => {
  test("accepts a bare slug", () => {
    assert.equal(Model.validateMosque("islamic-center-brooklyn"), "islamic-center-brooklyn");
  });

  test("accepts a full mawaqit.net URL", () => {
    const url = "https://mawaqit.net/en/islamic-center-brooklyn";
    assert.equal(Model.validateMosque(url), url);
  });

  test("accepts an empty string as 'unconfigured'", () => {
    assert.equal(Model.validateMosque(""), "");
  });

  test("rejects a value longer than 200 characters", () => {
    assert.equal(Model.validateMosque("a".repeat(500)), null);
  });

  test("rejects whitespace", () => {
    assert.equal(Model.validateMosque("evil thing; rm -rf"), null);
  });

  test("rejects angle brackets", () => {
    assert.equal(Model.validateMosque("<img src=x>"), null);
  });

  test("rejects embedded newlines (header/log injection shape)", () => {
    assert.equal(Model.validateMosque("slug\nHost: evil"), null);
  });

  test("rejects backticks", () => {
    assert.equal(Model.validateMosque("slug`whoami`"), null);
  });

  test("rejects non-string input", () => {
    assert.equal(Model.validateMosque(12345), null);
    assert.equal(Model.validateMosque(null), null);
    assert.equal(Model.validateMosque(undefined), null);
  });
});

describe("validateReport", () => {
  test("accepts a well-formed report", () => {
    assert.notEqual(Model.validateReport(makeReport()), null);
  });

  test("accepts empty shuruq/jumua (fields the mosque page omitted)", () => {
    assert.notEqual(Model.validateReport(makeReport({ shuruq: "", jumua: "" })), null);
  });

  test("rejects null / non-object / array reports", () => {
    assert.equal(Model.validateReport(null), null);
    assert.equal(Model.validateReport(undefined), null);
    assert.equal(Model.validateReport("hello"), null);
    assert.equal(Model.validateReport([1, 2, 3]), null);
  });

  test("rejects a labels array that isn't exactly length 5", () => {
    assert.equal(Model.validateReport(makeReport({ labels: ["Fajr", "Dhuhr"] })), null);
    assert.equal(Model.validateReport(makeReport({ labels: ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha", "Extra"] })), null);
  });

  test("rejects an oversized labels array (Repeater fanout)", () => {
    assert.equal(Model.validateReport(makeReport({ labels: new Array(100000).fill("x") })), null);
  });

  test("rejects a times array that isn't exactly length 5", () => {
    assert.equal(Model.validateReport(makeReport({ times: ["05:12", "13:05", "16:45", "19:58"] })), null);
  });

  test("rejects markup in name (Text.AutoText injection)", () => {
    assert.equal(Model.validateReport(makeReport({ name: '<img src="http://attacker.example/x">' })), null);
  });

  test("rejects markup in a label", () => {
    assert.equal(Model.validateReport(makeReport({ labels: ["<img src=x>", "Dhuhr", "Asr", "Maghrib", "Isha"] })), null);
  });

  test("rejects markup in shuruq/jumua", () => {
    assert.equal(Model.validateReport(makeReport({ shuruq: "<script>" })), null);
    assert.equal(Model.validateReport(makeReport({ jumua: "<script>" })), null);
  });

  test("rejects embedded control characters in name", () => {
    assert.equal(Model.validateReport(makeReport({ name: "Evil\r\nSet-Cookie: x" })), null);
  });

  test("rejects an oversized name", () => {
    assert.equal(Model.validateReport(makeReport({ name: "a".repeat(10000) })), null);
  });

  test("rejects malformed time strings", () => {
    assert.equal(Model.validateReport(makeReport({ times: ["not-a-time", "13:05", "16:45", "19:58", "21:20"] })), null);
    assert.equal(Model.validateReport(makeReport({ times: ["<b>05:12</b>", "13:05", "16:45", "19:58", "21:20"] })), null);
  });

  test("rejects non-finite or out-of-range fetchedAtEpochMs", () => {
    assert.equal(Model.validateReport(makeReport({ fetchedAtEpochMs: NaN })), null);
    assert.equal(Model.validateReport(makeReport({ fetchedAtEpochMs: Infinity })), null);
    assert.equal(Model.validateReport(makeReport({ fetchedAtEpochMs: -1 })), null);
    assert.equal(Model.validateReport(makeReport({ fetchedAtEpochMs: Date.now() + 365 * 24 * 60 * 60 * 1000 * 10 })), null);
  });

  test("rejects out-of-range or non-integer nowLocalMinutes", () => {
    assert.equal(Model.validateReport(makeReport({ nowLocalMinutes: 1440 })), null);
    assert.equal(Model.validateReport(makeReport({ nowLocalMinutes: -1 })), null);
    assert.equal(Model.validateReport(makeReport({ nowLocalMinutes: 12.5 })), null);
  });

  test("rejects oversized auxiliary fields (slug/timezone)", () => {
    assert.equal(Model.validateReport(makeReport({ slug: "a".repeat(500) })), null);
    assert.equal(Model.validateReport(makeReport({ timezone: "a".repeat(500) })), null);
  });
});

describe("parseSettingsFile", () => {
  test("returns empty defaults for an empty string", () => {
    assert.deepEqual(Model.parseSettingsFile(""), { mosque: "", fetchedDate: "", report: null });
  });

  test("returns empty defaults for unparseable JSON", () => {
    assert.deepEqual(Model.parseSettingsFile("{not json"), { mosque: "", fetchedDate: "", report: null });
  });

  test("passes through a fully valid cache file", () => {
    const report = makeReport();
    const text = JSON.stringify({ mosque: "islamic-center-brooklyn", fetchedDate: "2026-08-28", report });
    const parsed = Model.parseSettingsFile(text);
    assert.equal(parsed.mosque, "islamic-center-brooklyn");
    assert.equal(parsed.fetchedDate, "2026-08-28");
    assert.notEqual(parsed.report, null);
  });

  test("rejects a planted oversized/markup report but keeps a valid mosque", () => {
    const text = JSON.stringify({
      mosque: "islamic-center-brooklyn",
      fetchedDate: "2026-08-28",
      report: {
        name: "Legit Name",
        labels: new Array(50000).fill("<img src=http://attacker.example/pixel.png>"),
        times: ["05:12", "13:05", "16:45", "19:58", "21:20"],
        shuruq: "06:16",
        jumua: "13:00",
        fetchedAtEpochMs: Date.now(),
        nowLocalMinutes: 275
      }
    });
    const parsed = Model.parseSettingsFile(text);
    assert.equal(parsed.report, null);
    assert.equal(parsed.mosque, "islamic-center-brooklyn");
  });

  test("rejects a planted bad mosque but keeps a valid report", () => {
    const text = JSON.stringify({
      mosque: "https://mawaqit.net/en/x\ninjected",
      fetchedDate: "2026-08-28",
      report: makeReport()
    });
    const parsed = Model.parseSettingsFile(text);
    assert.equal(parsed.mosque, "");
    assert.notEqual(parsed.report, null);
  });
});

describe("todayLocalDate", () => {
  test("formats as YYYY-MM-DD", () => {
    assert.match(Model.todayLocalDate(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("minutesFromHHMM", () => {
  test("parses valid HH:MM", () => {
    assert.equal(Model.minutesFromHHMM("05:12"), 312);
    assert.equal(Model.minutesFromHHMM("00:00"), 0);
    assert.equal(Model.minutesFromHHMM("23:59"), 1439);
  });

  test("returns NaN for malformed input", () => {
    assert.ok(Number.isNaN(Model.minutesFromHHMM("not-a-time")));
    assert.ok(Number.isNaN(Model.minutesFromHHMM("")));
    assert.ok(Number.isNaN(Model.minutesFromHHMM(undefined)));
  });
});

describe("nextPrayer", () => {
  test("returns the next prayer later today", () => {
    const fetchedAt = new Date("2026-08-28T00:00:00Z").getTime();
    const report = makeReport({ fetchedAtEpochMs: fetchedAt, nowLocalMinutes: 300 }); // 05:00, Fajr is 05:12
    const result = Model.nextPrayer(report, fetchedAt);
    assert.equal(result.index, 0);
    assert.equal(result.label, "Fajr");
    assert.equal(result.tomorrow, false);
  });

  test("wraps to tomorrow's Fajr when every prayer today has passed", () => {
    const fetchedAt = new Date("2026-08-28T00:00:00Z").getTime();
    const report = makeReport({ fetchedAtEpochMs: fetchedAt, nowLocalMinutes: 1439 }); // 23:59
    const result = Model.nextPrayer(report, fetchedAt);
    assert.equal(result.index, 0);
    assert.equal(result.label, "Fajr");
    assert.equal(result.tomorrow, true);
  });

  test("returns null for a report with no usable times", () => {
    assert.equal(Model.nextPrayer(null, Date.now()), null);
    assert.equal(Model.nextPrayer(makeReport({ times: [] }), Date.now()), null);
  });
});

describe("formatCountdown", () => {
  test("formats zero as 'now'", () => {
    assert.equal(Model.formatCountdown(0), "now");
  });

  test("formats under an hour as minutes only", () => {
    assert.equal(Model.formatCountdown(45), "45m");
  });

  test("formats over an hour with both units", () => {
    assert.equal(Model.formatCountdown(125), "2h 5m");
  });

  test("formats an exact hour without trailing minutes", () => {
    assert.equal(Model.formatCountdown(120), "2h");
  });
});

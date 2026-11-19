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
    "SHURUQ_LABEL",
    "iqamaFor",
    "formatCountdown",
    "MAX_SAVED_MOSQUES",
    "mosqueKey",
    "validateSavedMosques",
    "isMosqueSaved",
    "addSavedMosque",
    "removeSavedMosque",
    "savedMosqueLabel",
    "displayMessage",
    "MAX_MESSAGE_LEN"
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
    iqama: ["05:27", "13:20", "17:00", "20:03", "21:22"],
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

  test("accepts a report without an iqama field (cached before iqama support)", () => {
    const report = makeReport();
    delete report.iqama;
    assert.notEqual(Model.validateReport(report), null);
  });

  test("accepts five blank iqama times (mosque publishes no iqama calendar)", () => {
    assert.notEqual(Model.validateReport(makeReport({ iqama: ["", "", "", "", ""] })), null);
  });

  test("rejects an iqama array of the wrong length or shape", () => {
    assert.equal(Model.validateReport(makeReport({ iqama: ["05:27", "13:20"] })), null);
    assert.equal(Model.validateReport(makeReport({ iqama: "05:27" })), null);
    assert.equal(Model.validateReport(makeReport({ iqama: [1, 2, 3, 4, 5] })), null);
  });

  test("rejects an iqama entry that isn't a plain time", () => {
    assert.equal(Model.validateReport(makeReport({ iqama: ["+15", "13:20", "17:00", "20:03", "21:22"] })), null);
    assert.equal(Model.validateReport(makeReport({ iqama: ["<b>05:27</b>", "13:20", "17:00", "20:03", "21:22"] })), null);
    assert.equal(Model.validateReport(makeReport({ iqama: ["25:00", "13:20", "17:00", "20:03", "21:22"] })), null);
  });

  test("accepts a slug as long as the mosque value it came from", () => {
    const slug = "a".repeat(200);
    assert.equal(Model.validateMosque(slug), slug);
    assert.notEqual(Model.validateReport(makeReport({ slug: slug })), null);
  });
});

describe("parseSettingsFile", () => {
  test("returns empty defaults for an empty string", () => {
    assert.deepEqual(Model.parseSettingsFile(""), { mosque: "", fetchedDate: "", report: null, saved: [] });
  });

  test("returns empty defaults for unparseable JSON", () => {
    assert.deepEqual(Model.parseSettingsFile("{not json"), { mosque: "", fetchedDate: "", report: null, saved: [] });
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

describe("saved mosques", () => {
  const url = "https://mawaqit.net/en/islamic-center-brooklyn";
  const slug = "islamic-center-brooklyn";

  test("mosqueKey treats a slug and its mawaqit.net link as the same mosque", () => {
    assert.equal(Model.mosqueKey(url), slug);
    assert.equal(Model.mosqueKey("https://mawaqit.net/de/m/Islamic-Center-Brooklyn?x=1"), slug);
    assert.equal(Model.mosqueKey(slug), slug);
  });

  test("addSavedMosque appends a new entry with its name", () => {
    const list = Model.addSavedMosque([], slug, "Islamic Center of Brooklyn");
    assert.deepEqual(list, [{ mosque: slug, name: "Islamic Center of Brooklyn" }]);
  });

  test("addSavedMosque does not duplicate a mosque saved under its link", () => {
    const list = Model.addSavedMosque([{ mosque: url, name: "" }], slug, "Islamic Center of Brooklyn");
    assert.deepEqual(list, [{ mosque: url, name: "Islamic Center of Brooklyn" }]);
  });

  test("addSavedMosque keeps an existing name when given none", () => {
    const list = Model.addSavedMosque([{ mosque: slug, name: "Known" }], slug, "");
    assert.deepEqual(list, [{ mosque: slug, name: "Known" }]);
  });

  test("addSavedMosque rejects an invalid mosque and a full list", () => {
    assert.deepEqual(Model.addSavedMosque([], "bad\nslug", "x"), []);
    const full = Array.from({ length: Model.MAX_SAVED_MOSQUES }, (_, i) => ({ mosque: "m" + i, name: "" }));
    assert.equal(Model.addSavedMosque(full, "one-more", "").length, Model.MAX_SAVED_MOSQUES);
  });

  test("addSavedMosque does not mutate its input", () => {
    const list = [{ mosque: slug, name: "" }];
    Model.addSavedMosque(list, slug, "Named");
    assert.deepEqual(list, [{ mosque: slug, name: "" }]);
  });

  test("removeSavedMosque removes by identity, not exact spelling", () => {
    const list = [{ mosque: url, name: "A" }, { mosque: "other-mosque", name: "B" }];
    assert.deepEqual(Model.removeSavedMosque(list, slug), [{ mosque: "other-mosque", name: "B" }]);
  });

  test("isMosqueSaved matches by identity", () => {
    assert.equal(Model.isMosqueSaved([{ mosque: url, name: "" }], slug), true);
    assert.equal(Model.isMosqueSaved([{ mosque: url, name: "" }], "other"), false);
    assert.equal(Model.isMosqueSaved([], ""), false);
  });

  test("validateSavedMosques drops bad entries but keeps the good ones", () => {
    const list = Model.validateSavedMosques([
      { mosque: slug, name: "Good" },
      { mosque: "bad\nslug", name: "x" },
      "not an object",
      null,
      { mosque: url, name: "duplicate of the first" },
      { mosque: "markup-name", name: "<img src=x>" }
    ]);
    assert.deepEqual(list, [{ mosque: slug, name: "Good" }, { mosque: "markup-name", name: "" }]);
  });

  test("validateSavedMosques caps the list length", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ mosque: "m" + i, name: "" }));
    assert.equal(Model.validateSavedMosques(many).length, Model.MAX_SAVED_MOSQUES);
    assert.deepEqual(Model.validateSavedMosques("nope"), []);
  });

  test("savedMosqueLabel falls back to the slug when no name is known", () => {
    assert.equal(Model.savedMosqueLabel({ mosque: slug, name: "Named" }), "Named");
    assert.equal(Model.savedMosqueLabel({ mosque: slug, name: "" }), slug);
  });

  test("parseSettingsFile loads the saved list and treats a missing one as empty", () => {
    const withSaved = Model.parseSettingsFile(JSON.stringify({ mosque: slug, saved: [{ mosque: url, name: "A" }] }));
    assert.deepEqual(withSaved.saved, [{ mosque: url, name: "A" }]);
    const withoutSaved = Model.parseSettingsFile(JSON.stringify({ mosque: slug }));
    assert.deepEqual(withoutSaved.saved, []);
  });
});

describe("displayMessage", () => {
  test("strips markup-shaped input so it can't render as rich text", () => {
    const out = Model.displayMessage('<img src="https://attacker.example/pixel.png">No mosque');
    assert.ok(!/[<>]/.test(out));
    assert.equal(out, 'img src="https://attacker.example/pixel.png"No mosque');
  });

  test("collapses control characters and newlines into single spaces", () => {
    assert.equal(Model.displayMessage("Traceback\n  File x\r\n\tline\u0000end"), "Traceback File x line end");
  });

  test("bounds the length", () => {
    const out = Model.displayMessage("x".repeat(100000));
    assert.equal(out.length, Model.MAX_MESSAGE_LEN);
    assert.ok(out.endsWith("…"));
  });

  test("anything that isn't a string becomes empty", () => {
    for (const value of [undefined, null, 42, {}, ["<b>"]]) assert.equal(Model.displayMessage(value), "");
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

  test("returns Shuruk between Fajr and sunrise", () => {
    const fetchedAt = new Date("2026-08-28T00:00:00Z").getTime();
    const report = makeReport({ fetchedAtEpochMs: fetchedAt, nowLocalMinutes: 340 }); // 05:40, after Fajr, before Shuruk 06:16
    const result = Model.nextPrayer(report, fetchedAt);
    assert.equal(result.shuruq, true);
    assert.equal(result.index, -1);
    assert.equal(result.label, Model.SHURUQ_LABEL);
    assert.equal(result.time, "06:16");
    assert.equal(result.minutesUntil, 36);
    assert.equal(result.tomorrow, false);
  });

  test("returns Dhuhr once sunrise has passed", () => {
    const fetchedAt = new Date("2026-08-28T00:00:00Z").getTime();
    const report = makeReport({ fetchedAtEpochMs: fetchedAt, nowLocalMinutes: 400 }); // 06:40
    const result = Model.nextPrayer(report, fetchedAt);
    assert.equal(result.shuruq, false);
    assert.equal(result.index, 1);
    assert.equal(result.label, "Dhuhr");
  });

  test("skips Shuruk when the report has no shuruq time", () => {
    const fetchedAt = new Date("2026-08-28T00:00:00Z").getTime();
    const report = makeReport({ fetchedAtEpochMs: fetchedAt, nowLocalMinutes: 340, shuruq: "" });
    const result = Model.nextPrayer(report, fetchedAt);
    assert.equal(result.index, 1);
    assert.equal(result.label, "Dhuhr");
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

describe("iqamaFor", () => {
  test("returns the iqama time for a prayer index", () => {
    assert.equal(Model.iqamaFor(makeReport(), 0), "05:27");
    assert.equal(Model.iqamaFor(makeReport(), 4), "21:22");
  });

  test("returns \"\" for a report with no iqama field, and for a blank entry", () => {
    const report = makeReport();
    delete report.iqama;
    assert.equal(Model.iqamaFor(report, 0), "");
    assert.equal(Model.iqamaFor(makeReport({ iqama: ["", "", "", "", ""] }), 2), "");
  });

  test("returns \"\" rather than throwing on a missing report or index", () => {
    assert.equal(Model.iqamaFor(null, 0), "");
    assert.equal(Model.iqamaFor(makeReport(), 9), "");
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

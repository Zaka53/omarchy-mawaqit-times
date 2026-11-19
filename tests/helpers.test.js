// Behavioural tests for the Python helpers in scripts/, run the same way
// Panel.qml runs them: the interpreter argv and the environment are read out
// of Panel.qml itself, so these tests follow the real configuration rather
// than a copy of it. Nothing here touches the network — mawaqit_times.py is
// driven through tests/support/mawaqit_driver.py, which swaps out urlopen.
//
// Run with: node --test tests/

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const root = path.join(__dirname, "..");
const panelSrc = fs.readFileSync(path.join(root, "Panel.qml"), "utf8");
const settingsIo = path.join(root, "scripts", "settings_io.py");
const mawaqitTimes = path.join(root, "scripts", "mawaqit_times.py");
const driver = path.join(__dirname, "support", "mawaqit_driver.py");
const fixturePage = path.join(__dirname, "fixtures", "mosque_page.html");

const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const pythonArgv = JSON.parse(panelSrc.match(/pythonArgv: (\[.*\])/)[1]);
const helperEnv = Object.fromEntries(
  [...panelSrc.match(/helperEnvironment: \(\{([\s\S]*?)\}\)/)[1]
    .matchAll(/"([A-Z_]+)": "([^"]*)"/g)].map((m) => [m[1], m[2]]));

// Runs a helper exactly as Panel.qml would (isolated argv, cleared env plus
// helperEnvironment), with optional extra env vars layered on top and
// optional stdin input (how Panel.qml hands settings_io.py a document).
function runHelper(args, extraEnv = {}, argv = pythonArgv, input = undefined) {
  const res = spawnSync(argv[0], [...argv.slice(1), ...args], {
    env: { ...helperEnv, ...extraEnv },
    input,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return res;
}

function runJson(args, extraEnv, argv, input) {
  const res = runHelper(args, extraEnv, argv, input);
  assert.equal(res.status, 0, `helper exited ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mawaqit-helpers-")); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function tmpPath(name) { return path.join(tmp, name); }

// A settings write exactly as Panel.qml sends it: path in argv, the document
// as one newline-terminated line on stdin.
function writeSettings(p, content, extraEnv) {
  return runJson([settingsIo, "write", p], extraEnv, undefined, content + "\n");
}

// ---------------------------------------------------------------------------
// Interpreter isolation: a shadow `json` module must never be imported.
// ---------------------------------------------------------------------------

describe("interpreter isolation", () => {
  let evilDir;
  let marker;

  before(() => {
    evilDir = tmpPath("evil");
    marker = tmpPath("pwned");
    fs.mkdirSync(evilDir);
    // Leaves a marker file and aborts, so any import of it is unmistakable.
    fs.writeFileSync(path.join(evilDir, "json.py"),
      `open(${JSON.stringify(marker)}, "w").close()\nraise SystemExit(9)\n`);
  });

  function assertNotPwned(res) {
    assert.equal(fs.existsSync(marker), false, "shadow json.py was imported");
    assert.equal(res.status, 0, res.stderr);
    JSON.parse(res.stdout);
  }

  test("control: a bare python3 does import the shadow module", () => {
    const res = runHelper([settingsIo, "read", tmpPath("none.json")],
      { PYTHONPATH: evilDir }, ["/usr/bin/python3"]);
    assert.equal(res.status, 9);
    assert.equal(fs.existsSync(marker), true);
    fs.rmSync(marker);
  });

  const hostile = () => ({
    PYTHONPATH: evilDir,
    PYTHONHOME: evilDir,
    PYTHONSTARTUP: path.join(evilDir, "json.py"),
    PYTHONUSERBASE: evilDir,
    PYTHONSAFEPATH: "",
  });

  test("settings_io.py read ignores PYTHON* variables", () => {
    assertNotPwned(runHelper([settingsIo, "read", tmpPath("none.json")], hostile()));
  });

  test("settings_io.py write ignores PYTHON* variables", () => {
    assertNotPwned(runHelper([settingsIo, "write", tmpPath("iso.json")], hostile(), undefined, "{}\n"));
  });

  test("mawaqit_times.py ignores PYTHON* variables", () => {
    // No argument -> usage error, which still imports json, without any network.
    assertNotPwned(runHelper([mawaqitTimes], hostile()));
  });

  test("a json.py next to the script is not imported", () => {
    const dir = tmpPath("scriptdir");
    fs.mkdirSync(dir);
    const copy = path.join(dir, "settings_io.py");
    fs.copyFileSync(settingsIo, copy);
    fs.copyFileSync(path.join(evilDir, "json.py"), path.join(dir, "json.py"));
    assertNotPwned(runHelper([copy, "read", tmpPath("none.json")]));
  });

  test("the helper sees only the fixed environment", () => {
    const res = runHelper(["-c", "import os, sys; sys.stdout.write(repr(sorted(os.environ)))"]);
    assert.equal(res.stdout, `[${Object.keys(helperEnv).sort().map((k) => `'${k}'`).join(", ")}]`);
  });
});

// ---------------------------------------------------------------------------
// settings_io.py
// ---------------------------------------------------------------------------

describe("settings_io.py", () => {
  test("missing file reads as not existing", () => {
    assert.deepEqual(runJson([settingsIo, "read", tmpPath("missing.json")]),
      { ok: true, exists: false, text: "" });
  });

  test("write then read round-trips, including non-ASCII", () => {
    const p = tmpPath("round.json");
    const content = JSON.stringify({ mosque: "mosquée-été", report: null });
    assert.deepEqual(writeSettings(p, content), { ok: true });
    assert.deepEqual(runJson([settingsIo, "read", p]), { ok: true, exists: true, text: content });
  });

  test("write creates missing parent directories with a 0600 file", () => {
    const p = tmpPath(path.join("a", "b", "c", "settings.json"));
    assert.deepEqual(writeSettings(p, "{}"), { ok: true });
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  });

  test("write leaves no temp files behind", () => {
    const dir = tmpPath("clean");
    fs.mkdirSync(dir);
    writeSettings(path.join(dir, "s.json"), "{}");
    writeSettings(path.join(dir, "s.json"), "{\"x\":1}");
    assert.deepEqual(fs.readdirSync(dir), ["s.json"]);
  });

  test("read refuses to follow a symlink", () => {
    const target = tmpPath("secret.txt");
    const link = tmpPath("link.json");
    fs.writeFileSync(target, "SECRET");
    fs.symlinkSync(target, link);
    const out = runJson([settingsIo, "read", link]);
    assert.equal(out.ok, false);
    assert.ok(!JSON.stringify(out).includes("SECRET"));
  });

  test("write replaces a symlink instead of writing through it", () => {
    const target = tmpPath("victim.txt");
    const link = tmpPath("link-w.json");
    fs.writeFileSync(target, "ORIGINAL");
    fs.symlinkSync(target, link);
    assert.deepEqual(writeSettings(link, "{}"), { ok: true });
    assert.equal(fs.readFileSync(target, "utf8"), "ORIGINAL");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(link, "utf8"), "{}");
  });

  test("read of a FIFO fails promptly instead of blocking", () => {
    const fifo = tmpPath("fifo.json");
    execFileSync("mkfifo", [fifo]);
    const started = Date.now();
    const out = runJson([settingsIo, "read", fifo]);
    assert.equal(out.ok, false);
    assert.match(out.error, /not a regular file/);
    assert.ok(Date.now() - started < 5000);
  });

  test("write replaces a FIFO without opening it", () => {
    const fifo = tmpPath("fifo-w.json");
    execFileSync("mkfifo", [fifo]);
    assert.deepEqual(writeSettings(fifo, "{}"), { ok: true });
    assert.equal(fs.statSync(fifo).isFile(), true);
  });

  test("read of a directory is rejected", () => {
    const dir = tmpPath("a-dir.json");
    fs.mkdirSync(dir);
    const out = runJson([settingsIo, "read", dir]);
    assert.equal(out.ok, false);
    assert.match(out.error, /not a regular file/);
  });

  test("a file of exactly the size limit is accepted", () => {
    const p = tmpPath("exact.json");
    fs.writeFileSync(p, Buffer.alloc(MAX_SETTINGS_BYTES, 0x61));
    const out = runJson([settingsIo, "read", p]);
    assert.equal(out.ok, true);
    assert.equal(out.text.length, MAX_SETTINGS_BYTES);
  });

  test("a file one byte over the size limit is rejected", () => {
    const p = tmpPath("big.json");
    fs.writeFileSync(p, Buffer.alloc(MAX_SETTINGS_BYTES + 1, 0x61));
    const out = runJson([settingsIo, "read", p]);
    assert.deepEqual(out, { ok: false, error: "settings file is too large" });
  });

  test("invalid UTF-8 on disk is replaced rather than crashing", () => {
    const p = tmpPath("bad-utf8.json");
    fs.writeFileSync(p, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
    const out = runJson([settingsIo, "read", p]);
    assert.equal(out.ok, true);
    assert.equal(out.text, "{��}");
  });

  test("the document is read from stdin, so it never appears in argv", () => {
    // Panel.qml passes only the action and the path as arguments; a content
    // argument is refused, so the document can't end up in /proc/<pid>/cmdline.
    const p = tmpPath("argv.json");
    const out = runJson([settingsIo, "write", p, '{"mosque":"secret"}'], undefined, undefined, "{}\n");
    assert.equal(out.ok, false);
    assert.equal(fs.existsSync(p), false);
  });

  test("a document of exactly the size limit is written", () => {
    const p = tmpPath("exact-w.json");
    assert.deepEqual(writeSettings(p, "a".repeat(MAX_SETTINGS_BYTES)), { ok: true });
    assert.equal(fs.statSync(p).size, MAX_SETTINGS_BYTES);
  });

  test("a document over the size limit is rejected without writing", () => {
    const p = tmpPath("big-w.json");
    assert.deepEqual(writeSettings(p, "a".repeat(MAX_SETTINGS_BYTES + 1)),
      { ok: false, error: "settings content is too large" });
    assert.equal(fs.existsSync(p), false);
  });

  test("input without its terminating newline is rejected, not partially written", () => {
    const p = tmpPath("partial.json");
    for (const input of ["", '{"mosque":"trunc']) {
      assert.deepEqual(runJson([settingsIo, "write", p], undefined, undefined, input),
        { ok: false, error: "settings content was incomplete" }, JSON.stringify(input));
    }
    assert.equal(fs.existsSync(p), false);
  });

  test("only the first line is written", () => {
    const p = tmpPath("first-line.json");
    assert.deepEqual(runJson([settingsIo, "write", p], undefined, undefined, "{}\n{\"x\":1}\n"), { ok: true });
    assert.equal(fs.readFileSync(p, "utf8"), "{}");
  });

  test("bad invocations report an error and still exit 0", () => {
    for (const args of [[], ["read"], ["read", tmpPath("x"), "extra"], ["delete", tmpPath("x")],
      ["write", tmpPath("x"), "{}"], ["write", tmpPath("x"), "a", "b"]]) {
      const out = runJson([settingsIo, ...args], undefined, undefined, "{}\n");
      assert.equal(out.ok, false, JSON.stringify(args));
      assert.equal(typeof out.error, "string");
    }
  });
});

// ---------------------------------------------------------------------------
// mawaqit_times.py (offline, via the driver)
// ---------------------------------------------------------------------------

describe("mawaqit_times.py", () => {
  // The mosque goes to the helper's stdin, exactly as Panel.qml sends it.
  function fetchWith(scenario, mosque) {
    const res = runHelper([driver, mawaqitTimes, JSON.stringify(scenario)], undefined, undefined, mosque + "\n");
    assert.equal(res.status, 0, res.stderr);
    return { out: JSON.parse(res.stdout), seen: JSON.parse(res.stderr) };
  }

  function pageWith(confData) {
    const p = tmpPath(`page-${Math.random().toString(36).slice(2)}.html`);
    fs.writeFileSync(p, `<script>var confData = ${confData};</script>`);
    return { body_file: p };
  }

  const goodTimes = '["05:00", "13:00", "16:00", "19:00", "21:00"]';

  test("parses the fixture page into a sanitized report", () => {
    const { out, seen } = fetchWith({ body_file: fixturePage }, "test-mosque");
    assert.equal(seen.url, "https://mawaqit.net/en/test-mosque");
    assert.equal(seen.timeout, 10);
    assert.equal(out.ok, true);
    assert.equal(out.slug, "test-mosque");
    assert.equal(out.name, 'img src=xTest "Mosque" {Central} Hall');
    assert.equal(out.timezone, "Europe/Berlin");
    assert.deepEqual(out.labels, ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"]);
    assert.deepEqual(out.times, ["05:18", "13:27", "16:50", "19:40", "21:24"]);
    assert.deepEqual(out.iqama, ["", "", "", "", ""]);
    assert.equal(out.shuruq, "07:11");
    assert.equal(out.jumua, "b14:00/b");
    assert.ok(Number.isInteger(out.fetchedAtEpochMs));
    assert.ok(Math.abs(out.fetchedAtEpochMs - Date.now()) < 60000);
    assert.ok(out.nowLocalMinutes >= 0 && out.nowLocalMinutes < 1440);
  });

  test("a mawaqit.net URL is reduced to its slug", () => {
    for (const input of ["https://mawaqit.net/fr/my-mosque", "https://mawaqit.net/en/m/my-mosque?x=1#y",
      "  mawaqit.net/de/my-mosque/  "]) {
      const { seen, out } = fetchWith({ body_file: fixturePage }, input);
      assert.equal(seen.url, "https://mawaqit.net/en/my-mosque", input);
      assert.equal(out.slug, "my-mosque");
    }
  });

  test("the response read is bounded to limit + 1 bytes", () => {
    const { seen } = fetchWith({ body_file: fixturePage }, "m");
    assert.equal(seen.read_n, MAX_RESPONSE_BYTES + 1);
  });

  test("a response over the limit is rejected", () => {
    const { out } = fetchWith({ body_size: MAX_RESPONSE_BYTES + 1 }, "m");
    assert.deepEqual(out, { ok: false, error: "mawaqit.net response was too large" });
  });

  test("a response of exactly the limit is not rejected as too large", () => {
    const { out } = fetchWith({ body_size: MAX_RESPONSE_BYTES }, "m");
    assert.equal(out.error, "Could not find prayer time data on the mosque page");
  });

  test("HTTP 404 names the missing mosque", () => {
    assert.deepEqual(fetchWith({ http_error: 404 }, "nope").out,
      { ok: false, error: "No mosque found for 'nope'" });
  });

  test("other HTTP errors report the status", () => {
    assert.deepEqual(fetchWith({ http_error: 503 }, "m").out,
      { ok: false, error: "mawaqit.net returned HTTP 503" });
  });

  test("network failures are reported, not raised", () => {
    assert.deepEqual(fetchWith({ url_error: "no route" }, "m").out,
      { ok: false, error: "Could not reach mawaqit.net: no route" });
  });

  test("a page without confData is rejected", () => {
    const p = tmpPath("no-conf.html");
    fs.writeFileSync(p, "<html>nothing here</html>");
    assert.equal(fetchWith({ body_file: p }, "m").out.error,
      "Could not find prayer time data on the mosque page");
  });

  test("an unterminated confData object is rejected", () => {
    const p = tmpPath("unterminated.html");
    fs.writeFileSync(p, 'let confData = {"times": ["}"');
    assert.equal(fetchWith({ body_file: p }, "m").out.error,
      "Could not find prayer time data on the mosque page");
  });

  test("confData that isn't valid JSON is rejected", () => {
    assert.equal(fetchWith(pageWith("{times: [1,2,3,4,5]}"), "m").out.error,
      "Could not parse prayer time data from the mosque page");
  });

  test("anything other than exactly five times is rejected", () => {
    for (const times of ["[]", '["05:00"]', '["1","2","3","4","5","6"]', '"05:00"', "null"]) {
      assert.equal(fetchWith(pageWith(`{"times": ${times}}`), "m").out.error,
        "Mosque page did not include today's prayer times", times);
    }
  });

  test("a missing or invalid timezone falls back to UTC", () => {
    for (const tz of ['', ', "timezone": "Not/AZone"', ', "timezone": "../../etc/passwd"']) {
      const { out } = fetchWith(pageWith(`{"times": ${goodTimes}${tz}}`), "m");
      assert.equal(out.ok, true, tz);
      assert.equal(out.timezone, "UTC", tz);
    }
  });

  test("a missing name falls back to the slug", () => {
    assert.equal(fetchWith(pageWith(`{"times": ${goodTimes}}`), "fallback-slug").out.name,
      "fallback-slug");
  });

  test("non-string fields are blanked rather than passed through", () => {
    const { out } = fetchWith(pageWith(
      `{"name": {"x": 1}, "times": [1, null, {}, [], "21:00"], "shuruq": 7, "jumua": true}`), "m");
    assert.equal(out.ok, true);
    assert.equal(out.name, "");
    assert.deepEqual(out.times, ["", "", "", "", "21:00"]);
    assert.equal(out.shuruq, "");
    assert.equal(out.jumua, "");
  });

  test("invisible bidi/control characters are stripped from display fields", () => {
    // U+202E would visually reverse the rest of the name, U+2028 breaks the
    // line even in plain text; neither survives, ZWNJ (used in Persian) does.
    const { out } = fetchWith(pageWith(JSON.stringify({
      name: "Masjid\u202e evil\u2028 line\u0000\u2066x\u2069 \u200b \u200cok\ufeff",
      times: ["05:00", "13:00", "16:00", "19:00", "21:00"],
    })), "m");
    assert.equal(out.ok, true);
    assert.equal(out.name, "Masjid evil linex \u200cok");
  });

  test("a fetch that outlasts the deadline is abandoned with an error", () => {
    const started = Date.now();
    const { out } = fetchWith({ stall_seconds: 30, deadline: 1 }, "m");
    assert.deepEqual(out, { ok: false, error: "mawaqit.net took too long to respond" });
    assert.ok(Date.now() - started < 8000);
  });

  test("the deadline is cleared once the page has been read", () => {
    // Parsing happens after the alarm is cancelled, so a fast fetch followed
    // by a pause can't be cut off with a misleading timeout.
    const { out } = fetchWith({ body_file: fixturePage, deadline: 1, sleep_after: 1.5 }, "m");
    assert.equal(out.ok, true);
  });

  test("the whole-request deadline is 30 seconds", () => {
    assert.match(fs.readFileSync(mawaqitTimes, "utf8"), /^FETCH_DEADLINE_SECONDS = 30$/m);
  });

  test("display fields are length-capped", () => {
    const { out } = fetchWith(pageWith(
      `{"name": "${"n".repeat(500)}", "times": ["${"9".repeat(50)}", "2", "3", "4", "5"]}`), "m");
    assert.equal(out.name.length, 200);
    assert.equal(out.times[0].length, 16);
  });

  // The helper resolves "today" in the mosque's timezone, so these pages pin
  // it to UTC and derive the day/month from the same clock the helper will.
  const utcNow = () => { const d = new Date(); return { month: d.getUTCMonth() + 1, day: d.getUTCDate() }; };

  // Every day of every month maps to `entry`, so the test is date-independent.
  function everyDay(entry) {
    const month = {};
    for (let d = 1; d <= 31; d++) month[String(d)] = entry;
    return JSON.stringify(new Array(12).fill(month));
  }

  function iqamaPage(calendar, times = goodTimes) {
    return pageWith(`{"timezone": "UTC", "times": ${times}, "iqamaCalendar": ${calendar}}`);
  }

  test("iqama offsets are resolved against today's prayer times", () => {
    const { out } = fetchWith(iqamaPage(everyDay(["06:23", "+15", "+15", "+5", "+2"])), "m");
    assert.equal(out.ok, true);
    assert.deepEqual(out.iqama, ["06:23", "13:15", "16:15", "19:05", "21:02"]);
  });

  test("an iqama offset past midnight wraps instead of overflowing", () => {
    const { out } = fetchWith(
      iqamaPage(everyDay(["+5", "+5", "+5", "+5", "+20"]), '["05:00", "13:00", "16:00", "19:00", "23:50"]'), "m");
    assert.deepEqual(out.iqama, ["05:05", "13:05", "16:05", "19:05", "00:10"]);
  });

  test("today's entry is the one picked out of the calendar", () => {
    const { month, day } = utcNow();
    const months = new Array(12).fill(null).map((_, i) => {
      const entry = {};
      for (let d = 1; d <= 31; d++) entry[String(d)] = ["08:00", "+2", "+2", "+2", "+2"];
      if (i + 1 === month) entry[String(day)] = ["07:00", "+1", "+1", "+1", "+1"];
      return entry;
    });
    const { out } = fetchWith(iqamaPage(JSON.stringify(months)), "m");
    assert.deepEqual(out.iqama, ["07:00", "13:01", "16:01", "19:01", "21:01"]);
  });

  test("a mosque with no iqama calendar reports five blanks", () => {
    assert.deepEqual(fetchWith(pageWith(`{"times": ${goodTimes}}`), "m").out.iqama, ["", "", "", "", ""]);
  });

  test("a malformed iqama calendar reports five blanks, not an error", () => {
    for (const calendar of ['"nope"', "null", "[]", "[1,2,3,4,5,6,7,8,9,10,11,12]",
      everyDay(["06:23", "+15"]), everyDay("not-a-list")]) {
      const { out } = fetchWith(iqamaPage(calendar), "m");
      assert.equal(out.ok, true, calendar);
      assert.deepEqual(out.iqama, ["", "", "", "", ""], calendar);
    }
  });

  test("unusable iqama entries blank only their own prayer", () => {
    const { out } = fetchWith(iqamaPage(everyDay(["25:00", "+15", null, "++5", "+2"])), "m");
    assert.deepEqual(out.iqama, ["", "13:15", "", "", "21:02"]);
  });

  test("an iqama offset against an unusable prayer time is blank", () => {
    const { out } = fetchWith(
      iqamaPage(everyDay(["+5", "+15", "+15", "+5", "+2"]), '["<b>05:00</b>", "13:00", "16:00", "19:00", "21:00"]'), "m");
    assert.equal(out.times[0], "b05:00/b");
    assert.equal(out.iqama[0], "");
  });

  test("a confData that isn't a JSON object is rejected cleanly", () => {
    // extract_conf_data only ever captures a {...} span, so a page can't
    // produce a non-object on its own; stub json.loads to exercise the guard.
    const res = runHelper(["-c", `
import importlib.util, json, sys
import sys; sys.dont_write_bytecode = True  # no scripts/__pycache__ left behind
spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(mawaqitTimes)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.fetch = lambda slug: "var confData = {};"
m.json.loads = lambda raw: ["not", "a", "dict"]
sys.argv = ["x"]
m.run()
`], undefined, undefined, "some-mosque\n");
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stderr, "");
    assert.deepEqual(JSON.parse(res.stdout), { ok: false, error: "Could not parse prayer time data from the mosque page" });
  });

  test("an unexpected exception still ends in a JSON error, not a traceback", () => {
    const res = runHelper(["-c", `
import importlib.util, sys
import sys; sys.dont_write_bytecode = True  # no scripts/__pycache__ left behind
spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(mawaqitTimes)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def boom(slug): raise RuntimeError("<img src=x> secret detail")
m.fetch = boom
sys.argv = ["x"]
m.run()
`], undefined, undefined, "some-mosque\n");
    assert.equal(res.status, 0);
    assert.equal(res.stderr, "");
    assert.deepEqual(JSON.parse(res.stdout), { ok: false, error: "Unexpected error while reading the mosque page" });
  });

  test("anything that isn't a mawaqit slug never reaches a request", () => {
    for (const input of ["../../etc", "a/b", "x?y=1", "https://evil.example/m", "-dash-first", "a".repeat(201)]) {
      const res = runHelper([driver, mawaqitTimes, JSON.stringify({ body_file: fixturePage })], undefined, undefined, input + "\n");
      assert.equal(res.status, 0, res.stderr);
      assert.deepEqual(JSON.parse(res.stdout), { ok: false, error: "That doesn't look like a mawaqit.net mosque slug or link" }, input);
      assert.equal(JSON.parse(res.stderr).url, undefined, `no request for ${input}`);
    }
  });

  test("redirects are only followed to HTTPS mawaqit.net", () => {
    const res = runHelper(["-c", `
import importlib.util, json, urllib.error, urllib.request
import sys; sys.dont_write_bytecode = True  # no scripts/__pycache__ left behind
spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(mawaqitTimes)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
handler = m.MawaqitOnlyRedirects()
req = urllib.request.Request("https://mawaqit.net/en/x")
result = {}
for url in ["https://mawaqit.net/en/y", "https://www.mawaqit.net/en/y", "http://mawaqit.net/en/y",
            "https://evil.example/", "https://mawaqit.net.evil.example/", "https://evil.example/mawaqit.net",
            "ftp://mawaqit.net/x", "file:///etc/passwd"]:
    try:
        result[url] = handler.redirect_request(req, None, 302, "Found", {}, url) is not None
    except urllib.error.URLError:
        result[url] = False
uses_handler = any(isinstance(h, m.MawaqitOnlyRedirects) for h in m._opener.handlers)
default_kept = any(type(h) is urllib.request.HTTPRedirectHandler for h in m._opener.handlers)
print(json.dumps({"result": result, "uses_handler": uses_handler, "default_kept": default_kept}))
`]);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.uses_handler, true);
    assert.equal(out.default_kept, false);
    assert.deepEqual(out.result, {
      "https://mawaqit.net/en/y": true,
      "https://www.mawaqit.net/en/y": true,
      "http://mawaqit.net/en/y": false,
      "https://evil.example/": false,
      "https://mawaqit.net.evil.example/": false,
      "https://evil.example/mawaqit.net": false,
      "ftp://mawaqit.net/x": false,
      "file:///etc/passwd": false,
    });
  });

  test("no input or a blank line is a usage error", () => {
    for (const input of ["", "\n", "   \n"]) {
      const out = runJson([mawaqitTimes], undefined, undefined, input);
      assert.equal(out.ok, false);
      assert.match(out.error, /^Usage:/, JSON.stringify(input));
    }
  });

  test("the mosque is read from stdin, so it never appears in argv", () => {
    // An argument is refused outright (and nothing is requested), so the
    // mosque can't end up in /proc/<pid>/cmdline.
    const res = runHelper([driver, mawaqitTimes, JSON.stringify({ body_file: fixturePage }), "test-mosque"],
      undefined, undefined, "test-mosque\n");
    assert.match(JSON.parse(res.stdout).error, /^Usage:/);
    assert.equal(JSON.parse(res.stderr).url, undefined);
  });

  test("only the first stdin line is the mosque", () => {
    const res = runHelper([driver, mawaqitTimes, JSON.stringify({ body_file: fixturePage })],
      undefined, undefined, "first-mosque\nsecond\n");
    assert.equal(JSON.parse(res.stderr).url, "https://mawaqit.net/en/first-mosque");
  });

  test("oversized stdin input is rejected without a request", () => {
    const res = runHelper([driver, mawaqitTimes, JSON.stringify({ body_file: fixturePage })],
      undefined, undefined, "a".repeat(5000) + "\n");
    assert.equal(JSON.parse(res.stdout).ok, false);
    assert.equal(JSON.parse(res.stderr).url, undefined);
  });
});

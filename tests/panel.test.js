// Static checks on Panel.qml's helper processes. The QML itself can't run
// under node, so these guard the security-relevant invariants textually:
// every Process must start from a cleared, fixed environment, and every
// helper must be launched through the isolated interpreter argv.
//
// Run with: node --test tests/

const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const src = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8");

function processBlocks() {
  const blocks = [];
  const re = /^  Process \{$/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const end = src.indexOf("\n  }\n", m.index);
    blocks.push(src.slice(m.index, end));
  }
  return blocks;
}

test("every Process clears the inherited environment", () => {
  const blocks = processBlocks();
  assert.equal(blocks.length, 3);
  for (const block of blocks) {
    assert.match(block, /^    clearEnvironment: true$/m);
    assert.match(block, /^    environment: root\.helperEnvironment$/m);
  }
});

test("helper environment carries no interpreter-control variables", () => {
  const m = src.match(/helperEnvironment: \(\{([\s\S]*?)\}\)/);
  assert.ok(m);
  const keys = [...m[1].matchAll(/"([A-Z_]+)":/g)].map((k) => k[1]);
  assert.deepEqual(keys.sort(), ["LANG", "LC_ALL", "PATH"]);
});

test("python is always launched isolated, never with a bare argv", () => {
  assert.match(src, /pythonArgv: \["\/usr\/bin\/python3", "-I", "-S"\]/);
  assert.equal(src.match(/"\/usr\/bin\/python3"/g).length, 1);
  const assignments = src.match(/Proc\.command = .*/g);
  assert.equal(assignments.length, 3);
  for (const a of assignments) assert.match(a, /= root\.pythonArgv\.concat\(\[/);
});

test("settings are only ever written as the full state", () => {
  // A write built from only some fields would silently drop the rest (e.g.
  // the saved-mosque list), so every write goes through persistSettings(),
  // apart from the queued write being flushed after a running one.
  const calls = src.match(/root\.saveSettings\([^\n]*/g);
  assert.deepEqual(calls.sort(), ["root.saveSettings(JSON.stringify({", "root.saveSettings(next)"].sort());
  const persist = src.match(/function persistSettings\(\) \{([\s\S]*?)\n  \}/);
  assert.ok(persist);
  for (const key of ["mosque", "fetchedDate", "report", "saved"]) assert.match(persist[1], new RegExp(`^      ${key}: `, "m"));
});

test("every Text the plugin draws is plain text", () => {
  // Text defaults to Text.AutoText, which renders markup in untrusted input
  // (a mosque name, an error message) as rich text. All plugin text goes
  // through the PlainText component, which pins Text.PlainText.
  const component = src.match(/component PlainText: Text \{\n    textFormat: Text\.PlainText\n  \}/);
  assert.ok(component, "PlainText component pins Text.PlainText");
  const bareTexts = src.match(/^\s*Text \{$/gm) || [];
  assert.deepEqual(bareTexts, [], "no bare Text elements");
});

test("error messages are fixed wording or sanitized before display", () => {
  // errorMessage reaches the panel and the bar tooltip, so anything not
  // written by the plugin itself has to pass Model.displayMessage first.
  const assignments = src.match(/root\.errorMessage = .*/g);
  assert.ok(assignments.length > 0);
  for (const a of assignments) {
    assert.match(a, /^root\.errorMessage = ("[^"]*"|Model\.displayMessage\([^)]*\)( \|\| "[^"]*")?)$/, a);
  }
  assert.doesNotMatch(src, /errorMessage = [^\n]*fetchStderr/);
});

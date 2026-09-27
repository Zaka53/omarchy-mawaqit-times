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

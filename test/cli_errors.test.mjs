import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = (args) => spawnSync(process.execPath, ["cli/tidegate.mjs", ...args], { encoding: "utf8" });

test("an unknown command prints a stable code before the prose", () => {
  const r = cli(["nope"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^tidegate: TG_USAGE: /);
});

test("an unknown option does too", () => {
  const r = cli(["status", "--wrong"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^tidegate: TG_USAGE: /);
});

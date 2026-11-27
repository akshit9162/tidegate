import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../worker/src/config.js";
import { listening, signatureMatches } from "../worker/src/hooks.js";
import { followUp } from "../worker/src/runner.js";

const withOn = (on) => parseConfig(JSON.stringify({ agents: [{ name: "fix", run: "node fix.mjs", on }] }));

test("on.github parses its events and the secret that signs them", () => {
  const { config, problems } = withOn({ github: { events: ["pull_request_review", "check_run.completed"], secret: "GITHUB_WEBHOOK_SECRET" } });
  assert.deepEqual(problems, []);
  assert.deepEqual(config.agents[0].on, { github: { events: ["pull_request_review", "check_run.completed"], secret: "GITHUB_WEBHOOK_SECRET" } });
  assert.equal(parseConfig(JSON.stringify({ agents: [{ name: "a", run: "x" }] })).config.agents[0].on, null);
});

test("on.github without events or secret, or with a misspelt key, is refused", () => {
  const text = withOn({ github: { events: [], secret: "lower", evnts: [] } }).problems.join("\n");
  for (const rx of [/at least one GitHub event/, /UPPER_CASE/, /unknown key "evnts"; did you mean "events"/]) assert.match(text, rx);
  assert.match(withOn({ slack: {} }).problems.join("\n"), /"on" is \{"github"/);
  assert.match(withOn({ github: { events: ["Pull Request"], secret: "S" } }).problems.join("\n"), /is an event name/);
});

// The example from GitHub's "Validating webhook deliveries" docs.
const SECRET = "It's a Secret to Everybody";
const BODY = new TextEncoder().encode("Hello, World!");
const SIGNATURE = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

test("a delivery is trusted only when its signature is the HMAC of the exact body", async () => {
  assert.equal(await signatureMatches(SECRET, BODY, SIGNATURE), true);
  assert.equal(await signatureMatches("another secret", BODY, SIGNATURE), false);
  assert.equal(await signatureMatches(SECRET, new TextEncoder().encode("Hello, World?"), SIGNATURE), false);
  assert.equal(await signatureMatches(SECRET, BODY, SIGNATURE.replace("sha256=", "sha1=")), false);
  assert.equal(await signatureMatches(SECRET, BODY, null), false);
  assert.equal(await signatureMatches("", BODY, SIGNATURE), false);
});

test("an event reaches agents listing it, or listing its action", () => {
  const agents = [
    { name: "any", on: { github: { events: ["pull_request_review"] } } },
    { name: "submitted", on: { github: { events: ["pull_request_review.submitted"] } } },
    { name: "ci", on: { github: { events: ["check_run.completed"] } } },
    { name: "none", on: null },
  ];
  assert.deepEqual(listening(agents, "pull_request_review", "submitted").map((a) => a.name), ["any", "submitted"]);
  assert.deepEqual(listening(agents, "pull_request_review", "dismissed").map((a) => a.name), ["any"]);
  assert.deepEqual(listening(agents, "push", null).map((a) => a.name), []);
});

test("an agent can ask for one follow-up run between 1 minute and 1 day away", () => {
  assert.deepEqual(followUp({ follow_up: { in: "20m", input: { pr: 6 } } }), { delay: 1200, input: { pr: 6 } });
  assert.deepEqual(followUp({ follow_up: { in: "1d" } }), { delay: 86400, input: null });
  assert.equal(followUp({ answer: 1 }), null);
  assert.equal(followUp(null), null);
  for (const bad of [{ in: "30s" }, { in: "2d" }, { in: "soon" }, "20m", [1]]) assert.match(followUp({ follow_up: bad }).problem, /was ignored/);
});

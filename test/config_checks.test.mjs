import assert from "node:assert/strict";
import test from "node:test";
import { checkVersion, findSecrets } from "../worker/src/checks.js";
import { parseConfig } from "../worker/src/config.js";
import { pattern, problemLines } from "../worker/src/util.js";

const WATCHER = JSON.stringify({
  agents: [
    { name: "watch", run: "python watch.py", every: "3h", timeout: "60m", secrets: ["GMAIL_USER"], http: false },
    { name: "ask", run: "python ask.py", public: true },
  ],
  state: ["seen.json"],
});

test("agents parse with their triggers and limits", () => {
  const { config, problems } = parseConfig(WATCHER);
  assert.deepEqual(problems, []);
  const [watch, ask] = config.agents;
  assert.equal(watch.every, 3 * 3600);
  assert.equal(watch.timeout, 3600);
  assert.equal(watch.http, false);
  assert.deepEqual([ask.every, ask.http, ask.public, ask.timeout], [null, true, true, 15 * 60]);
  assert.deepEqual(config.state, ["seen.json"]);
});

test("a project without tidegate.json or without agents is refused", () => {
  assert.match(parseConfig(null).problems[0], /tidegate.json: missing/);
  assert.match(parseConfig("{}").problems[0], /at least one agent/);
});

test("bad schedules, timeouts, names and state paths are refused", () => {
  const { problems } = parseConfig(JSON.stringify({
    agents: [{ name: "A", run: "x", every: "5m", timeout: "2h" }, { name: "b", run: "y", secrets: ["lower"] }],
    state: ["../outside.json"],
  }));
  const text = problems.join("\n");
  assert.equal(problems.length, 5);
  for (const rx of [/"name" must be/, /shortest is 15m/, /60m or less/, /UPPER_CASE/, /inside the project/]) assert.match(text, rx);
});

test("secrets are reported by file and line, without the value", () => {
  const key = "sk-ant-" + "a".repeat(30);
  const found = findSecrets("agent.py", `import os\nKEY = "${key}"`);
  assert.equal(found.length, 1);
  assert.match(found[0], /^agent\.py:2: looks like an Anthropic API key/);
  assert.ok(!found[0].includes(key));
});

test("an agent whose entry file was not uploaded fails the deploy", async () => {
  const { config } = parseConfig(WATCHER);
  const text = { "tidegate.json": WATCHER, "watch.py": "print('hi')" };
  const files = new Map(Object.keys(text).map((p) => [p, "0".repeat(64)]));
  const problems = await checkVersion(files, config, async (p) => text[p]);
  assert.deepEqual(problems, ['tidegate.json: agent "ask" runs ask.py, which is not in the upload']);
});

test("the same failure in different runs groups into one pattern", () => {
  const a = problemLines("ok\nHumwork: HTTPError: HTTP Error 429: Too Many Requests\nTook 23.4 minutes, error count 3");
  const b = problemLines("Humwork: HTTPError: HTTP Error 429: Too Many Requests\nTook 19.1 minutes, error count 1");
  assert.equal(a.length, 2);
  assert.deepEqual(a.map(pattern), b.map(pattern));
  assert.match(pattern(a[0]), /429/);
});

test("the deploy page and the runs page ship scripts that parse", async () => {
  const { dashboard, home } = await import("../worker/src/pages.js");
  for (const res of [dashboard(), home({ DOMAIN: "localhost" })]) {
    const html = await res.text();
    assert.doesNotThrow(() => new Function(html.split('<script type="module">')[1].split("</script>")[0]));
  }
});

test("a Python traceback is reported by its exception line, not its header", () => {
  const lines = problemLines("Traceback (most recent call last):\n  File \"t.py\", line 3\nAssertionError: 1 != 2\nFAILED (failures=1)");
  assert.deepEqual(lines, ["AssertionError: 1 != 2", "FAILED (failures=1)"]);
});

test("review is off by default, true, or names the agent to run once approved", () => {
  const { config, problems } = parseConfig(JSON.stringify({ agents: [
    { name: "tailor", run: "python tailor.py", review: { then: "submit" } },
    { name: "submit", run: "python submit.py", http: false },
    { name: "draft", run: "python draft.py", review: true },
  ] }));
  assert.deepEqual(problems, []);
  assert.deepEqual(config.agents.map((a) => a.review), [{ then: "submit", when: "always", min_confidence: 0.7 }, null, { then: null, when: "always", min_confidence: 0.7 }]);
  assert.deepEqual(config.agents.map((a) => [a.examples, a.trace]), [[5, true], [5, true], [5, true]]);
  assert.equal(config.gate, null);
});

test("review must name a different agent that exists", () => {
  const { problems } = parseConfig(JSON.stringify({ agents: [
    { name: "a", run: "x", review: { then: "a" } }, { name: "b", run: "y", review: { then: "nope" } }, { name: "c", run: "z", review: "yes" },
  ] }));
  assert.equal(problems.length, 3);
  for (const rx of [/cannot run itself/, /no agent "nope"/, /"review" is true/]) assert.match(problems.join("\n"), rx);
});

test("the scorecard counts review outcomes and evals per version, live apart from replayed", async () => {
  const { scorecard } = await import("../worker/src/loop.js");
  const run = (o) => ({ kind: "agent", agent: "tailor", trigger: "http", version: "v1", status: "ok", started_at: 0, ended_at: 10, parent: null, ...o });
  const rows = scorecard([
    run({ review: "approved", output: { evals: { format: true, coverage: 0.5 } } }),
    run({ review: "revised", output: { evals: { format: { pass: false, score: 0.2 } } } }),
    run({ review: "approved", trigger: "review", parent: "x", output: { evals: { format: true } } }),
    run({ status: "failed", output: null }),
    run({ trigger: "replay", version: "v2", output: { evals: { format: true } } }),
    run({ status: "running" }),
  ]);
  const live = rows.find((r) => r.version === "v1");
  assert.equal(live.runs, 4);
  assert.equal(live.ok_rate, 0.75);
  assert.deepEqual([live.reviewed, live.approved, live.revised, live.approval_rate], [3, 2, 1, 0.667]);
  assert.equal(live.approved_first_time, 0.5);
  assert.deepEqual(live.evals.format, { n: 3, pass_rate: 0.667, mean: 0.2 });
  assert.deepEqual(live.evals.coverage, { n: 1, pass_rate: null, mean: 0.5 });
  const replay = rows.find((r) => r.version === "v2");
  assert.deepEqual([replay.kind, replay.runs, replay.evals.format.pass_rate], ["replay", 1, 1]);
});

test("review.when, examples and gate are checked", () => {
  const ok = parseConfig(JSON.stringify({ agents: [{ name: "a", run: "x", review: { when: "flagged", min_confidence: 0.5 }, examples: 0, trace: false }], gate: { replay: 5 } }));
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.config.agents[0].review, { then: null, when: "flagged", min_confidence: 0.5 });
  assert.deepEqual([ok.config.agents[0].examples, ok.config.agents[0].trace], [0, false]);
  assert.deepEqual(ok.config.gate, { replay: 5, agents: null, tolerance: 0 });
  const bad = parseConfig(JSON.stringify({ agents: [{ name: "a", run: "x", review: { when: "sometimes", min_confidence: 2 }, examples: 99 }], gate: { replay: 0, agents: ["ghost"] } }));
  assert.equal(bad.problems.length, 5, bad.problems.join("\n"));
});

test("a run is flagged for review by the agent, failed evals, low confidence, log errors or a missing output", async () => {
  const { flagRun, reviewState } = await import("../worker/src/review.js");
  assert.deepEqual(flagRun({ output: { evals: { format: true }, confidence: 0.9 }, trigger: "http" }), []);
  const flags = flagRun({ output: { review: true, confidence: 0.4, evals: { format: false, facts: { pass: false }, length: 0.2 } }, problems: ["Error: x"], trigger: "review" });
  assert.deepEqual(flags, ["the agent asked for review", "a revision you asked for", "confidence 0.4 is below 0.7", "eval format failed", "eval facts failed", "errors in the log: Error: x"]);
  const agent = (when) => ({ review: { then: "send", when, min_confidence: 0.7 } });
  const run = { trigger: "http" };
  assert.deepEqual(reviewState(agent("flagged"), run, "ok", { confidence: 0.9 }, []), { review: "auto", flags: [] });
  assert.equal(reviewState(agent("flagged"), run, "ok", { confidence: 0.1 }, []).review, "waiting");
  assert.equal(reviewState(agent("always"), run, "ok", { confidence: 0.9 }, []).review, "waiting");
  assert.equal(reviewState(agent("always"), run, "ok", { review: false }, []).review, null);
  assert.equal(reviewState(agent("always"), { trigger: "replay" }, "ok", {}, []).review, null);
  assert.equal(reviewState(agent("always"), run, "failed", {}, []).review, null);
});

test("the gate blocks a candidate that does worse than the live version on the same inputs", async () => {
  const { judgeGate } = await import("../worker/src/loop.js");
  const r = (version, status, evals) => ({ agent: "draft", version, status, output: { evals } });
  const same = [r("cand", "ok", { short: true }), r("live", "ok", { short: true }), r("cand", "ok", { short: true }), r("live", "ok", { short: false })];
  assert.equal(judgeGate(same, "cand").status, "passed");
  const worse = [r("cand", "ok", { short: false, len: 3 }), r("live", "ok", { short: true, len: 5 }), r("cand", "failed", {}), r("live", "ok", { short: true, len: 5 })];
  const v = judgeGate(worse, "cand");
  assert.equal(v.status, "blocked");
  assert.deepEqual(v.agents[0].worse, ["ok rate 50% vs 100% live", "eval short passes 0% vs 100% live", "eval len averages 3 vs 5 live"]);
  assert.equal(judgeGate([r("cand", "ok", { len: 4.6 }), r("live", "ok", { len: 5 })], "cand", 0.5).status, "passed", "within tolerance");
});

test("the gateway reads model and tokens from Anthropic and OpenAI responses, streamed or not", async () => {
  const { usageOf } = await import("../worker/src/gateway.js");
  assert.deepEqual(usageOf(JSON.stringify({ model: "claude-x", usage: { input_tokens: 12, output_tokens: 34 } })), { model: "claude-x", input_tokens: 12, output_tokens: 34 });
  const sse = ['event: message_start', 'data: {"type":"message_start","message":{"model":"claude-y","usage":{"input_tokens":20,"output_tokens":1}}}', "",
    'data: {"type":"content_block_delta","delta":{"text":"hi"}}', 'data: {"type":"message_delta","usage":{"output_tokens":55}}', ""].join("\n");
  assert.deepEqual(usageOf(sse), { model: "claude-y", input_tokens: 20, output_tokens: 55 });
  assert.deepEqual(usageOf(JSON.stringify({ model: "gpt-z", usage: { prompt_tokens: 7, completion_tokens: 8 } })), { model: "gpt-z", input_tokens: 7, output_tokens: 8 });
  assert.deepEqual(usageOf("not json"), { model: null, input_tokens: null, output_tokens: null });
});

const JUDGE = { provider: "jev", key: "JUDGE_KEY", questions: {
  rude: { type: "noul", instructions: "Is the reply rude?", pass: "no" },
  team: { type: "choice", instructions: "Which team?", criteria: { billing: "money", tech: "bugs", spam: "junk" }, pass: ["billing", "tech"] },
  quality: { type: "score", instructions: "How good?", criteria: ["bad", "ok", "great"], min: 1 },
} };

test("judge settings are checked: provider, model, url, questions and pass rules", () => {
  const ok = parseConfig(JSON.stringify({ agents: [{ name: "a", run: "x" }], judge: JUDGE }));
  assert.deepEqual(ok.problems, []);
  assert.deepEqual([ok.config.judge.model, ok.config.judge.gate, ok.config.judge.questions.rude.threshold], ["jev-latest", false, 0.5]);
  assert.equal(parseConfig(JSON.stringify({ agents: [{ name: "a", run: "x" }], judge: { provider: "gemini", questions: JUDGE.questions } })).config.judge.model, "gemini-decision-1");
  const bad = parseConfig(JSON.stringify({ agents: [{ name: "a", run: "x" }], judge: { provider: "openai", key: "lower", agents: ["ghost"], questions: {
    q1: { type: "noul", instructions: "x", pass: "maybe" }, q2: { type: "choice", instructions: "x", criteria: { only: "" }, pass: ["nope"] },
    q3: { type: "score", instructions: "x", criteria: ["a", "b"], min: 5 }, q4: { type: "vibe", instructions: "x" } } } }));
  assert.equal(bad.problems.length, 9, bad.problems.join("\n"));
});

const fakeFetch = (reply, seen = []) => async (url, init) => {
  seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
  const body = typeof reply === "function" ? reply(JSON.parse(init.body)) : reply;
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

test("the judge asks Jev and Gemini in their own request shapes and grades the answers", async () => {
  const { parseConfig: _p } = await import("../worker/src/config.js");
  const { judgeRun } = await import("../cli/judge.mjs");
  const judge = parseConfig(JSON.stringify({ agents: [{ name: "a", run: "x" }], judge: JUDGE })).config.judge;
  const answers = { rude: { type: "noul", noul: 0.9 }, team: { type: "choice", choice: "spam", probabilities: { billing: 0.1, tech: 0.1, spam: 0.8 } },
    quality: { type: "score", score: 1.4, probabilities: { 0: 0.1, 1: 0.4, 2: 0.5 } } };
  const seen = [];
  const r = await judgeRun(judge, "k1", "STATE", fakeFetch({ model: "jev-1.13.0", answers, usage: { input_tokens: 10, output_tokens: 3 } }, seen));
  assert.equal(seen[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(seen[0].headers.authorization, "Bearer k1");
  assert.deepEqual(Object.keys(seen[0].body), ["model", "state", "questions"]);
  assert.deepEqual(seen[0].body.questions.rude, { type: "noul", instructions: "Is the reply rude?" });
  assert.deepEqual(Object.fromEntries(Object.entries(r.results).map(([k, x]) => [k, [x.good, x.pass]])), { rude: [0.1, false], team: [0.2, false], quality: [1.4, true] });
  assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 3 });
  assert.equal(r.model, "jev-1.13.0", "the model that answered, not the alias");
  const gseen = [];
  await judgeRun({ ...judge, provider: "gemini", model: "gemini-decision-1" }, "k2", "STATE", fakeFetch({ answers, usage: { total_input_tokens: 5, total_output_tokens: 0 } }, gseen));
  assert.equal(gseen[0].url, "https://generativelanguage.googleapis.com/v1beta/decisions");
  assert.equal(gseen[0].headers["x-goog-api-key"], "k2");
  assert.deepEqual(Object.keys(gseen[0].body), ["model", "input", "questions"]);
  await assert.rejects(judgeRun(judge, "k1", "S", fakeFetch({ answers: { rude: answers.rude } })), /did not answer "team"/);
});

test("an open-weight judge on an OpenAI-compatible server is read from token logprobs", async () => {
  const { judgeRun, letterProbabilities } = await import("../cli/judge.mjs");
  const lp = (pairs) => ({ logprobs: { content: [{ top_logprobs: pairs.map(([token, p]) => ({ token, logprob: Math.log(p) })) }] } });
  assert.deepEqual(letterProbabilities(lp([[" A", 0.6], ["A", 0.1], ["B", 0.2], ["Z", 0.1]]), ["yes", "no"]), { yes: 0.778, no: 0.222 });
  assert.deepEqual(letterProbabilities({ message: { content: "B" } }, ["yes", "no"]), { yes: 0, no: 1 }, "a server without logprobs still answers");
  const judge = { provider: "openai", model: "qwen", url: "http://localhost:11434/v1/", questions: {
    rude: { type: "noul", instructions: "Rude?", pass: "no", threshold: 0.5 },
    quality: { type: "score", instructions: "How good?", criteria: ["bad", "ok", "great"], min: 1 } } };
  const seen = [];
  const r = await judgeRun(judge, null, "STATE", fakeFetch((b) => ({ choices: [b.messages[0].content.includes("Rude?") ? lp([["B", 0.9], ["A", 0.1]]) : lp([["C", 0.5], ["B", 0.5]])], usage: { prompt_tokens: 7, completion_tokens: 1 } }), seen));
  assert.equal(seen[0].url, "http://localhost:11434/v1/chat/completions");
  assert.deepEqual([seen[0].body.max_tokens, seen[0].body.logprobs, seen[0].headers.authorization], [1, true, undefined]);
  assert.deepEqual([r.results.rude.good, r.results.rude.pass, r.results.quality.good, r.results.quality.pass], [0.9, true, 1.5, true]);
  assert.deepEqual(r.usage, { input_tokens: 14, output_tokens: 2 });
});

test("judge answers become evals, flag a run when they fail, and are measured against the person", async () => {
  const { withJudge, judgeAgreement } = await import("../worker/src/loop.js");
  const { reviewState } = await import("../worker/src/review.js");
  const judge = { model: "m", results: { rude: { good: 0.1, pass: false }, team: { good: null, pass: null } } };
  assert.deepEqual(withJudge({ a: 1, evals: { own: true } }, judge), { a: 1, evals: { own: true, "judge.rude": { pass: false, score: 0.1 } } });
  assert.equal(withJudge({ a: 1 }, { error: "x" }).evals, undefined);
  const agent = { review: { then: null, when: "flagged", min_confidence: 0.7 } };
  assert.deepEqual(reviewState(agent, { trigger: "http" }, "ok", { confidence: 0.9 }, [], judge).flags, ["eval judge.rude failed"]);
  assert.deepEqual(reviewState(agent, { trigger: "http" }, "ok", { confidence: 0.9 }, [], { error: "HTTP 500" }).flags, ["the judge could not answer: HTTP 500"]);
  const pass = { results: { rude: { pass: true } } }, fail = { results: { rude: { pass: false } } };
  assert.deepEqual(judgeAgreement([{ judge: pass, review: "approved" }, { judge: fail, review: "rejected" }, { judge: fail, review: "approved" }, { judge: pass, review: "auto" }, { judge: null, review: "approved" }]),
    { n: 3, rate: 0.667 });
});

test("a misspelt key is a problem, not silently ignored", () => {
  const { problems } = parseConfig(JSON.stringify({ agents: [{ name: "a", run: "x", reveiw: { then: "b" } }], gaet: true }));
  assert.ok(problems.some((p) => /agents\[0\]: unknown key "reveiw"; did you mean "review"\?/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /unknown key "gaet"; did you mean "gate"\?/.test(p)), problems.join("\n"));
  assert.deepEqual(parseConfig(JSON.stringify({ $schema: "x", agents: [{ name: "a", run: "x" }] })).problems, []);
});

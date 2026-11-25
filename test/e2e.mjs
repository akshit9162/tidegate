// End to end against a running Tidegate and runner:
//   npm run dev:e2e          (wrangler dev, with the model APIs pointed at this test's mock on :8799)
//   tidegate runner            (or tidegate runner --isolate docker)
//   node test/e2e.mjs
// Deploys examples/ticket-triage under a fresh name and checks every promise on the real API.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const API = process.env.TIDEGATE_API ?? "http://localhost:8787";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.join(HERE, "..", "cli", "tidegate.mjs");
const work = await mkdtemp(path.join(tmpdir(), "tidegate-e2e-"));
const env = { ...process.env, TIDEGATE_API: API, TIDEGATE_HOME: path.join(work, "home") };
delete env.RUNNER_TOKEN;
const name = `triage-${Date.now().toString(36)}`;
const dir = path.join(work, name);
await cp(path.join(HERE, "..", "examples", "ticket-triage"), dir, { recursive: true });

const tidegate = async (...args) => {
  try {
    const { stdout } = await promisify(execFile)("node", [CLI, ...args], { cwd: dir, env, timeout: 300_000 });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.code, out: `${e.stdout}${e.stderr}` };
  }
};
const token = async () => JSON.parse(await readFile(path.join(env.TIDEGATE_HOME, "credentials.json"), "utf8"))[API][name];
const api = async (route, opts = {}) => {
  const res = await fetch(API + route, { ...opts, headers: { authorization: `Bearer ${await token()}`, ...(opts.headers ?? {}) } });
  return { status: res.status, body: await res.json() };
};
const config = async (edit) => {
  const p = path.join(dir, "tidegate.json");
  const c = JSON.parse(await readFile(p, "utf8"));
  edit(c);
  await writeFile(p, JSON.stringify(c, null, 1));
};
const step = (s) => console.log(`- ${s}`);

// Extra agents only this test needs: one prints whether the runner's token leaked, one overruns its timeout.
await writeFile(path.join(dir, "envcheck.py"), "import os\nprint('runner token visible:', 'RUNNER_TOKEN' in os.environ)\nprint('api key set:', bool(os.environ.get('ANTHROPIC_API_KEY')))\n");
await writeFile(path.join(dir, "slow.py"), "import time\ntime.sleep(30)\n");
await config((c) => c.agents.push({ name: "envcheck", run: "python3 envcheck.py", secrets: ["ANTHROPIC_API_KEY"] }, { name: "slow", run: "python3 slow.py", timeout: "3s" }));

let r = await tidegate("deploy", "--name", name);
assert.equal(r.code, 0, r.out);
assert.match(r.out, /Checks running on a runner/);
assert.match(r.out, /Live: /);
step("deploy: uploaded, unit tests ran on the runner, went live");

r = await tidegate("deploy", "--name", name);
assert.match(r.out, /0 new to upload/);
const first = (await api(`/api/projects/${name}`)).body.production;
step("redeploy: unchanged files are not uploaded again");

r = await tidegate("invoke", "triage", JSON.stringify({ ticket: "Site is down, we were charged twice" }));
assert.equal(r.code, 0, r.out);
let out = JSON.parse(r.out);
assert.deepEqual([out.urgency, out.team, out.tickets_so_far], ["high", "billing", 1]);
out = JSON.parse((await tidegate("invoke", "triage", JSON.stringify({ ticket: "How do I export a CSV?" }))).out);
assert.deepEqual([out.urgency, out.team, out.tickets_so_far], ["normal", "general", 2]);
step("invoke over HTTP: input in, output back, state file kept between runs");

let res = await fetch(`${API}/p/${name}/triage`, { method: "POST", body: "{}" });
assert.equal(res.status, 401);
res = await fetch(`${API}/p/${name}/digest`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${await token()}` } });
assert.equal(res.status, 404);
step("an agent needs the token unless public; an agent with http: false has no endpoint");

r = await tidegate("invoke", "envcheck");
let runs = (await api(`/api/projects/${name}/runs`)).body.runs;
let log = await (await fetch(`${API}/api/runs/${runs[0].id}/log`, { headers: { authorization: `Bearer ${await token()}` } })).text();
assert.match(log, /runner token visible: False/);
assert.match(log, /secrets not set: ANTHROPIC_API_KEY/);
await promisify(execFile)("sh", ["-c", `printf 'test-value' | node ${CLI} secret set ANTHROPIC_API_KEY`], { cwd: dir, env });
await tidegate("invoke", "envcheck");
runs = (await api(`/api/projects/${name}/runs`)).body.runs;
log = await (await fetch(`${API}/api/runs/${runs[0].id}/log`, { headers: { authorization: `Bearer ${await token()}` } })).text();
assert.match(log, /api key set: True/);
step("secrets: missing ones are named in the log, set ones reach the agent, the runner's token never does");

r = await tidegate("invoke", "slow", "{}", "--wait", "20");
assert.equal(r.code, 1);
assert.match(r.out, /"timeout"/);
step("timeout: an agent that overruns is stopped and recorded as a timeout");

const digest = (await api(`/api/projects/${name}/runs?limit=100`)).body.runs.find((x) => x.agent === "digest" && x.trigger === "schedule");
assert.ok(digest, "the scheduled digest was queued");
step(`schedule: digest was queued by the scheduler (status ${digest.status})`);

await writeFile(path.join(dir, "tests", "test_broken.py"), "import unittest\nclass T(unittest.TestCase):\n    def test_x(self):\n        self.assertEqual(1, 2)\n");
r = await tidegate("deploy", "--name", name);
assert.match(r.out, /Not published/);
assert.equal((await api(`/api/projects/${name}`)).body.production, first);
step("a version whose tests fail on the runner is not published; production stays put");

await config((c) => c.agents.push({ name: "ghost", run: "python3 ghost.py" }));
r = await tidegate("deploy", "--name", name);
assert.equal(r.code, 1);
assert.match(r.out, /ghost\.py, which is not in the upload/);
step("a missing entry file fails the deploy in the Worker, before any runner work");

await config((c) => (c.agents = c.agents.filter((a) => a.name !== "ghost")));
await writeFile(path.join(dir, "tests", "test_broken.py"), "");
r = await tidegate("deploy", "--name", name);
assert.match(r.out, /Live: /);
const second = (await api(`/api/projects/${name}`)).body.production;
assert.notEqual(second, first);
r = await tidegate("rollback");
assert.match(r.out, new RegExp(`Production is now ${first}`));
step("rollback: production points back at the previous ready version");

// Review: draft writes a file and waits; revise reruns it with the note; approve hands output and file to send.
await writeFile(path.join(dir, "draft.py"), `import json, os
inp = json.load(open(os.environ["TIDEGATE_INPUT"])) or {}
note = (inp.get("revise") or {}).get("note", "")
prev = os.path.join(os.environ["TIDEGATE_INPUT_FILES"], "draft.txt")
text = ("v2 " + note) if note else "v1 " + inp.get("topic", "")
if note: assert open(prev).read().startswith("v1"), "the previous draft is handed back"
open(os.path.join(os.environ["TIDEGATE_FILES"], "draft.txt"), "w").write(text)
json.dump({"title": "Draft for " + inp.get("topic", ""), "summary": text, "review": inp.get("topic") != "skip",
           "evals": {"short": len(text) < 12, "length": len(text)}}, open(os.environ["TIDEGATE_OUTPUT"], "w"))
`);
await writeFile(path.join(dir, "send.py"), `import json, os
inp = json.load(open(os.environ["TIDEGATE_INPUT"]))
sent = open(os.path.join(os.environ["TIDEGATE_INPUT_FILES"], "draft.txt")).read()
json.dump({"sent": sent, "note": inp["note"], "title": inp["output"]["title"]}, open(os.environ["TIDEGATE_OUTPUT"], "w"))
`);
await config((c) => c.agents.push({ name: "draft", run: "python3 draft.py", review: { then: "send" } }, { name: "send", run: "python3 send.py", http: false }));
r = await tidegate("deploy", "--name", name);
assert.match(r.out, /Live: /, r.out);
out = JSON.parse((await tidegate("invoke", "draft", JSON.stringify({ topic: "pricing" }))).out);
assert.equal(out.summary, "v1 pricing");
let waiting = (await api(`/api/projects/${name}/reviews`)).body.reviews;
assert.equal(waiting.length, 1);
assert.deepEqual(waiting[0].files, ["draft.txt"]);
const fileRes = await fetch(`${API}/api/runs/${waiting[0].id}/files/draft.txt`, { headers: { authorization: `Bearer ${await token()}` } });
assert.equal(await fileRes.text(), "v1 pricing");
r = await tidegate("revise", waiting[0].id);
assert.equal(r.code, 1, "revise needs a note");
r = await tidegate("revise", waiting[0].id, "--note", "shorter");
assert.match(r.out, /revised\. Queued run (\w+)/);
const revision = /Queued run (\w+)/.exec(r.out)[1];
const until = Date.now() + 60_000;
let rev;
while (Date.now() < until && (rev = (await api(`/api/runs/${revision}`)).body).review !== "waiting") await new Promise((res) => setTimeout(res, 1000));
assert.equal(rev.review, "waiting", JSON.stringify(rev));
assert.equal(rev.output.summary, "v2 shorter");
assert.equal(rev.parent, waiting[0].id);
r = await tidegate("approve", revision, "--note", "ship it");
const sendRun = /Queued run (\w+)/.exec(r.out)[1];
r = await tidegate("approve", revision);
assert.match(r.out, /already approved/);
let sent;
while (Date.now() < until && !["ok", "failed"].includes((sent = (await api(`/api/runs/${sendRun}`)).body).status)) await new Promise((res) => setTimeout(res, 1000));
assert.deepEqual(sent.output, { sent: "v2 shorter", note: "ship it", title: "Draft for pricing" });
assert.equal(sent.review, null);
out = JSON.parse((await tidegate("invoke", "draft", JSON.stringify({ topic: "faq" }))).out);
waiting = (await api(`/api/projects/${name}/reviews`)).body.reviews;
r = await tidegate("reject", waiting[0].id, "--note", "off topic");
assert.match(r.out, /rejected\.$/m);
assert.equal((await api(`/api/projects/${name}/reviews`)).body.reviews.length, 0);
step("review: a draft waits with its file; revise reruns it with the note; approve runs send once with output, note and file; reject stops");

await tidegate("invoke", "draft", JSON.stringify({ topic: "skip" }));
assert.equal((await api(`/api/projects/${name}/reviews`)).body.reviews.length, 0, "an output with review: false does not wait");
let card = (await api(`/api/projects/${name}/scorecard?agent=draft`)).body;
const live = card.scorecard.find((x) => x.version === card.production && x.kind === "live");
assert.deepEqual([live.reviewed, live.approved, live.revised, live.rejected], [3, 1, 1, 1]);
assert.equal(live.evals.short.n, live.runs);
step(`scorecard: live draft runs ${live.runs}, approved ${live.approval_rate}, evals ${Object.keys(live.evals).join(", ")}`);

// The loop: change the agent, deploy it as a candidate that replays real inputs once its checks pass, compare, promote.
const liveVersion = card.production;
await writeFile(path.join(dir, "draft.py"), (await readFile(path.join(dir, "draft.py"), "utf8")).replace('"v1 " + inp', '"v1! " + inp'));
r = await tidegate("deploy", "--name", name, "--no-promote", "--replay", "draft:3");
assert.match(r.out, /Replaying draft's last 3 inputs on (\w+)/, r.out);
const candidate = /on (\w+)\./.exec(r.out.split("Replaying")[1])[1];
let replayRow;
for (const until = Date.now() + 90_000; Date.now() < until; await new Promise((res) => setTimeout(res, 1500))) {
  card = (await api(`/api/projects/${name}/scorecard?agent=draft`)).body;
  replayRow = card.scorecard.find((x) => x.version === candidate && x.kind === "replay");
  if (replayRow?.runs === 3) break;
}
assert.equal(replayRow?.runs, 3, JSON.stringify(card.scorecard));
assert.equal(card.production, liveVersion, "a candidate is not live until promoted");
assert.equal(replayRow.reviewed + replayRow.waiting, 0, "replays are not reviewed");
r = await tidegate("promote", candidate);
assert.match(r.out, new RegExp(`Production is now ${candidate}`));
step(`loop: candidate ${candidate} replayed 3 real inputs (evals ${JSON.stringify(replayRow.evals.length)}), then promoted`);

const waitRun = async (id, done = (x) => ["ok", "failed", "timeout"].includes(x.status), ms = 90_000) => {
  let x;
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((res) => setTimeout(res, 1000))) if (done((x = (await api(`/api/runs/${id}`)).body))) return x;
  assert.fail(`run ${id} did not settle: ${JSON.stringify(x)}`);
};
const lastRun = async (agent) => (await api(`/api/projects/${name}/runs?limit=200`)).body.runs.find((x) => x.agent === agent);

// 1. Review only what is flagged; a person's edit becomes the output and a labelled example.
await writeFile(path.join(dir, "label.py"), `import json, os
inp = json.load(open(os.environ["TIDEGATE_INPUT"])) or {}
ex = json.load(open(os.environ["TIDEGATE_EXAMPLES"]))
json.dump({"label": "spam" if "win" in inp.get("text", "") else "ham", "confidence": inp.get("confidence", 0.9),
           "examples_seen": [e["output"].get("label") for e in ex["good"]], "example_sources": [e["source"] for e in ex["good"]]},
          open(os.environ["TIDEGATE_OUTPUT"], "w"))
`);
await writeFile(path.join(dir, "sink.py"), `import json, os
json.dump(json.load(open(os.environ["TIDEGATE_INPUT"])), open(os.environ["TIDEGATE_OUTPUT"], "w"))
`);
await config((c) => c.agents.push({ name: "label", run: "python3 label.py", review: { then: "sink", when: "flagged", min_confidence: 0.6 } }, { name: "sink", run: "python3 sink.py", http: false }));
r = await tidegate("deploy", "--name", name);
assert.match(r.out, /Live: /, r.out);
await tidegate("invoke", "label", JSON.stringify({ text: "hello", confidence: 0.95 }));
let auto = await lastRun("label");
assert.equal(auto.review, "auto", JSON.stringify(auto));
let sink = await waitRun((await waitRun(auto.id, (x) => x.next_run)).next_run);
assert.equal(sink.output.output.label, "ham");
await tidegate("invoke", "label", JSON.stringify({ text: "you win", confidence: 0.3 }));
const flagged = await lastRun("label");
assert.equal(flagged.review, "waiting");
assert.deepEqual(flagged.flags, ["confidence 0.3 is below 0.6"]);
r = await tidegate("reviews");
assert.match(r.out, /flagged: confidence 0\.3/);
r = await tidegate("correct", flagged.id, "--output", JSON.stringify({ label: "spam-promo", confidence: 1 }), "--note", "promos are their own label");
assert.match(r.out, /corrected\. Queued run (\w+)/, r.out);
sink = await waitRun(/Queued run (\w+)/.exec(r.out)[1]);
assert.deepEqual([sink.output.output.label, sink.output.corrected, sink.output.note], ["spam-promo", true, "promos are their own label"]);
assert.deepEqual((await api(`/api/runs/${flagged.id}`)).body.corrected, { label: "spam-promo", confidence: 1 });
step("review.when flagged: a confident run is approved automatically and its next agent runs; a low-confidence one waits; a correction replaces the output");

// 4. Built-in few-shot: the next run sees the corrected output in $TIDEGATE_EXAMPLES, but not its own input.
out = JSON.parse((await tidegate("invoke", "label", JSON.stringify({ text: "free cruise", confidence: 0.95 }))).out);
assert.deepEqual([out.examples_seen, out.example_sources], [["spam-promo"], ["corrected"]]);
out = JSON.parse((await tidegate("invoke", "label", JSON.stringify({ text: "you win", confidence: 0.3 }))).out);
assert.deepEqual(out.examples_seen, [], "a run never sees its own input's answer");
step("examples: corrected outputs reach later runs in $TIDEGATE_EXAMPLES, never the run whose input they answer");

// 2. Traces with no instrumentation: the agent calls the model API it always would; Tidegate records the calls.
const seen = [], judged = [];
const mock = createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const body = JSON.parse(b || "{}");
    if (req.url === "/v1/systemone") {
      judged.push({ auth: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "jev-mock", answers: { rude: { type: "noul", noul: body.state.includes("idiot") ? 0.93 : 0.04 } }, usage: { input_tokens: 50, output_tokens: 0 } }));
      return;
    }
    seen.push({ path: req.url, key: req.headers["x-api-key"] });
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: body.model, usage: { input_tokens: 21, output_tokens: 1 } } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "hi" } })}\n\n`);
      res.end(`data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 9 } })}\n\n`);
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: body.model, content: [{ type: "text", text: "ok" }], usage: { input_tokens: 11, output_tokens: 4 } }));
    }
  });
});
await new Promise((res) => mock.listen(8799, "0.0.0.0", res));
await writeFile(path.join(dir, "llm.py"), `import json, os, urllib.request
base = os.environ["ANTHROPIC_BASE_URL"]
def ask(stream):
    req = urllib.request.Request(base + "/v1/messages", method="POST", headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"], "content-type": "application/json"},
        data=json.dumps({"model": "claude-test", "max_tokens": 5, "stream": stream, "messages": [{"role": "user", "content": "hi"}]}).encode())
    return urllib.request.urlopen(req).read().decode()
plain, streamed = ask(False), ask(True)
json.dump({"plain": json.loads(plain)["content"][0]["text"], "streamed": "message_delta" in streamed}, open(os.environ["TIDEGATE_OUTPUT"], "w"))
`);
await config((c) => c.agents.push({ name: "llm", run: "python3 llm.py", secrets: ["ANTHROPIC_API_KEY"] }));
r = await tidegate("deploy", "--name", name);
assert.match(r.out, /Live: /, r.out);
r = await tidegate("invoke", "llm");
assert.deepEqual(JSON.parse(r.out), { plain: "ok", streamed: true }, r.out);
assert.deepEqual(seen.map((x) => [x.path, x.key]), [["/v1/messages", "test-value"], ["/v1/messages", "test-value"]], "calls reach the provider with the agent's own key");
const llmRun = await lastRun("llm");
let trace;
for (const end = Date.now() + 15_000; Date.now() < end; await new Promise((res) => setTimeout(res, 500))) if ((trace = (await api(`/api/runs/${llmRun.id}/calls`)).body).calls.length === 2) break;
assert.deepEqual(trace.calls.map((c) => [c.provider, c.model, c.status, c.input_tokens, c.output_tokens]), [["anthropic", "claude-test", 200, 11, 4], ["anthropic", "claude-test", 200, 21, 9]]);
const callBody = JSON.stringify((await api(`/api/calls/${trace.calls[0].id}`)).body);
assert.match(callBody, /claude-test/);
assert.doesNotMatch(callBody, /test-value/, "the API key is not stored");
r = await tidegate("trace", llmRun.id);
assert.match(r.out, /2 calls, 32 tokens in, 13 out/, r.out);
res = await fetch(`${API}/gw/${"0".repeat(48)}/anthropic/v1/messages`, { method: "POST", body: "{}" });
assert.equal(res.status, 401, "the gateway only serves running runs");
step("traces: model calls (plain and streamed) go through the gateway with no code change; model, tokens and time recorded; keys not stored");

// The judge: a decision model (here a mock of TypeSafe's API) answers typed questions about each run.
await writeFile(path.join(dir, "reply.py"), `import json, os
inp = json.load(open(os.environ["TIDEGATE_INPUT"]))
json.dump({"reply": "you idiot" if inp.get("mood") == "bad" else "happy to help", "confidence": 0.95}, open(os.environ["TIDEGATE_OUTPUT"], "w"))
`);
await config((c) => {
  c.agents.push({ name: "reply", run: "python3 reply.py", review: { then: "sink", when: "flagged" } });
  c.judge = { provider: "jev", url: "http://127.0.0.1:8799/v1/systemone", key: "JUDGE_KEY", agents: ["reply"],
    questions: { rude: { type: "noul", instructions: "Is the reply rude to the customer?", pass: "no" } } };
});
await promisify(execFile)("sh", ["-c", `printf 'test-judge' | node ${CLI} secret set JUDGE_KEY`], { cwd: dir, env });
r = await tidegate("deploy", "--name", name);
assert.match(r.out, /Live: /, r.out);
await tidegate("invoke", "reply", JSON.stringify({ mood: "good" }));
const kind = await waitRun((await lastRun("reply")).id);
assert.equal(kind.review, "auto", JSON.stringify(kind));
assert.deepEqual([kind.judge.model, kind.judge.results.rude.pass, kind.judge.results.rude.good], ["jev-mock", true, 0.96]);
await tidegate("invoke", "reply", JSON.stringify({ mood: "bad" }));
const rude = await waitRun((await lastRun("reply")).id);
assert.equal(rude.review, "waiting");
assert.deepEqual(rude.flags, ["eval judge.rude failed"]);
assert.equal(judged[0].auth, "Bearer test-judge");
assert.match(judged[1].body.state, /"mood": "bad"/);
assert.deepEqual(judged[1].body.questions.rude, { type: "noul", instructions: "Is the reply rude to the customer?" });
await tidegate("reject", rude.id, "--note", "rude");
const replyCard = (await api(`/api/projects/${name}/scorecard?agent=reply`)).body.scorecard.find((x) => x.kind === "live");
assert.deepEqual([replyCard.judge_agreement, replyCard.evals["judge.rude"].pass_rate], [{ n: 1, rate: 1 }, 0.5]);
step("judge: a decision model grades every run; a polite reply goes through, a rude one is flagged; the scorecard shows how often it agrees with you");

mock.close();

// 3. The deploy gate: a worse candidate is blocked, an equal one goes live.
await config((c) => (c.gate = { replay: 3, agents: ["draft"] }));
const gatedLive = (await api(`/api/projects/${name}`)).body.production;
const draftSrc = await readFile(path.join(dir, "draft.py"), "utf8");
await writeFile(path.join(dir, "draft.py"), draftSrc.replace('"v1! " + inp', '"a much longer first draft " + inp'));
r = await tidegate("deploy", "--name", name);
assert.equal(r.code, 1, r.out);
assert.match(r.out, /Blocked by the gate/, r.out);
assert.match(r.out, /eval short passes 0% vs 100% live/, r.out);
assert.equal((await api(`/api/projects/${name}`)).body.production, gatedLive, "a blocked version does not go live");
await writeFile(path.join(dir, "draft.py"), draftSrc);
r = await tidegate("deploy", "--name", name);
assert.equal(r.code, 0, r.out);
assert.match(r.out, /Gate passed/, r.out);
assert.notEqual((await api(`/api/projects/${name}`)).body.production, gatedLive);
card = (await api(`/api/projects/${name}/scorecard?agent=draft`)).body;
assert.ok(!card.scorecard.some((x) => x.version !== card.production && x.version !== gatedLive && x.kind === "replay" && x.runs === 6), "gate replays stay out of the scorecard");
step("gate: a candidate whose evals drop on the same inputs is blocked and the live version stays; an equal one goes live");

// 5. git push to deploy, through the git-remote-tidegate helper.
const bin = path.join(work, "bin");
await mkdir(bin);
await symlink(path.join(HERE, "..", "cli", "git-remote-tidegate.mjs"), path.join(bin, "git-remote-tidegate"));
const git = (...args) => promisify(execFile)("git", args, { cwd: dir, env: { ...env, PATH: `${bin}:${env.PATH}`, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.com" }, timeout: 600_000 });
await git("init", "-q", "-b", "main");
await writeFile(path.join(dir, ".gitignore"), ".tidegate/\n__pycache__/\n");
await git("add", "-A");
await git("commit", "-q", "-m", "agents");
await git("remote", "add", "tidegate", `tidegate::${name}`);
const before = (await api(`/api/projects/${name}`)).body.production;
const pushed = await git("push", "tidegate", "main");
assert.match(pushed.stderr, /tidegate: deploying [0-9a-f]{12}/, pushed.stderr);
assert.match(pushed.stderr, /Gate passed/, pushed.stderr);
assert.notEqual((await api(`/api/projects/${name}`)).body.production, before, "the pushed commit is live");
step("git push tidegate main: the pushed commit is deployed, gated, and goes live");

if (process.env.E2E_ISOLATE === "docker") {
  await writeFile(path.join(dir, "peek.py"), `import json, os
json.dump({"host_home_visible": os.path.exists("/Users") or os.path.exists("/home/" + os.environ.get("USER", "-")), "cwd": os.getcwd()}, open(os.environ["TIDEGATE_OUTPUT"], "w"))
`);
  await config((c) => c.agents.push({ name: "peek", run: "python3 peek.py" }));
  await writeFile(path.join(dir, "Dockerfile"), "FROM python:3.12-slim\nENV FROM_PROJECT_DOCKERFILE=1\n");
  await writeFile(path.join(dir, "peek.py"), (await readFile(path.join(dir, "peek.py"), "utf8")).replace('"cwd"', '"own_image": os.environ.get("FROM_PROJECT_DOCKERFILE") == "1", "cwd"'));
  r = await tidegate("deploy", "--name", name);
  assert.equal(r.code, 0, r.out);
  out = JSON.parse((await tidegate("invoke", "peek", "{}", "--wait", "30")).out);
  assert.deepEqual(out, { host_home_visible: false, own_image: true, cwd: "/work" });
  step("isolation: runs execute in a container built from the project's Dockerfile and cannot see the runner's files");
}

const view = (await api(`/api/projects/${name}/runs?limit=200`)).body;
assert.ok(view.runs.some((x) => x.status === "timeout" && x.problems[0].includes("timeout")));
step(`runs view: ${view.runs.length} runs recorded with status, trigger and problems`);
console.log(`\nAll checks passed for ${name}.`);

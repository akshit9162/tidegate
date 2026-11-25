// Work for runners: scheduling agents, handing out runs, and taking back their results.
// A run moves queued -> running -> ok | failed | timeout, and each move is one conditional UPDATE,
// so two runners never get the same run and a retried request changes nothing.
import { settleGates } from "./loop.js";
import { examplesFor, reviewState, runThen } from "./review.js";
import { markReady, versionFiles, versionMeta } from "./versions.js";
import { HttpError, SHA, bearer, body, decrypt, json, newId, now, problemLines, sha256 } from "./util.js";

const STALE = 180; // a running run with no heartbeat for 3 minutes has lost its runner
export const MAX_OUTPUT = 256 * 1024;
export const MAX_RUN_FILES = 20;
export const FILE_NAME = /^[\w][\w.-]{0,99}$/;

function runnerAuth(env, request) {
  if (!env.RUNNER_TOKEN || bearer(request) !== env.RUNNER_TOKEN) throw new HttpError(401, "runner token required");
}

export async function queueRun(env, { project, agent, version, trigger, input = null, parent = null, inputFiles = null, replayOf = null, gate = null }) {
  const id = newId();
  await env.DB.prepare("INSERT INTO runs (id, project, kind, agent, trigger, version, status, input, queued_at, parent, input_files, replay_of, gate) VALUES (?, ?, 'agent', ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)")
    .bind(id, project, agent, trigger, version, input == null ? null : JSON.stringify(input), now(), parent, inputFiles ? JSON.stringify(inputFiles) : null, replayOf, gate).run();
  return id;
}

export async function schedule(env) {
  const t = now();
  const lost = (await env.DB.prepare("UPDATE runs SET status = 'failed', ended_at = ?, problems = ? WHERE status = 'running' AND heartbeat_at < ? RETURNING kind, version")
    .bind(t, JSON.stringify(["the runner stopped responding"]), t - STALE).all()).results;
  for (const r of lost.filter((r) => r.kind === "check")) {
    await env.DB.prepare("UPDATE versions SET status = 'failed', problems = ? WHERE id = ? AND status = 'checking'")
      .bind(JSON.stringify(["the runner stopped responding during the checks; deploy again"]), r.version).run();
  }
  await settleGates(env);
  const projects = (await env.DB.prepare("SELECT p.name, p.production, v.config FROM projects p JOIN versions v ON v.id = p.production").all()).results;
  let queued = 0;
  for (const p of projects) {
    for (const a of JSON.parse(p.config).agents ?? []) {
      if (!a.every) continue;
      const last = await env.DB.prepare("SELECT status, queued_at FROM runs WHERE project = ? AND agent = ? AND trigger = 'schedule' ORDER BY queued_at DESC LIMIT 1")
        .bind(p.name, a.name).first();
      if (last && (["queued", "running"].includes(last.status) || t - last.queued_at < a.every)) continue;
      await queueRun(env, { project: p.name, agent: a.name, version: p.production, trigger: "schedule" });
      queued++;
    }
  }
  return queued;
}

async function claim(env) {
  const t = now();
  const run = await env.DB.prepare(
    "UPDATE runs SET status = 'running', started_at = ?, heartbeat_at = ? WHERE id = (SELECT id FROM runs WHERE status = 'queued' ORDER BY queued_at, id LIMIT 1) AND status = 'queued' RETURNING *",
  ).bind(t, t).first();
  if (!run) return json({ run: null });
  const { config } = await versionMeta(env, run.version);
  const files = Object.fromEntries(await versionFiles(env, run.version));
  const head = { id: run.id, project: run.project, kind: run.kind, agent: run.agent, trigger: run.trigger, version: run.version };
  if (run.kind === "check") return json({ run: head, files, commands: config.checks, timeout: 600, env: {}, state: {}, state_paths: [], image: config.image ?? null });

  const agent = config.agents.find((a) => a.name === run.agent);
  if (!agent) {
    await env.DB.prepare("UPDATE runs SET status = 'failed', ended_at = ?, problems = ? WHERE id = ?").bind(t, JSON.stringify([`agent ${run.agent} is not in version ${run.version}`]), run.id).run();
    return json({ run: null });
  }
  const secretEnv = {};
  const missing = [];
  for (const name of agent.secrets) {
    const s = await env.DB.prepare("SELECT value FROM secrets WHERE project = ? AND name = ?").bind(run.project, name).first();
    if (s) secretEnv[name] = await decrypt(env, s.value);
    else missing.push(name);
  }
  const state = Object.fromEntries((await env.DB.prepare("SELECT path, blob FROM state WHERE project = ?").bind(run.project).all()).results
    .filter((s) => config.state.includes(s.path)).map((s) => [s.path, s.blob]));
  // A token only this run carries: the gateway records the model calls made with it while the run is running.
  let gateway = null;
  if (agent.trace) {
    gateway = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
    await env.DB.prepare("UPDATE runs SET trace_token = ? WHERE id = ?").bind(await sha256(gateway), run.id).run();
  }
  // The judge's settings and API key, for agents it covers. The key goes to the runner, never to the agent.
  let judge = null;
  if (config.judge && (!config.judge.agents || config.judge.agents.includes(agent.name))) {
    const { key, agents: _a, gate: _g, ...rest } = config.judge;
    const s = key && (await env.DB.prepare("SELECT value FROM secrets WHERE project = ? AND name = ?").bind(run.project, key).first());
    judge = { ...rest, key: s ? await decrypt(env, s.value) : null, missing_key: key && !s ? key : null };
  }
  return json({ run: head, files, commands: [agent.run], timeout: agent.timeout, env: secretEnv, missing_secrets: missing, judge,
    input: run.input == null ? null : JSON.parse(run.input), input_files: JSON.parse(run.input_files ?? "{}"), state, state_paths: config.state,
    examples: await examplesFor(env, run.project, run.agent, agent.examples, run.input), gateway, image: config.image ?? null });
}

async function heartbeat(env, request, id) {
  const { log_tail = "" } = await body(request);
  const r = await env.DB.prepare("UPDATE runs SET heartbeat_at = ?, log_tail = ? WHERE id = ? AND status = 'running'").bind(now(), log_tail.slice(-4000), id).run();
  return json({ cancel: r.meta.changes === 0 });
}

async function done(env, request, id) {
  const { status, exit_code = null, log = "", state = {}, output = null, files = {}, judge = null } = await body(request);
  if (!["ok", "failed", "timeout"].includes(status)) throw new HttpError(400, "status is ok, failed or timeout");
  const run = await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first();
  if (!run) throw new HttpError(404, `no run ${id}`);
  if (run.status !== "running") return json({ status: run.status, already: true });
  await env.FILES.put(`logs/${id}.txt`, log);
  const problems = problemLines(log);
  if (status === "timeout") problems.unshift("the run hit its timeout and was stopped");
  const out = output == null ? null : JSON.stringify(output);
  if (out && out.length > MAX_OUTPUT) problems.unshift(`the output was ${out.length} bytes; the limit is ${MAX_OUTPUT}, so it was dropped`);
  const kept = Object.entries(files).filter(([name, sha]) => FILE_NAME.test(name) && SHA.test(sha)).slice(0, MAX_RUN_FILES);
  const t = now();
  // An ok run of an agent with "review" waits for a person before anything acts on it, unless review.when
  // is "flagged" and nothing flagged it. A replay only measures a version: nobody reviews it, it keeps no state.
  // An agent can say there is nothing to review this time with {"review": false} in its output.
  const agent = run.kind === "agent" ? (await versionMeta(env, run.version)).config.agents.find((a) => a.name === run.agent) : null;
  const kept_output = out && out.length <= MAX_OUTPUT ? out : null;
  const verdict = judge && typeof judge === "object" ? judge : null;
  const { review, flags } = reviewState(agent, run, status, kept_output == null ? null : output, problems, verdict);
  const runFiles = kept.length ? JSON.stringify(Object.fromEntries(kept)) : null;
  const ended = await env.DB.prepare("UPDATE runs SET status = ?, exit_code = ?, ended_at = ?, problems = ?, log_tail = ?, output = ?, files = ?, review = ?, flags = ?, reviewed_at = ?, judge = ? WHERE id = ? AND status = 'running'")
    .bind(status, exit_code, t, JSON.stringify(problems), log.slice(-4000), kept_output, runFiles, review, flags.length ? JSON.stringify(flags) : null,
      review === "auto" ? t : null, verdict ? JSON.stringify(verdict).slice(0, 64 * 1024) : null, id).run();
  if (!ended.meta.changes) return json({ already: true });
  if (review === "auto") await runThen(env, { ...run, files: runFiles }, { note: "", output });

  if (run.kind === "check") {
    if (status === "ok") await markReady(env, run.version);
    else await env.DB.prepare("UPDATE versions SET status = 'failed', problems = ? WHERE id = ?")
      .bind(JSON.stringify(problems.length ? problems : [`a check exited with code ${exit_code}`]), run.version).run();
    return json({ status });
  }
  if (run.gate) await settleGates(env, run.gate);
  if (run.trigger === "replay") return json({ status });
  // Keep state even from a failed run, so work already done is not repeated.
  const { config } = await versionMeta(env, run.version);
  for (const [path, sha] of Object.entries(state)) {
    if (!config.state.includes(path) || !SHA.test(sha)) continue;
    await env.DB.prepare("INSERT INTO state (project, path, blob, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (project, path) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at")
      .bind(run.project, path, sha, t).run();
  }
  return json({ status });
}

async function blob(env, sha) {
  const obj = await env.FILES.get(`blobs/${sha}`);
  if (!obj) throw new HttpError(404, "no such file");
  return new Response(obj.body);
}

async function putBlob(env, request, sha) {
  const data = await request.arrayBuffer();
  if ((await sha256(data)) !== sha) throw new HttpError(400, "content does not match its sha256");
  await env.FILES.put(`blobs/${sha}`, data);
  return json({ ok: true });
}

export async function runnerApi(request, env, path) {
  runnerAuth(env, request);
  let x;
  if (request.method === "POST" && path === "/api/runner/claim") return claim(env);
  if (request.method === "POST" && path === "/api/runner/schedule") return json({ queued: await schedule(env) });
  if ((x = path.match(/^\/api\/runner\/blobs\/([0-9a-f]{64})$/))) return request.method === "PUT" ? putBlob(env, request, x[1]) : blob(env, x[1]);
  if (request.method === "POST" && (x = path.match(/^\/api\/runner\/runs\/(\w+)\/heartbeat$/))) return heartbeat(env, request, x[1]);
  if (request.method === "POST" && (x = path.match(/^\/api\/runner\/runs\/(\w+)\/finish$/))) return done(env, request, x[1]);
  throw new HttpError(404, `no runner route ${request.method} ${path}`);
}

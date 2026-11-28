#!/usr/bin/env node
// tidegate: deploy a folder of agents, call them, manage secrets and rollbacks, watch runs, run queued
// work (runner), or serve the deploy tool over MCP. The API is TIDEGATE_API (default http://localhost:8787).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { distance } from "../worker/src/config.js";
import { judgeRun, runState } from "./judge.mjs";

const DEFAULT_API = "http://localhost:8787";
let API = (process.env.TIDEGATE_API ?? DEFAULT_API).replace(/\/$/, "");
const HOME = process.env.TIDEGATE_HOME || path.join(homedir(), ".tidegate");
const CREDS = path.join(HOME, "credentials.json");
const SKIP = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", ".DS_Store", ".tidegate", ".pytest_cache", ".wrangler"]);

class CliError extends Error {
  /** `slug` is stable for scripts and agents; `message` is prose that may change; `code` is the exit status. */
  constructor(slug, message, code = 1) {
    super(message);
    this.slug = slug;
    this.code = code;
  }
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function call(method, route, { token, body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined && !(body instanceof Uint8Array) && typeof body !== "string") h["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(API + route, { method, headers: h, body: body === undefined ? undefined : body instanceof Uint8Array || typeof body === "string" ? body : JSON.stringify(body) });
  } catch (e) {
    throw new CliError("TG_UNREACHABLE", `cannot reach Tidegate at ${API} (${e.cause?.code ?? e.message}).\nStart it in another terminal with: tidegate dev   (or set TIDEGATE_API to your server)`);
  }
  if (raw) {
    if (!res.ok) throw new CliError("TG_HTTP", `${method} ${route}: HTTP ${res.status}`);
    return res;
  }
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new CliError("TG_HTTP", data.error ?? `HTTP ${res.status}`);
  return data;
}

async function creds() {
  try {
    return JSON.parse(await readFile(CREDS, "utf8"));
  } catch {
    return {};
  }
}

async function saveToken(project, token) {
  const c = await creds();
  (c[API] ??= {})[project] = token;
  await mkdir(HOME, { recursive: true, mode: 0o700 });
  await writeFile(CREDS, JSON.stringify(c, null, 1), { mode: 0o600 });
}

async function tokenFor(project) {
  const t = process.env.TIDEGATE_TOKEN ?? (await creds())[API]?.[project];
  if (!t) throw new CliError("TG_NO_TOKEN", `no token for ${project} on ${API}; deploy it from this machine first, or set TIDEGATE_TOKEN`);
  return t;
}

async function projectName(dir, flag) {
  if (flag) return flag;
  try {
    return JSON.parse(await readFile(path.join(dir, ".tidegate", "project.json"), "utf8")).name;
  } catch {
    return path.basename(path.resolve(dir)).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  }
}

async function ignoreList(dir) {
  try {
    return (await readFile(path.join(dir, ".tidegateignore"), "utf8")).split("\n").map((l) => l.trim().replace(/^\/|\/$/g, "")).filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

async function walk(dir) {
  const ignore = await ignoreList(dir);
  const out = new Map();
  async function go(rel) {
    for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP.has(e.name) || e.name.endsWith(".pyc") || ignore.some((i) => p === i || p.startsWith(`${i}/`))) continue;
      if (e.isDirectory()) await go(p);
      else if (e.isFile()) out.set(p, path.join(dir, p));
    }
  }
  await go("");
  return out;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

export async function deploy(dir, { name, promote = true, wait = true, replay = null, log = console.log } = {}) {
  dir = path.resolve(dir);
  if (!(await stat(path.join(dir, "tidegate.json")).catch(() => null)))
    throw new CliError("TG_NO_CONFIG", `no tidegate.json in ${dir}\nRun deploy in an agent's folder (try examples/support-reply), or create one: {"agents": [{"name": "triage", "run": "python agent.py"}]}`, 2);
  const project = await projectName(dir, name);
  const paths = await walk(dir);
  const files = {}, bySha = {};
  for (const [rel, abs] of paths) {
    const sha = sha256(await readFile(abs));
    files[rel] = sha;
    bySha[sha] = abs;
  }
  let token = (await creds())[API]?.[project] ?? process.env.TIDEGATE_TOKEN;
  const start = await call("POST", "/api/deploys", { token, body: { project, files, promote, replay } });
  if (start.token) {
    token = start.token;
    await saveToken(project, token);
    log(`Created ${project}. Its deploy token is saved in ${CREDS}.`);
  }
  await mkdir(path.join(dir, ".tidegate"), { recursive: true });
  await writeFile(path.join(dir, ".tidegate", "project.json"), JSON.stringify({ name: project, api: API }, null, 1) + "\n");
  log(`${paths.size} files, ${start.missing.length} new to upload.`);
  await pool(start.missing, 8, async (sha) => {
    await call("PUT", `/api/blobs/${sha}`, { token, body: new Uint8Array(await readFile(bySha[sha])), headers: { "x-tidegate-project": project } });
  });
  let r = await call("POST", `/api/versions/${start.version}/finalize`, { token });
  if (r.status === "checking") {
    log(`Checks running on a runner:\n${r.checks.map((c) => `  ${c}`).join("\n")}`);
    if (!wait) return { project, ...r };
    const until = Date.now() + 15 * 60_000;
    while (Date.now() < until) {
      await new Promise((res) => setTimeout(res, 3000));
      const p = await call("GET", `/api/projects/${project}`, { token });
      const v = p.versions.find((x) => x.id === start.version);
      if (v.status !== "checking") {
        r = { ...r, status: v.status, problems: v.problems };
        break;
      }
    }
  }
  if (r.status === "ready" && promote) {
    // With "gate" in tidegate.json, the version goes live only once its replays are no worse than the live version's.
    for (const until = Date.now() + 30 * 60_000; ;) {
      const v = (await call("GET", `/api/projects/${project}`, { token })).versions.find((x) => x.id === start.version);
      r = { ...r, gate: v.gate, live: v.production };
      if (v.gate?.status !== "replaying") break;
      if (!wait || Date.now() > until) {
        log(`Gate: replaying ${v.gate.runs / 2} past inputs on this version and on ${v.gate.against}; it goes live if it is no worse. See tidegate status.`);
        return { project, ...r, status: "gating" };
      }
      await new Promise((res) => setTimeout(res, 3000));
    }
    if (r.gate) log(gateText(r.gate, start.version));
    if (r.gate?.status === "blocked") return { project, ...r, status: "blocked" };
  }
  if (r.status === "ready" && promote && !r.live) log(`Ready, but not live: ${r.preview_url}\nShip it: tidegate promote ${start.version}`);
  else if (r.status === "ready") log(promote ? `Live: ${r.url}  (or ${r.path_url})\nThis version: ${r.preview_url}` : `Ready (not promoted): ${r.preview_url}`);
  else if (r.status === "checking") log("Still checking after 15 minutes; is a runner running? See `tidegate status`.");
  else log(`Not published. Problems:\n${r.problems.map((p) => `  ${p}`).join("\n")}`);
  if (r.status === "ready" && replay) log(`Replaying ${replay.agent}'s last ${replay.last} inputs on ${start.version}. Compare: tidegate scorecard ${replay.agent}; ship it: tidegate promote ${start.version}`);
  return { project, ...r };
}

export function gateText(gate, version) {
  if (gate.status === "replaying") return `Gate: still replaying real inputs on ${version} and the live version (${gate.against}).`;
  const n = Math.max(0, ...(gate.agents ?? []).map((a) => a.candidate.runs ?? 0));
  const inputs = n ? `${n} real input${n === 1 ? "" : "s"}` : "the same real inputs";
  const lines = [gate.status === "passed" ? `Gate passed: no worse than the live version on ${inputs}.`
    : `Blocked: worse than the live version on ${inputs}. The live version stays.`];
  const pct = (x) => (x == null ? "-" : `${Math.round(x * 100)}%`);
  const val = (e) => (e?.pass_rate != null ? pct(e.pass_rate) : e?.mean ?? "-");
  for (const a of gate.agents ?? []) {
    const parts = Object.entries(a.candidate.evals).map(([k, e]) => `${k} ${val(e)} (live ${val(a.live.evals[k])})`);
    if (a.candidate.ok_rate !== a.live.ok_rate) parts.unshift(`ok ${pct(a.candidate.ok_rate)} (live ${pct(a.live.ok_rate)})`);
    lines.push(`  ${a.agent}: ${parts.join(", ") || `ok ${pct(a.candidate.ok_rate)}`}`);
    if (a.failed) lines.push(`    went right on ${a.failed.fixed} of ${a.failed.inputs} inputs that went wrong before (live ${a.failed.live_fixed})`);
    for (const w of a.worse) lines.push(`    worse: ${w}`);
  }
  if (gate.status !== "passed") lines.push(`  Ship it anyway: tidegate promote ${version}`);
  return lines.join("\n");
}

async function readSecret(name) {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString().replace(/\r?\n$/, "");
  }
  process.stdout.write(`Value for ${name} (hidden): `);
  process.stdin.setRawMode(true);
  let value = "";
  return new Promise((resolve) => {
    process.stdin.on("data", function onData(buf) {
      for (const ch of buf.toString()) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.off("data", onData);
          process.stdin.pause();
          process.stdout.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") process.exit(130);
        value = ch === "\u007f" ? value.slice(0, -1) : value + ch;
      }
    });
  });
}

const ago = (t, now) => (!t ? "" : now - t < 90 ? `${now - t}s ago` : now - t < 5400 ? `${Math.round((now - t) / 60)}m ago` : `${Math.round((now - t) / 3600)}h ago`);

async function showRuns(project, log = console.log) {
  const { runs, patterns, now } = await call("GET", `/api/projects/${project}/runs?limit=20`, { token: await tokenFor(project) });
  if (!runs.length) log("No runs yet.");
  for (const r of runs) {
    const time = r.started_at ? `${Math.round(((r.ended_at ?? now) - r.started_at) / 6) / 10}m` : "";
    log(`${r.id}  ${(r.agent ?? "checks").padEnd(12)} ${r.trigger.padEnd(8)} ${r.status.padEnd(8)} ${ago(r.queued_at, now).padEnd(8)} ${time.padEnd(6)} ${r.problems[0] ?? ""}`.trimEnd());
  }
  if (patterns.length) {
    log("\nRepeated problems (runs out of the last 20):");
    for (const p of patterns) log(`  ${p.runs}  ${p.line}`);
  }
}

export function printScorecard(rows, production, log = console.log) {
  if (!rows.length) return log("No finished runs yet.");
  const pct = (x) => (x == null ? "-" : `${Math.round(x * 100)}%`);
  log("version            agent        kind    runs  ok    approved  1st-time  auto  tokens  judge≈you  evals");
  for (const r of rows) {
    const evals = Object.entries(r.evals).map(([k, e]) => `${k} ${e.pass_rate != null ? pct(e.pass_rate) : ""}${e.mean != null ? ` ${e.mean}` : ""}`.trim()).join(", ");
    log(`${(r.version + (r.version === production ? "*" : "")).padEnd(19)}${r.agent.padEnd(13)}${r.kind.padEnd(8)}${String(r.runs).padEnd(6)}${pct(r.ok_rate).padEnd(6)}` +
      `${(r.reviewed ? `${pct(r.approval_rate)} of ${r.reviewed}` : "-").padEnd(10)}${pct(r.approved_first_time).padEnd(10)}${String(r.auto ?? 0).padEnd(6)}${String(r.median_tokens ?? "-").padEnd(8)}${(r.judge_agreement?.n ? `${pct(r.judge_agreement.rate)} of ${r.judge_agreement.n}` : "-").padEnd(11)}${evals}`);
  }
  log("* live version. approved = approved / reviewed (a correction is not an approval); 1st-time = approved without a revision;");
  log("  auto = approved without review because nothing flagged them; tokens = median model tokens per run;");
  log("  judge≈you = how often the judge's pass/fail matched your approve vs not, over runs you decided.");
}

// ---- runner ----

const BLOBS = path.join(HOME, "cache", "blobs");

async function fetchBlob(sha, token) {
  const p = path.join(BLOBS, sha);
  if (existsSync(p)) return p;
  const res = await call("GET", `/api/runner/blobs/${sha}`, { token, raw: true });
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256(buf) !== sha) throw new CliError("TG_BLOB_CORRUPT", `blob ${sha} came back corrupted`);
  await mkdir(BLOBS, { recursive: true });
  await writeFile(p, buf);
  return p;
}

async function materialize(work, files, token) {
  await pool(Object.entries(files), 16, async ([rel, sha]) => {
    const dest = path.join(work, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, await readFile(await fetchBlob(sha, token)));
  });
}

function sh(cmd, { cwd, env, timeoutSec, onOutput }) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", cmd], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, timeoutSec * 1000);
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut });
    });
  });
}

async function pythonEnv(work, log) {
  const req = path.join(work, "requirements.txt");
  if (!existsSync(req)) return null;
  const hash = sha256(await readFile(req)).slice(0, 16);
  const venv = path.join(HOME, "envs", hash);
  if (!existsSync(path.join(venv, ".ready"))) {
    log(`[tidegate] installing requirements.txt into ${venv}\n`);
    await rm(venv, { recursive: true, force: true });
    for (const cmd of [`python3 -m venv ${JSON.stringify(venv)}`, `${JSON.stringify(path.join(venv, "bin", "pip"))} install -q -r requirements.txt`]) {
      const r = await sh(cmd, { cwd: work, env: { PATH: process.env.PATH, HOME: work }, timeoutSec: 900, onOutput: (b) => log(b.toString()) });
      if (r.code !== 0) throw new CliError("TG_INSTALL_FAILED", "installing requirements.txt failed");
    }
    await writeFile(path.join(venv, ".ready"), "");
  }
  return path.join(venv, "bin");
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The address agents use to reach Tidegate. Inside a container, localhost is the container itself.
const agentApi = (isolate) => (isolate === "docker" ? API.replace(/\/\/(localhost|127\.0\.0\.1)(?=[:/]|$)/, "//host.docker.internal") : API);

// The image a project's runs use under --isolate docker: its own Dockerfile, or a base image (tidegate.json
// "image", else python or node) with requirements.txt / package.json installed into it. Built once per
// content hash, then reused by every run.
async function dockerImage(work, task, log) {
  const sh_ = (cmd, cwd) => sh(cmd, { cwd, env: process.env, timeoutSec: 1800, onOutput: (b) => log(b.toString()) });
  const exists = async (tag) => (await sh(`docker image inspect ${tag}`, { cwd: work, env: process.env, timeoutSec: 60, onOutput: () => {} })).code === 0;
  if (existsSync(path.join(work, "Dockerfile"))) {
    const tag = `tidegate-${task.run.project}:${sha256(JSON.stringify(Object.entries(task.files).sort())).slice(0, 16)}`;
    if (!(await exists(tag))) {
      log(`[tidegate] building the project's Dockerfile as ${tag}\n`);
      if ((await sh_(`docker build -q -t ${tag} .`, work)).code !== 0) throw new CliError("TG_DOCKER", "docker build failed");
    }
    return { tag, nodePath: null };
  }
  const req = existsSync(path.join(work, "requirements.txt")), pkg = existsSync(path.join(work, "package.json"));
  const base = task.image ?? (pkg && !req ? "node:22-slim" : "python:3.12-slim");
  if (!req && !pkg) return { tag: base, nodePath: null };
  const lines = [`FROM ${base}`];
  const ctx = await mkdtemp(path.join(HOME, "build-"));
  try {
    if (req) {
      await writeFile(path.join(ctx, "requirements.txt"), await readFile(path.join(work, "requirements.txt")));
      lines.push("COPY requirements.txt /deps/requirements.txt", "RUN pip install -q --no-cache-dir -r /deps/requirements.txt");
    }
    if (pkg) {
      for (const f of ["package.json", "package-lock.json"]) if (existsSync(path.join(work, f))) await writeFile(path.join(ctx, f), await readFile(path.join(work, f)));
      lines.push("COPY package*.json /deps/", "RUN cd /deps && npm install --no-audit --no-fund --silent");
    }
    const dockerfile = lines.join("\n") + "\n";
    await writeFile(path.join(ctx, "Dockerfile"), dockerfile);
    const tag = `tidegate-env:${sha256(dockerfile + (req ? await readFile(path.join(ctx, "requirements.txt"), "utf8") : "") + (pkg ? await readFile(path.join(ctx, "package.json"), "utf8") : "")).slice(0, 16)}`;
    if (!(await exists(tag))) {
      log(`[tidegate] building ${tag} from ${base} with the project's dependencies\n`);
      if ((await sh_(`docker build -q -t ${tag} .`, ctx)).code !== 0) throw new CliError("TG_DOCKER", "installing dependencies in the image failed");
    }
    return { tag, nodePath: pkg ? "/deps/node_modules" : null };
  } finally {
    await rm(ctx, { recursive: true, force: true });
  }
}

async function runTask(task, token, say, isolate = "none") {
  const { run } = task;
  // Docker on macOS (Colima, Docker Desktop) shares only the home folder with its VM, so containers get a folder under TIDEGATE_HOME.
  if (isolate === "docker") await mkdir(path.join(HOME, "work"), { recursive: true });
  const work = await mkdtemp(isolate === "docker" ? path.join(HOME, "work", `${run.project}-`) : path.join(tmpdir(), `tidegate-${run.project}-`));
  let log = "";
  const append = (s) => {
    log += s;
    if (log.length > 5_000_000) log = log.slice(-4_000_000);
  };
  const beat = setInterval(() => call("POST", `/api/runner/runs/${run.id}/heartbeat`, { token, body: { log_tail: log.slice(-4000) } }).catch(() => {}), 15_000);
  let status = "ok", exit_code = 0, output = null;
  const state = {};
  const inputFile = path.join(work, ".tidegate-input.json"), outputFile = path.join(work, ".tidegate-output.json");
  const filesOut = path.join(work, ".tidegate-files"), filesIn = path.join(work, ".tidegate-input-files");
  const examplesFile = path.join(work, ".tidegate-examples.json");
  const files = {};
  let envDir = null;
  try {
    await materialize(work, { ...task.files, ...task.state }, token);
    await mkdir(filesOut, { recursive: true });
    await mkdir(filesIn, { recursive: true });
    await materialize(filesIn, task.input_files ?? {}, token);
    await writeFile(inputFile, JSON.stringify(task.input ?? null));
    await writeFile(examplesFile, JSON.stringify(task.examples ?? { good: [], avoid: [] }));
    if (task.missing_secrets?.length) append(`[tidegate] secrets not set: ${task.missing_secrets.join(", ")} (tidegate secret set NAME)\n`);
    // Inside a container the folder is /work; outside, it is the folder itself.
    const at = (p) => (isolate === "docker" ? path.posix.join("/work", path.relative(work, p)) : p);
    let image = null, bin = null;
    if (isolate === "docker") image = await dockerImage(work, task, append);
    else {
      bin = await pythonEnv(work, append);
      if (existsSync(path.join(work, "package.json"))) {
        const r = await sh("npm install --no-audit --no-fund --silent", { cwd: work, env: { PATH: process.env.PATH, HOME: work }, timeoutSec: 600, onOutput: (b) => append(b.toString()) });
        if (r.code !== 0) throw new CliError("TG_INSTALL_FAILED", "npm install failed");
      }
    }
    const gw = task.gateway ? `${agentApi(isolate)}/gw/${task.gateway}` : null;
    // Jobs see only their own secrets and a clean environment; never the runner's token. A secret the
    // project sets (say its own ANTHROPIC_BASE_URL) wins over the gateway address.
    const env = { HOME: at(work), LANG: "C.UTF-8", PYTHONUNBUFFERED: "1",
      TIDEGATE_PROJECT: run.project, TIDEGATE_AGENT: run.agent ?? "", TIDEGATE_RUN_ID: run.id, TIDEGATE_VERSION: run.version, TIDEGATE_TRIGGER: run.trigger,
      TIDEGATE_INPUT: at(inputFile), TIDEGATE_OUTPUT: at(outputFile), TIDEGATE_FILES: at(filesOut), TIDEGATE_INPUT_FILES: at(filesIn), TIDEGATE_EXAMPLES: at(examplesFile),
      TIDEGATE_API: agentApi(isolate),
      ...(gw ? { TIDEGATE_GATEWAY: gw, ANTHROPIC_BASE_URL: `${gw}/anthropic`, OPENAI_BASE_URL: `${gw}/openai/v1` } : {}),
      ...(image?.nodePath ? { NODE_PATH: image.nodePath } : {}), ...task.env };
    if (isolate !== "docker") env.PATH = [bin, process.env.PATH].filter(Boolean).join(":");
    else {
      // Secrets go in a file outside the mounted folder, not on the command line where ps would show them.
      envDir = await mkdtemp(path.join(HOME, "env-"));
      await writeFile(path.join(envDir, "env"), Object.entries(env).map(([k, v]) => `${k}=${String(v).replace(/\n/g, " ")}`).join("\n") + "\n", { mode: 0o600 });
    }
    for (const cmd of task.commands) {
      append(`$ ${cmd}\n`);
      const name = `tidegate-${run.id}`;
      const line = isolate === "docker"
        ? ["docker run --rm", `--name ${name}`, "--add-host host.docker.internal:host-gateway", "--memory 1g --cpus 1 --pids-limit 512",
          "--security-opt no-new-privileges", process.platform === "linux" ? `--user ${process.getuid()}:${process.getgid()}` : "",
          `-v ${quote(`${work}:/work`)} -w /work`, `--env-file ${quote(path.join(envDir, "env"))}`, image.tag, "sh -c", quote(cmd)].filter(Boolean).join(" ")
        : cmd;
      const r = await sh(line, { cwd: work, env: isolate === "docker" ? process.env : env,
        timeoutSec: task.timeout, onOutput: (b) => append(b.toString()) });
      if (r.timedOut && isolate === "docker") await sh(`docker rm -f ${name}`, { cwd: work, env: process.env, timeoutSec: 60, onOutput: () => {} });
      exit_code = r.code;
      if (r.timedOut) status = "timeout";
      else if (r.code !== 0) status = "failed";
      if (status !== "ok") break;
    }
    for (const rel of task.state_paths) {
      const p = path.join(work, rel);
      if (!existsSync(p) || !(await stat(p)).isFile()) continue;
      const buf = await readFile(p);
      const sha = sha256(buf);
      state[rel] = sha;
      if (task.files[rel] !== sha && task.state[rel] !== sha) await call("PUT", `/api/runner/blobs/${sha}`, { token, body: new Uint8Array(buf) });
    }
    // Files the agent wrote to $TIDEGATE_FILES: kept with the run, shown in review, handed to the next run.
    for (const name of (await readdir(filesOut)).sort()) {
      const p = path.join(filesOut, name);
      if (!(await stat(p)).isFile()) continue;
      if (!/^[\w][\w.-]{0,99}$/.test(name) || Object.keys(files).length >= 20) { append(`[tidegate] error: file ${name} not kept (names are letters, digits, . - _; at most 20 files)\n`); continue; }
      const buf = await readFile(p);
      if (buf.length > 10 * 1024 * 1024) { append(`[tidegate] error: file ${name} is over 10 MB; not kept\n`); continue; }
      files[name] = sha256(buf);
      await call("PUT", `/api/runner/blobs/${files[name]}`, { token, body: new Uint8Array(buf) });
    }
    if (existsSync(outputFile)) {
      const text = await readFile(outputFile, "utf8");
      try {
        output = JSON.parse(text);
      } catch {
        append(`[tidegate] error: $TIDEGATE_OUTPUT is not valid JSON; output dropped\n`);
      }
    }
  } catch (e) {
    status = "failed";
    exit_code = null;
    append(`[tidegate] error: ${e.message}\n`);
  } finally {
    clearInterval(beat);
    if (envDir) await rm(envDir, { recursive: true, force: true });
  }
  // The judge reads the finished run from here, with a key the agent never saw.
  let judge = null;
  if (task.judge && status === "ok") {
    if (task.judge.missing_key) judge = { error: `secret ${task.judge.missing_key} is not set (tidegate secret set ${task.judge.missing_key})` };
    else {
      try {
        judge = await judgeRun(task.judge, task.judge.key, runState(task.input ?? null, output));
      } catch (e) {
        judge = { error: e.message.slice(0, 300) };
      }
    }
  }
  const res = await call("POST", `/api/runner/runs/${run.id}/finish`, { token, body: { status, exit_code, log, state, output, files, judge } });
  say(`${run.id} ${run.project} ${run.agent ?? "checks"} (${run.trigger}): ${res.status ?? status}`);
  await rm(work, { recursive: true, force: true });
}

async function runner({ once = false, isolate = process.env.TIDEGATE_ISOLATE ?? "none" } = {}) {
  const token = process.env.RUNNER_TOKEN;
  if (!token) throw new CliError("TG_NO_RUNNER_TOKEN", "set RUNNER_TOKEN to the Tidegate worker's runner token");
  if (!["none", "docker"].includes(isolate)) throw new CliError("TG_BAD_ISOLATE", "--isolate is none or docker");
  if (isolate === "docker" && (await sh("docker info", { cwd: homedir(), env: process.env, timeoutSec: 30, onOutput: () => {} })).code !== 0) {
    throw new CliError("TG_NO_DOCKER", "--isolate docker needs a running Docker (docker info failed)");
  }
  console.log(`Runner on ${API}${isolate === "docker" ? ", each run in a container" : ""}${once ? " (one pass)" : ""}`);
  for (;;) {
    let task;
    try {
      await call("POST", "/api/runner/schedule", { token });
      task = await call("POST", "/api/runner/claim", { token });
    } catch (e) {
      console.error(`claim failed: ${e.message}`);
    }
    if (task?.run) await runTask(task, token, console.log, isolate);
    else if (once) return;
    else await new Promise((r) => setTimeout(r, 5000));
  }
}

// ---- local mode ----

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// tidegate dev: the whole of Tidegate on this machine, no account. The Worker runs under wrangler with its
// database and files in SQLite under TIDEGATE_HOME/dev, and a runner runs alongside it. Secrets for the
// local Worker are generated once and kept in TIDEGATE_HOME/dev/.env (mode 600).
async function dev({ port = 8787, isolate = "none" } = {}) {
  const dir = path.join(HOME, "dev");
  const envFile = path.join(dir, ".env");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(envFile)) {
    const { randomBytes } = await import("node:crypto");
    await writeFile(envFile, `SECRETS_KEY=${randomBytes(32).toString("base64")}\nRUNNER_TOKEN=${randomBytes(24).toString("hex")}\n`, { mode: 0o600 });
  }
  const vars = Object.fromEntries((await readFile(envFile, "utf8")).split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  // wrangler is a dependency; when Tidegate is installed from npm it is hoisted next to it, not under ROOT.
  const { createRequire } = await import("node:module");
  const wrangler = `${quote(process.execPath)} ${quote(path.join(path.dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin", "wrangler.js"))}`;
  const state = path.join(dir, "state");
  const quiet = { cwd: ROOT, env: process.env, timeoutSec: 300, onOutput: () => {} };
  const schema = await sh(`${wrangler} d1 execute tidegate --local --persist-to ${quote(state)} --file worker/schema.sql`, quiet);
  if (schema.code !== 0) throw new CliError("TG_DB_FAILED", "could not create the local database (wrangler d1 execute failed)");
  const server = spawn("sh", ["-c", `${wrangler} dev --port ${port} --persist-to ${quote(state)} --env-file ${quote(envFile)} --var PORT:${port}`],
    { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let serverLog = "";
  server.stdout.on("data", (b) => (serverLog += b));
  server.stderr.on("data", (b) => (serverLog += b));
  const stop = () => {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {}
  };
  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.on("exit", stop);
  const api = `http://localhost:${port}`;
  for (const until = Date.now() + 90_000; ; await new Promise((r) => setTimeout(r, 500))) {
    if (server.exitCode != null) throw new CliError("TG_WORKER_STOPPED", `the local Worker stopped:\n${serverLog.slice(-2000)}`);
    if (Date.now() > until) throw new CliError("TG_WORKER_TIMEOUT", `the local Worker did not start in 90 seconds:\n${serverLog.slice(-2000)}`);
    if (await fetch(`${api}/api/validate`, { method: "POST", body: "{}" }).then((r) => r.ok).catch(() => false)) break;
  }
  console.log(`Tidegate is running on ${api}
  deploy:   cd your-agent && ${api === DEFAULT_API ? "tidegate deploy" : `TIDEGATE_API=${api} tidegate deploy`}
  runs:     tidegate dashboard, in the agent's folder
  data:     ${dir}
Ctrl-C stops it.`);
  process.env.RUNNER_TOKEN = vars.RUNNER_TOKEN;
  if (!process.env.TIDEGATE_API) API = api;
  else if (API !== api) console.log(`Note: TIDEGATE_API is ${API}; the runner uses that address.`);
  return runner({ isolate });
}

// ---- MCP (stdio, JSON-RPC 2.0) ----

const TOOLS = [
  { name: "deploy", description: "Deploy a folder of AI agents (with a tidegate.json) to Tidegate. Returns the agents' URL, or the problems that stopped the deploy.",
    inputSchema: { type: "object", properties: { folder: { type: "string", description: "Absolute path of the project folder" }, name: { type: "string", description: "Project name; defaults to the folder's saved name or its folder name" } }, required: ["folder"] } },
  { name: "invoke", description: "Run one of a Tidegate project's agents with a JSON input and wait up to 30 seconds for its output.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Project name" }, agent: { type: "string" }, input: { description: "Any JSON value" } }, required: ["name", "agent"] } },
  { name: "status", description: "Show a Tidegate project's live version, agents, secrets and recent versions.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "runs", description: "Show a Tidegate project's recent agent and check runs, and problems repeated across runs.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
];

export async function invokeAgent(project, agent, input, wait = 30) {
  return call("POST", `/p/${project}/${agent}?wait=${wait}`, { token: await tokenFor(project), body: input === undefined ? "" : JSON.stringify(input), headers: { "content-type": "application/json" } });
}

async function mcp() {
  const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === undefined) continue;
    const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
    if (msg.method === "initialize") reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "tidegate", version: "0.1.0" } });
    else if (msg.method === "tools/list") reply({ tools: TOOLS });
    else if (msg.method === "ping") reply({});
    else if (msg.method === "tools/call") {
      const lines = [];
      const log = (s) => lines.push(s);
      const a = msg.params?.arguments ?? {};
      try {
        if (msg.params.name === "deploy") await deploy(a.folder, { name: a.name, log });
        else if (msg.params.name === "invoke") lines.push(JSON.stringify(await invokeAgent(a.name, a.agent, a.input), null, 1));
        else if (msg.params.name === "status") lines.push(JSON.stringify(await call("GET", `/api/projects/${a.name}`, { token: await tokenFor(a.name) }), null, 1));
        else if (msg.params.name === "runs") await showRuns(a.name, log);
        else throw new CliError("TG_UNKNOWN_TOOL", `unknown tool ${msg.params.name}`);
        reply({ content: [{ type: "text", text: lines.join("\n") }] });
      } catch (e) {
        reply({ content: [{ type: "text", text: [...lines, e.message].join("\n") }], isError: true });
      }
    } else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } });
  }
}

// ---- commands ----

const USAGE = `tidegate <command>

  deploy [folder] [--name NAME] [--no-promote] [--replay AGENT[:N]]
                                                 upload a folder; it goes live when its checks pass. --replay reruns
                                                 AGENT's last N (10) inputs on it once ready; use with --no-promote
  invoke AGENT [JSON] [--wait SECONDS]           run an agent with this input and print its output
  status [--name NAME]                           live version, agents, versions, secrets
  rollback [VERSION]                             point production at an earlier version
  secret set NAME | secret rm NAME               a secret for agents (value is read hidden, or from stdin)
  runs                                           recent runs and repeated problems
  reviews                                        runs waiting for your review, with their output and files
  approve RUN [--note TEXT]                      approve a run; its "then" agent runs with the output and files
  correct RUN (--output JSON | --file PATH)      replace the run's output with yours: kept as an example, then "then" runs with it
  revise RUN --note TEXT                         rerun the agent with your note and its previous output
  reject RUN [--note TEXT]                       reject a run; nothing else runs
  files RUN [NAME] [--out DIR]                   list a run's files, or download one
  scorecard [AGENT]                              per version: ok rate, review outcomes, evals; live and replayed
  replay AGENT VERSION [--last N]                rerun AGENT's last N real inputs on VERSION (deploy it with --no-promote)
  promote VERSION                                make VERSION the live one
  logs RUN_ID                                    a run's full log
  dashboard                                      print the live view URL, signed in
  trace RUN [CALL]                               the model calls a run made (model, tokens, time), or one call's bodies
  dev [--port 8787] [--isolate docker]           run all of Tidegate on this machine (Worker, database, runner); no account
  runner [--once] [--isolate docker]             run queued checks and agent runs (needs RUNNER_TOKEN); docker runs each in a container

Git: git remote add tidegate tidegate::PROJECT, then git push tidegate main deploys the pushed commit
     (needs git-remote-tidegate on PATH: npm link, or symlink cli/git-remote-tidegate.mjs).
  mcp                                            serve deploy/invoke/status/runs as MCP tools on stdio

Environment: TIDEGATE_API (default http://localhost:8787), TIDEGATE_TOKEN, RUNNER_TOKEN.`;

const COMMANDS = ["deploy", "status", "trace", "rollback", "secret", "invoke", "runs", "reviews", "approve", "correct", "revise", "reject",
  "scorecard", "replay", "promote", "files", "logs", "dashboard", "dev", "runner", "mcp"];
const FLAGS = ["--name", "--no-promote", "--replay", "--wait", "--file", "--isolate", "--last", "--note", "--out", "--output", "--port", "--once"];

async function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (n) => {
    const i = rest.indexOf(n);
    return i >= 0 ? rest.splice(i, 2)[1] : undefined;
  };
  const has = (n) => {
    const i = rest.indexOf(n);
    return i >= 0 && rest.splice(i, 1).length > 0;
  };
  if (cmd === undefined || ["help", "--help", "-h"].includes(cmd)) return console.log(USAGE);
  if (!COMMANDS.includes(cmd)) {
    const near = COMMANDS.find((c) => distance(c, cmd) <= 2);
    throw new CliError("TG_USAGE", `unknown command "${cmd}"${near ? `; did you mean "tidegate ${near}"?` : ""}\nRun tidegate --help for the list.`, 2);
  }
  const bad = rest.find((a) => a.startsWith("--") && !FLAGS.includes(a));
  if (bad) throw new CliError("TG_USAGE", `unknown option ${bad} for tidegate ${cmd}\nRun tidegate --help for the options.`, 2);
  const name = flag("--name");
  const here = async () => projectName(".", name);
  switch (cmd) {
    case "deploy": {
      const promote = !has("--no-promote");
      const rp = flag("--replay");
      const replay = rp ? { agent: rp.split(":")[0], last: Number(rp.split(":")[1]) || 10 } : null;
      const r = await deploy(rest[0] ?? ".", { name, promote, replay });
      if (["failed", "blocked"].includes(r.status)) process.exitCode = 1;
      return;
    }
    case "status": {
      const p = await here();
      const s = await call("GET", `/api/projects/${p}`, { token: await tokenFor(p) });
      console.log(`${s.name}  ${s.url}\nlive: ${s.production ?? "none"}   secrets: ${s.secrets.join(", ") || "none"}`);
      for (const a of s.agents) console.log(`agent ${a.name}: ${a.run}${a.every ? `, every ${a.every / 60}m` : ""}${a.http ? `, POST ${s.url}/${a.name}${a.public ? " (public)" : ""}` : ""}`);
      if (s.agents.some((a) => a.on?.github)) console.log(`github_webhook_url: ${s.github_webhook_url}`);
      for (const v of s.versions.slice(0, 10)) console.log(`${v.production ? "*" : " "} ${v.id} ${v.status.padEnd(8)}${v.gate ? ` gate ${v.gate.status}` : ""}${v.problems.length ? ` ${v.problems[0]}` : ""}`);
      const gated = s.versions.find((v) => v.gate);
      if (gated) console.log(`\n${gateText(gated.gate, gated.id)}`);
      return;
    }
    case "trace": {
      const p = await here();
      const t = await tokenFor(p);
      if (!rest[0]) throw new CliError("usage: tidegate trace RUN [CALL]");
      if (rest[1]) {
        console.log(JSON.stringify(await call("GET", `/api/calls/${rest[1]}`, { token: t }), null, 1));
        return;
      }
      const { calls, totals } = await call("GET", `/api/runs/${rest[0]}/calls`, { token: t });
      if (!calls.length) console.log("This run made no model calls through Tidegate.");
      for (const c of calls) console.log(`${c.id}  ${c.provider.padEnd(10)}${String(c.model ?? "?").padEnd(28)}${String(c.status).padEnd(5)}${`${c.input_tokens ?? "?"} in / ${c.output_tokens ?? "?"} out`.padEnd(20)}${c.ms} ms`);
      if (calls.length) console.log(`${totals.calls} calls, ${totals.input_tokens} tokens in, ${totals.output_tokens} out, ${Math.round(totals.ms / 100) / 10} s in models`);
      return;
    }
    case "rollback": {
      const p = await here();
      const r = await call("POST", `/api/projects/${p}/rollback`, { token: await tokenFor(p), body: rest[0] ? { version: rest[0] } : {} });
      console.log(`Production is now ${r.production}: ${r.url}`);
      return;
    }
    case "secret": {
      const [op, key] = rest;
      const p = await here();
      if (op === "set" && key) await call("PUT", `/api/projects/${p}/secrets/${key}`, { token: await tokenFor(p), body: await readSecret(key) });
      else if (op === "rm" && key) await call("DELETE", `/api/projects/${p}/secrets/${key}`, { token: await tokenFor(p) });
      else throw new CliError("usage: tidegate secret set NAME | tidegate secret rm NAME");
      console.log(op === "set" ? `Set ${key} for ${p}.` : `Removed ${key}.`);
      return;
    }
    case "invoke": {
      const wait = Number(flag("--wait") ?? 30);
      const p = await here();
      if (!rest[0]) throw new CliError("usage: tidegate invoke AGENT [JSON]");
      let input;
      if (rest[1] !== undefined) {
        try {
          input = JSON.parse(rest[1]);
        } catch (e) {
          if (/^\s*[[{"]/.test(rest[1])) throw new CliError(`the input is not valid JSON (${e.message}): ${rest[1]}\nQuote it for your shell, e.g. tidegate invoke ${rest[0]} '{"email": "hi"}'`, 2);
          input = rest[1];
        }
      }
      const r = await invokeAgent(p, rest[0], input, wait);
      if (["queued", "running"].includes(r.status)) console.log(`Run ${r.run} is ${r.status}. Check it with: curl ${r.status_url}`);
      else console.log(JSON.stringify(r.status === "ok" ? r.output : { status: r.status, problems: r.problems, run: r.run }, null, 1));
      if (r.status === "failed" || r.status === "timeout") process.exitCode = 1;
      return;
    }
    case "runs":
      return showRuns(await here());
    case "reviews": {
      const p = await here();
      const { reviews } = await call("GET", `/api/projects/${p}/reviews`, { token: await tokenFor(p) });
      if (!reviews.length) console.log("Nothing is waiting for review.");
      for (const r of reviews) {
        const o = r.output ?? {};
        console.log(`${r.id}  ${r.agent}  ${o.title ?? ""}`.trimEnd());
        if (r.flags.length) console.log(`  flagged: ${r.flags.join("; ")}`);
        if (r.judge?.results) console.log(`  judge (${r.judge.model}): ${Object.entries(r.judge.results).map(([k, x]) => `${k} ${x.pass === false ? "FAIL" : x.pass ? "pass" : ""} ${x.good ?? ""}`.trim()).join(", ")}`);
        if (o.summary) console.log(String(o.summary).replace(/^/gm, "  "));
        if (r.files.length) console.log(`  files: ${r.files.join(", ")}  (tidegate files ${r.id} NAME)`);
        console.log(`  tidegate approve ${r.id} | tidegate correct ${r.id} --output '{...}' | tidegate revise ${r.id} --note "..." | tidegate reject ${r.id}\n`);
      }
      return;
    }
    case "approve":
    case "correct":
    case "revise":
    case "reject": {
      const note = flag("--note") ?? "";
      const outFlag = flag("--output"), outFile = flag("--file");
      const p = await here();
      if (!rest[0]) throw new CliError(`usage: tidegate ${cmd} RUN [--note TEXT]`);
      let output;
      if (cmd === "correct") {
        const text = outFile ? await readFile(outFile, "utf8") : outFlag;
        if (text == null) throw new CliError("usage: tidegate correct RUN --output JSON | --file PATH");
        try {
          output = JSON.parse(text);
        } catch (e) {
          throw new CliError(`the corrected output is not JSON: ${e.message}`);
        }
      }
      const r = await call("POST", `/api/runs/${rest[0]}/review`, { token: await tokenFor(p), body: { decision: cmd, note, output } });
      console.log(`${r.run} ${r.review}.${r.next_run ? ` Queued run ${r.next_run}.` : ""}`);
      return;
    }
    case "scorecard": {
      const p = await here();
      const { production, scorecard } = await call("GET", `/api/projects/${p}/scorecard${rest[0] ? `?agent=${rest[0]}` : ""}`, { token: await tokenFor(p) });
      printScorecard(scorecard, production);
      return;
    }
    case "replay": {
      const last = flag("--last");
      const p = await here();
      if (!rest[1]) throw new CliError("usage: tidegate replay AGENT VERSION [--last N]");
      const r = await call("POST", `/api/projects/${p}/agents/${rest[0]}/replay`, { token: await tokenFor(p), body: { version: rest[1], last: last ? Number(last) : undefined } });
      console.log(`Replaying ${r.queued.length} inputs of ${rest[0]} on ${r.version}. Compare with: tidegate scorecard ${rest[0]}`);
      return;
    }
    case "promote": {
      const p = await here();
      if (!rest[0]) throw new CliError("usage: tidegate promote VERSION");
      const r = await call("POST", `/api/projects/${p}/rollback`, { token: await tokenFor(p), body: { version: rest[0] } });
      console.log(`Production is now ${r.production}: ${r.url}`);
      return;
    }
    case "files": {
      const out = flag("--out") ?? ".";
      const p = await here();
      const t = await tokenFor(p);
      if (!rest[0]) throw new CliError("usage: tidegate files RUN [NAME] [--out DIR]");
      if (!rest[1]) {
        const r = await call("GET", `/api/runs/${rest[0]}`, { token: t });
        console.log([...r.files, ...r.input_files.map((f) => `${f} (handed in)`)].join("\n") || "This run has no files.");
        return;
      }
      const res = await call("GET", `/api/runs/${rest[0]}/files/${encodeURIComponent(rest[1])}`, { token: t, raw: true });
      const dest = path.join(out, path.basename(rest[1]));
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      console.log(`Saved ${dest}`);
      return;
    }
    case "logs": {
      const p = await here();
      const res = await call("GET", `/api/runs/${rest[0]}/log`, { token: await tokenFor(p), raw: true });
      process.stdout.write(await res.text());
      return;
    }
    case "dashboard": {
      const p = await here();
      console.log(`${API}/dashboard#project=${p}&token=${await tokenFor(p)}`);
      return;
    }
    case "dev":
      return dev({ port: Number(flag("--port") ?? 8787), isolate: flag("--isolate") ?? "none" });
    case "runner":
      return runner({ once: has("--once"), isolate: flag("--isolate") ?? process.env.TIDEGATE_ISOLATE ?? "none" });
    case "mcp":
      return mcp();
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/tidegate")) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof CliError ? `tidegate: ${e.slug}: ${e.message}` : e.stack);
    process.exit(e instanceof CliError ? e.code : 1);
  });
}

// The owner API: deploys, rollback, secrets, runs. Each project has one token, returned once
// when the project is created by its first deploy.
import { parseConfig } from "./config.js";
import { loadScorecard, replay } from "./loop.js";
import { decide } from "./review.js";
import { FILE_NAME, queueRun } from "./runner.js";
import { createVersion, finalize, missingBlobs } from "./versions.js";
import { HttpError, PROJECT, SHA, bearer, body, encrypt, json, now, pattern, sha256 } from "./util.js";

const MAX_FILES = 20_000;
const MAX_BLOB = 25 * 1024 * 1024;

export function urls(env, project, version) {
  const base = (host) => `${env.SCHEME ?? "https"}://${host}.${env.DOMAIN}${env.PORT ? `:${env.PORT}` : ""}`;
  const origin = `${env.SCHEME ?? "https"}://${env.DOMAIN}${env.PORT ? `:${env.PORT}` : ""}`;
  return { url: base(project), path_url: `${origin}/p/${project}`, preview_url: version ? base(`${project}--${version}`) : undefined,
    github_webhook_url: `${origin}/hooks/${project}/github` };
}

async function owner(env, request, name) {
  const p = await env.DB.prepare("SELECT * FROM projects WHERE name = ?").bind(name).first();
  if (!p) throw new HttpError(404, `no project ${name}`);
  if ((await sha256(bearer(request))) !== p.token_hash) throw new HttpError(401, `wrong or missing token for ${name}`);
  return p;
}

function checkFiles(files) {
  if (!files || typeof files !== "object") throw new HttpError(400, '"files" must map each path to its sha256');
  const entries = Object.entries(files);
  if (!entries.length || entries.length > MAX_FILES) throw new HttpError(400, `a deploy has 1 to ${MAX_FILES} files`);
  for (const [path, sha] of entries) {
    if (!SHA.test(sha)) throw new HttpError(400, `${path}: not a sha256`);
    if (path.startsWith("/") || path.split("/").includes("..")) throw new HttpError(400, `${path}: paths must be relative`);
  }
}

async function startDeploy(env, request) {
  const { project, files, promote = true, replay: replayAfter = null } = await body(request);
  if (!PROJECT.test(project ?? "")) throw new HttpError(400, "project names are lowercase letters, digits and dashes, up to 32");
  checkFiles(files);
  let token;
  const existing = await env.DB.prepare("SELECT name FROM projects WHERE name = ?").bind(project).first();
  if (existing) await owner(env, request, project);
  else {
    token = "hb_" + [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const r = await env.DB.prepare("INSERT OR IGNORE INTO projects (name, token_hash, created_at) VALUES (?, ?, ?)")
      .bind(project, await sha256(token), now()).run();
    if (!r.meta.changes) throw new HttpError(409, `${project} was just taken; try again`);
  }
  const onReady = replayAfter?.agent ? { replay: { agent: String(replayAfter.agent), last: Number(replayAfter.last) || 10 } } : null;
  const version = await createVersion(env, project, files, promote, onReady);
  return json({ version, missing: await missingBlobs(env, files), token, ...urls(env, project, version) }, 201);
}

async function putBlob(env, request, sha) {
  const name = request.headers.get("x-tidegate-project") ?? "";
  await owner(env, request, name);
  const data = await request.arrayBuffer();
  if (data.byteLength > MAX_BLOB) throw new HttpError(413, "files are limited to 25 MB");
  if ((await sha256(data)) !== sha) throw new HttpError(400, "content does not match its sha256");
  await env.FILES.put(`blobs/${sha}`, data);
  return json({ ok: true });
}

async function finish(env, request, id) {
  const v = await env.DB.prepare("SELECT project FROM versions WHERE id = ?").bind(id).first();
  if (!v) throw new HttpError(404, `no version ${id}`);
  await owner(env, request, v.project);
  const r = await finalize(env, id);
  return json({ version: id, status: r.status, problems: r.problems, checks: r.checks, ...urls(env, v.project, id) });
}

async function project(env, request, name) {
  const p = await owner(env, request, name);
  const versions = (await env.DB.prepare("SELECT id, status, problems, gate, created_at FROM versions WHERE project = ? ORDER BY created_at DESC, id DESC LIMIT 20")
    .bind(name).all()).results.map((v) => ({ ...v, problems: JSON.parse(v.problems ?? "[]"), gate: JSON.parse(v.gate ?? "null"), production: v.id === p.production }));
  const prod = p.production && (await env.DB.prepare("SELECT config FROM versions WHERE id = ?").bind(p.production).first());
  const config = prod ? JSON.parse(prod.config) : null;
  const secrets = (await env.DB.prepare("SELECT name FROM secrets WHERE project = ?").bind(name).all()).results.map((s) => s.name);
  return json({ name, production: p.production, ...urls(env, name), agents: config?.agents ?? [], secrets, versions });
}

async function rollback(env, request, name) {
  const p = await owner(env, request, name);
  const { version } = await body(request).catch(() => ({}));
  let target = version;
  if (!target) {
    const cur = p.production && (await env.DB.prepare("SELECT created_at FROM versions WHERE id = ?").bind(p.production).first());
    const prev = await env.DB.prepare("SELECT id FROM versions WHERE project = ? AND status = 'ready' AND id != ? AND created_at <= ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .bind(name, p.production ?? "", cur?.created_at ?? now()).first();
    target = prev?.id;
  }
  const v = target && (await env.DB.prepare("SELECT id FROM versions WHERE id = ? AND project = ? AND status = 'ready'").bind(target, name).first());
  if (!v) throw new HttpError(404, target ? `${target} is not a ready version of ${name}` : "no earlier ready version");
  await env.DB.prepare("UPDATE projects SET production = ? WHERE name = ?").bind(v.id, name).run();
  return json({ production: v.id, ...urls(env, name) });
}

async function secret(env, request, name, key) {
  await owner(env, request, name);
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key)) throw new HttpError(400, "secret names are UPPER_CASE");
  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM secrets WHERE project = ? AND name = ?").bind(name, key).run();
    return json({ deleted: key });
  }
  const value = await request.text();
  if (!value) throw new HttpError(400, "empty secret");
  await env.DB.prepare("INSERT INTO secrets (project, name, value) VALUES (?, ?, ?) ON CONFLICT (project, name) DO UPDATE SET value = excluded.value")
    .bind(name, key, await encrypt(env, value)).run();
  return json({ set: key });
}

const RUN_COLS = "id, kind, agent, trigger, version, status, queued_at, started_at, heartbeat_at, ended_at, exit_code, problems, log_tail, parent, files, review, review_note, reviewed_at, next_run, replay_of, flags, gate";
const listRun = (r) => ({ ...r, problems: JSON.parse(r.problems ?? "[]"), files: Object.keys(JSON.parse(r.files ?? "{}")), flags: JSON.parse(r.flags ?? "[]") });
const fullRun = ({ trace_token: _t, ...r }) => ({ ...listRun(r), input: r.input == null ? null : JSON.parse(r.input), output: r.output == null ? null : JSON.parse(r.output),
  judge: r.judge == null ? null : JSON.parse(r.judge),
  corrected: r.corrected == null ? null : JSON.parse(r.corrected), input_files: Object.keys(JSON.parse(r.input_files ?? "{}")) });
const TYPES = { pdf: "application/pdf", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", json: "application/json", html: "text/plain; charset=utf-8",
  tex: "text/plain; charset=utf-8", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", csv: "text/csv; charset=utf-8" };

async function runs(env, request, name) {
  await owner(env, request, name);
  const limit = Math.min(Number(new URL(request.url).searchParams.get("limit") ?? 50), 200);
  const rows = (await env.DB.prepare(`SELECT ${RUN_COLS} FROM runs WHERE project = ? ORDER BY queued_at DESC, id DESC LIMIT ?`).bind(name, limit).all()).results.map(listRun);
  // The same error line across runs is a pattern worth fixing, not noise in one run.
  const counts = new Map();
  for (const r of rows.filter((r) => r.ended_at).slice(0, 20)) {
    for (const p of new Set(r.problems.map(pattern))) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const patterns = [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([line, runs]) => ({ line, runs }));
  return json({ runs: rows, patterns, now: now() });
}

async function runLog(env, request, id) {
  const r = await env.DB.prepare("SELECT project, log_tail FROM runs WHERE id = ?").bind(id).first();
  if (!r) throw new HttpError(404, `no run ${id}`);
  await owner(env, request, r.project);
  const obj = await env.FILES.get(`logs/${id}.txt`);
  return new Response(obj ? obj.body : r.log_tail ?? "", { headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function ownedRun(env, request, id) {
  const r = await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first();
  if (!r) throw new HttpError(404, `no run ${id}`);
  await owner(env, request, r.project);
  return r;
}

async function reviews(env, request, name) {
  await owner(env, request, name);
  const rows = (await env.DB.prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM calls c WHERE c.run = r.id) AS calls,
       (SELECT SUM(COALESCE(c.input_tokens, 0) + COALESCE(c.output_tokens, 0)) FROM calls c WHERE c.run = r.id) AS tokens
     FROM runs r WHERE r.project = ? AND r.review = 'waiting' ORDER BY r.ended_at, r.id`).bind(name).all()).results;
  return json({ reviews: rows.map(fullRun) });
}

async function runFile(env, request, id, file) {
  const r = await ownedRun(env, request, id);
  // A run's own files, or the files it was handed by the review that queued it.
  const sha = JSON.parse(r.files ?? "{}")[file] ?? JSON.parse(r.input_files ?? "{}")[file];
  if (!FILE_NAME.test(file) || !sha) throw new HttpError(404, `run ${id} has no file ${file}`);
  const obj = await env.FILES.get(`blobs/${sha}`);
  if (!obj) throw new HttpError(404, `the content of ${file} is gone`);
  const type = TYPES[file.split(".").pop().toLowerCase()] ?? "application/octet-stream";
  return new Response(obj.body, { headers: { "content-type": type, "content-disposition": `inline; filename="${file}"`, "x-content-type-options": "nosniff" } });
}

async function review(env, request, id) {
  const r = await ownedRun(env, request, id);
  const { decision, note, output } = await body(request);
  return json(await decide(env, r, decision, note, output));
}

async function runNow(env, request, name, agent) {
  const p = await owner(env, request, name);
  const v = p.production && (await env.DB.prepare("SELECT config FROM versions WHERE id = ?").bind(p.production).first());
  if (!v || !JSON.parse(v.config).agents?.some((a) => a.name === agent)) throw new HttpError(404, `the live version has no agent ${agent}`);
  const input = await body(request).catch(() => null);
  const id = await queueRun(env, { project: name, agent, version: p.production, trigger: "manual", input: input?.input ?? null });
  return json({ run: id }, 201);
}

async function validate(request) {
  return json(parseConfig(await request.text()));
}

export async function api(request, env, path) {
  const m = (rx) => path.match(rx);
  const method = request.method;
  let x;
  if (method === "POST" && path === "/api/deploys") return startDeploy(env, request);
  if (method === "POST" && path === "/api/validate") return validate(request);
  if (method === "PUT" && (x = m(/^\/api\/blobs\/([0-9a-f]{64})$/))) return putBlob(env, request, x[1]);
  if (method === "POST" && (x = m(/^\/api\/versions\/(\w+)\/finalize$/))) return finish(env, request, x[1]);
  if (method === "GET" && (x = m(/^\/api\/projects\/([\w-]+)$/))) return project(env, request, x[1]);
  if (method === "POST" && (x = m(/^\/api\/projects\/([\w-]+)\/rollback$/))) return rollback(env, request, x[1]);
  if (method === "GET" && (x = m(/^\/api\/projects\/([\w-]+)\/runs$/))) return runs(env, request, x[1]);
  if (method === "POST" && (x = m(/^\/api\/projects\/([\w-]+)\/agents\/([\w-]+)\/run$/))) return runNow(env, request, x[1], x[2]);
  if (["PUT", "DELETE"].includes(method) && (x = m(/^\/api\/projects\/([\w-]+)\/secrets\/(\w+)$/))) return secret(env, request, x[1], x[2]);
  if (method === "GET" && (x = m(/^\/api\/runs\/(\w+)\/log$/))) return runLog(env, request, x[1]);
  if (method === "GET" && (x = m(/^\/api\/projects\/([\w-]+)\/reviews$/))) return reviews(env, request, x[1]);
  if (method === "GET" && (x = m(/^\/api\/runs\/(\w+)$/))) return json(fullRun(await ownedRun(env, request, x[1])));
  if (method === "GET" && (x = m(/^\/api\/runs\/(\w+)\/files\/([^/]+)$/))) return runFile(env, request, x[1], decodeURIComponent(x[2]));
  if (method === "POST" && (x = m(/^\/api\/runs\/(\w+)\/review$/))) return review(env, request, x[1]);
  if (method === "GET" && (x = m(/^\/api\/runs\/(\w+)\/calls$/))) {
    await ownedRun(env, request, x[1]);
    const calls = (await env.DB.prepare("SELECT id, provider, path, model, status, input_tokens, output_tokens, ms, at FROM calls WHERE run = ? ORDER BY at, id").bind(x[1]).all()).results;
    const sum = (k) => calls.reduce((a, c) => a + (c[k] ?? 0), 0);
    return json({ calls, totals: { calls: calls.length, input_tokens: sum("input_tokens"), output_tokens: sum("output_tokens"), ms: sum("ms") } });
  }
  if (method === "GET" && (x = m(/^\/api\/calls\/(\w+)$/))) {
    const c = await env.DB.prepare("SELECT * FROM calls WHERE id = ?").bind(x[1]).first();
    if (!c) throw new HttpError(404, `no call ${x[1]}`);
    await owner(env, request, c.project);
    const obj = await env.FILES.get(`calls/${c.id}.json`);
    return json({ ...c, ...(obj ? await obj.json() : {}) });
  }
  if (method === "GET" && (x = m(/^\/api\/projects\/([\w-]+)\/scorecard$/))) {
    const p = await owner(env, request, x[1]);
    return json({ production: p.production, scorecard: await loadScorecard(env, x[1], new URL(request.url).searchParams.get("agent")) });
  }
  if (method === "POST" && (x = m(/^\/api\/projects\/([\w-]+)\/agents\/([\w-]+)\/replay$/))) {
    await owner(env, request, x[1]);
    const { version, last } = await body(request);
    return json({ version, queued: await replay(env, x[1], x[2], version, last) }, 201);
  }
  throw new HttpError(404, `no API route ${method} ${path}`);
}

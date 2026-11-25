// Versions: an unchangeable file list in R2 (versions/<id>.json) plus a row in D1.
// A version goes uploading -> checking -> ready | failed, and production points at a ready one.
import { checkVersion } from "./checks.js";
import { parseConfig } from "./config.js";
import { replay, startGate } from "./loop.js";
import { HttpError, newId, now } from "./util.js";

const fileCache = new Map();

export async function versionFiles(env, id) {
  if (!fileCache.has(id)) {
    const obj = await env.FILES.get(`versions/${id}.json`);
    if (!obj) throw new HttpError(404, `version ${id} has no file list`);
    fileCache.set(id, new Map(Object.entries(await obj.json())));
  }
  return fileCache.get(id);
}

async function blobText(env, sha) {
  const obj = await env.FILES.get(`blobs/${sha}`);
  if (!obj) throw new HttpError(409, `file ${sha} was not uploaded`);
  return obj.text();
}

export async function createVersion(env, project, files, promote, onReady = null) {
  const id = newId();
  await env.FILES.put(`versions/${id}.json`, JSON.stringify(files));
  await env.DB.prepare("INSERT INTO versions (id, project, status, config, promote, created_at, on_ready) VALUES (?, ?, 'uploading', '{}', ?, ?, ?)")
    .bind(id, project, promote ? 1 : 0, now(), onReady ? JSON.stringify(onReady) : null).run();
  return id;
}

export async function missingBlobs(env, files) {
  const shas = [...new Set(Object.values(files))];
  const heads = await Promise.all(shas.map((s) => env.FILES.head(`blobs/${s}`)));
  return shas.filter((_, i) => !heads[i]);
}

/** Runs the Worker checks, then queues tidegate.json "checks" on a runner, or marks the version ready. */
export async function finalize(env, id) {
  const v = await env.DB.prepare("SELECT * FROM versions WHERE id = ?").bind(id).first();
  if (!v) throw new HttpError(404, `no version ${id}`);
  if (v.status !== "uploading") return { status: v.status, problems: JSON.parse(v.problems ?? "[]"), checks: [] };
  const files = await versionFiles(env, id);
  const missing = await missingBlobs(env, Object.fromEntries(files));
  if (missing.length) throw new HttpError(409, `${missing.length} files are not uploaded yet`);

  const cfgSha = files.get("tidegate.json");
  const { config, problems } = parseConfig(cfgSha ? await blobText(env, cfgSha) : null);
  if (config) problems.push(...(await checkVersion(files, config, (p) => blobText(env, files.get(p)))));
  const checks = config && !problems.length ? config.checks : [];
  const status = problems.length ? "failed" : checks.length ? "checking" : "ready";
  // markReady itself flips the version to ready (and promotes it), so a version with no checks waits as "checking" for it.
  await env.DB.prepare("UPDATE versions SET status = ?, config = ?, problems = ? WHERE id = ?")
    .bind(status === "ready" ? "checking" : status, JSON.stringify(config ?? {}), JSON.stringify(problems), id).run();
  if (status === "checking") {
    await env.DB.prepare("INSERT INTO runs (id, project, kind, trigger, version, status, queued_at) VALUES (?, ?, 'check', 'deploy', ?, 'queued', ?)")
      .bind(newId(), v.project, id, now()).run();
  }
  if (status === "ready") await markReady(env, id);
  return { status, problems, checks };
}

/**
 * A version that passed every check: point production at it if it asked to be promoted, and queue the
 * replays it asked for (a candidate measured on real inputs before anyone promotes it). With "gate" in
 * tidegate.json, promotion waits for the gate's side-by-side replays instead (loop.js).
 */
export async function markReady(env, id) {
  const v = await env.DB.prepare("SELECT project, promote, on_ready, config FROM versions WHERE id = ?").bind(id).first();
  const changed = await env.DB.prepare("UPDATE versions SET status = 'ready' WHERE id = ? AND status != 'ready'").bind(id).run();
  if (!changed.meta.changes) return;
  const config = JSON.parse(v.config);
  const production = (await env.DB.prepare("SELECT production FROM projects WHERE name = ?").bind(v.project).first())?.production;
  const gated = v.promote && config.gate && production && production !== id && (await startGate(env, v.project, id, config, production));
  if (v.promote && !gated) await env.DB.prepare("UPDATE projects SET production = ? WHERE name = ?").bind(id, v.project).run();
  const r = JSON.parse(v.on_ready ?? "null")?.replay;
  if (r?.agent) await replay(env, v.project, r.agent, id, r.last).catch((e) => console.error(`replay after ${id}: ${e.message}`));
}

export async function versionMeta(env, id) {
  const v = await env.DB.prepare("SELECT id, project, status, config FROM versions WHERE id = ?").bind(id).first();
  return v && { ...v, config: JSON.parse(v.config) };
}

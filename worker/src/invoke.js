// Calling an agent over HTTP: <project>.<domain>/<agent> runs production, <project>--<version>.<domain>/<agent>
// runs one version. POST starts a run with the JSON body as input; ?wait=N holds the request up to N
// seconds for the output. Agents need the project token unless tidegate.json marks them public.
import { queueRun } from "./runner.js";
import { HttpError, bearer, json, sha256 } from "./util.js";
import { versionMeta } from "./versions.js";

const MAX_INPUT = 1024 * 1024;
const MAX_WAIT = 30;

async function resolve(env, project, versionId) {
  const p = await env.DB.prepare("SELECT token_hash, production FROM projects WHERE name = ?").bind(project).first();
  if (!p) throw new HttpError(404, `no project ${project}`);
  const id = versionId ?? p.production;
  if (!id) throw new HttpError(404, `${project} has no live version yet`);
  const v = await versionMeta(env, id);
  if (!v || v.project !== project || v.status !== "ready") throw new HttpError(404, `no ready version ${id} of ${project}`);
  return { p, v };
}

async function allowed(request, p, agent) {
  if (agent?.public) return;
  if ((await sha256(bearer(request))) !== p.token_hash) throw new HttpError(401, "this agent needs the project token (Authorization: Bearer ...), or \"public\": true in tidegate.json");
}

const view = (r) => ({
  run: r.id, agent: r.agent, status: r.status, trigger: r.trigger, version: r.version,
  output: r.output == null ? null : JSON.parse(r.output), problems: JSON.parse(r.problems ?? "[]"),
  queued_at: r.queued_at, started_at: r.started_at, ended_at: r.ended_at,
  review: r.review, review_note: r.review_note, next_run: r.next_run,
});

async function waitFor(env, id, seconds) {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const r = await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first();
    if (!["queued", "running"].includes(r.status) || Date.now() >= until) return r;
    await new Promise((res) => setTimeout(res, 1000));
  }
}

export async function invoke(request, env, project, versionId, base, rawPath) {
  const url = new URL(request.url);
  const { p, v } = await resolve(env, project, versionId);
  const agents = v.config.agents;
  const path = rawPath.replace(/\/+$/, "") || "/";
  const wait = Math.min(Math.max(Number(url.searchParams.get("wait") ?? 0) || 0, 0), MAX_WAIT);

  if (request.method === "GET" && path === "/") {
    return json({ project, version: v.id, agents: agents.map((a) => ({
      name: a.name, description: a.description, url: `${base}/${a.name}`, public: a.public, http: a.http, every: a.every, timeout: a.timeout,
    })) });
  }
  let m;
  if (request.method === "GET" && (m = /^\/runs\/(\w+)$/.exec(path))) {
    const r = await env.DB.prepare("SELECT * FROM runs WHERE id = ? AND project = ? AND kind = 'agent'").bind(m[1], project).first();
    if (!r) throw new HttpError(404, `no run ${m[1]}`);
    await allowed(request, p, agents.find((a) => a.name === r.agent));
    return json(view(wait ? await waitFor(env, r.id, wait) : r));
  }
  if (request.method === "POST" && (m = /^\/([a-z0-9-]+)$/.exec(path))) {
    const agent = agents.find((a) => a.name === m[1]);
    if (!agent || !agent.http) throw new HttpError(404, `no agent ${m[1]} with an HTTP trigger in ${project}`);
    await allowed(request, p, agent);
    const text = await request.text();
    if (text.length > MAX_INPUT) throw new HttpError(413, "input is limited to 1 MB");
    let input = null;
    if (text) {
      try {
        input = JSON.parse(text);
      } catch {
        throw new HttpError(400, "the request body must be JSON; it becomes the agent's input");
      }
    }
    const id = await queueRun(env, { project, agent: agent.name, version: v.id, trigger: "http", input });
    const r = await waitFor(env, id, wait);
    const done = !["queued", "running"].includes(r.status);
    return json({ ...view(r), status_url: `${base}/runs/${id}` }, done ? 200 : 202);
  }
  throw new HttpError(404, `POST /<agent> to run an agent; GET / lists them`);
}

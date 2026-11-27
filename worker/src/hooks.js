// GitHub webhooks: POST /hooks/<project>/github starts a run of each live agent whose tidegate.json
// "on.github" lists the event, once the delivery's signature matches that agent's secret.
// A redelivery of the same delivery id starts nothing new.
import { queueRun } from "./runner.js";
import { HttpError, decrypt, json } from "./util.js";
import { versionMeta } from "./versions.js";

const MAX_BODY = 1024 * 1024;

/** True when `header` (X-Hub-Signature-256) is the HMAC-SHA256 of `body` under `secret`. */
export async function signatureMatches(secret, body, header) {
  const m = /^sha256=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m || !secret) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const sig = Uint8Array.from(m[1].match(/../g), (h) => parseInt(h, 16));
  return crypto.subtle.verify("HMAC", key, sig, body);
}

/** Agents whose events include `event` or `event.action`. */
export const listening = (agents, event, action) =>
  agents.filter((a) => a.on?.github?.events.some((e) => e === event || (action && e === `${event}.${action}`)));

export async function githubHook(request, env, project) {
  if (request.method !== "POST") throw new HttpError(405, "GitHub delivers webhooks with POST");
  const event = request.headers.get("x-github-event");
  const delivery = request.headers.get("x-github-delivery");
  if (!event || !delivery) throw new HttpError(400, "not a GitHub webhook: X-GitHub-Event and X-GitHub-Delivery are missing");
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.length > MAX_BODY) throw new HttpError(413, "webhook bodies are limited to 1 MB");

  const p = await env.DB.prepare("SELECT production FROM projects WHERE name = ?").bind(project).first();
  if (!p?.production) throw new HttpError(404, `no live version of ${project}`);
  const subscribed = (await versionMeta(env, p.production)).config.agents.filter((a) => a.on?.github);
  if (!subscribed.length) throw new HttpError(404, `no agent in ${project} has "on": {"github": ...}`);

  const signature = request.headers.get("x-hub-signature-256");
  const trusted = [];
  for (const name of new Set(subscribed.map((a) => a.on.github.secret))) {
    const s = await env.DB.prepare("SELECT value FROM secrets WHERE project = ? AND name = ?").bind(project, name).first();
    if (s && (await signatureMatches(await decrypt(env, s.value), raw, signature))) trusted.push(...subscribed.filter((a) => a.on.github.secret === name));
  }
  if (!trusted.length) throw new HttpError(401, "the signature does not match: set the webhook's secret with tidegate secret set <the name in on.github.secret>");
  if (event === "ping") return json({ pong: true, agents: trusted.map((a) => a.name) });

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new HttpError(400, "set the webhook's content type to application/json");
  }
  const action = typeof payload?.action === "string" ? payload.action : null;
  const runs = [];
  for (const agent of listening(trusted, event, action)) {
    const seen = await env.DB.prepare("SELECT id FROM runs WHERE project = ? AND agent = ? AND trigger = 'github' AND json_extract(input, '$.delivery') = ?")
      .bind(project, agent.name, delivery).first();
    const id = seen?.id ?? (await queueRun(env, { project, agent: agent.name, version: p.production, trigger: "github", input: { event, action, delivery, payload } }));
    runs.push({ agent: agent.name, run: id, already: Boolean(seen) });
  }
  return json({ event: action ? `${event}.${action}` : event, runs }, runs.length ? 202 : 200);
}

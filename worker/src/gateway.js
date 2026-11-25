// The model-call gateway: traces without instrumentation. The runner points each agent's
// ANTHROPIC_BASE_URL and OPENAI_BASE_URL at /gw/<run token>/<provider>, which the official SDKs read, so
// every model call passes through here. Tidegate forwards it unchanged (with the agent's own API key) and
// records model, status, tokens and time per call, plus the request and response bodies in R2.
// Credentials are forwarded, never stored.
import { HttpError, newId, now, sha256 } from "./util.js";

const UPSTREAMS = { anthropic: "https://api.anthropic.com", openai: "https://api.openai.com" };
const MAX_KEPT = 256 * 1024;
const DROP = new Set(["host", "content-length", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "x-forwarded-for", "x-forwarded-proto", "x-real-ip"]);

const upstream = (env, provider) => env[`UPSTREAM_${provider.toUpperCase()}`] ?? UPSTREAMS[provider];

// Every JSON object in a body: the whole body, or each `data:` line of a server-sent event stream.
function objects(text) {
  try {
    return [JSON.parse(text)];
  } catch {
    const out = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        out.push(JSON.parse(line.slice(5)));
      } catch {}
    }
    return out;
  }
}

/** Model and token counts from an Anthropic or OpenAI response, streamed or not. */
export function usageOf(text) {
  let model = null, input = null, output = null;
  for (const o of objects(text)) {
    if (!o || typeof o !== "object") continue;
    model ??= o.model ?? o.message?.model ?? o.response?.model ?? null;
    const u = o.usage ?? o.message?.usage ?? o.response?.usage;
    if (!u) continue;
    const i = u.input_tokens ?? u.prompt_tokens, out = u.output_tokens ?? u.completion_tokens;
    if (typeof i === "number") input = Math.max(input ?? 0, i);
    if (typeof out === "number") output = Math.max(output ?? 0, out);
  }
  return { model, input_tokens: input, output_tokens: output };
}

async function record(env, run, provider, path, requestText, status, responseText, ms) {
  const id = newId();
  const u = usageOf(responseText);
  let req;
  try {
    req = JSON.parse(requestText);
  } catch {
    req = requestText;
  }
  const model = u.model ?? (req && typeof req === "object" ? req.model ?? null : null);
  await env.FILES.put(`calls/${id}.json`, JSON.stringify({ request: typeof req === "string" ? req.slice(0, MAX_KEPT) : req, response: responseText.slice(0, MAX_KEPT) }).slice(0, 2 * MAX_KEPT));
  await env.DB.prepare("INSERT INTO calls (id, run, project, provider, path, model, status, input_tokens, output_tokens, ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, run.id, run.project, provider, path, model, status, u.input_tokens, u.output_tokens, ms, now()).run();
}

export async function gateway(request, env, ctx, token, provider, path) {
  if (!UPSTREAMS[provider]) throw new HttpError(404, `the gateway serves ${Object.keys(UPSTREAMS).join(" and ")}`);
  const run = await env.DB.prepare("SELECT id, project FROM runs WHERE trace_token = ? AND status = 'running'").bind(await sha256(token)).first();
  if (!run) throw new HttpError(401, "this gateway address belongs to a run that is not running");
  const url = new URL(request.url);
  const headers = new Headers();
  for (const [k, v] of request.headers) if (!DROP.has(k.toLowerCase())) headers.set(k, v);
  const requestText = ["GET", "HEAD"].includes(request.method) ? "" : await request.text();
  const started = Date.now();
  const res = await fetch(upstream(env, provider) + path + url.search, { method: request.method, headers, body: requestText || undefined });
  const keep = (text) => ctx.waitUntil(record(env, run, provider, path, requestText, res.status, text, Date.now() - started).catch((e) => console.error(`gateway record: ${e.message}`)));
  const outHeaders = new Headers(res.headers);
  outHeaders.delete("content-encoding");
  outHeaders.delete("content-length");
  if (!res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const text = await res.text();
    keep(text);
    return new Response(text, { status: res.status, headers: outHeaders });
  }
  // A stream goes to the agent as it arrives; a copy is read to the end and recorded afterwards.
  const [toAgent, toRecord] = res.body.tee();
  ctx.waitUntil((async () => {
    const reader = toRecord.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (text.length < 4 * 1024 * 1024) text += value;
    }
    return text;
  })().then((text) => record(env, run, provider, path, requestText, res.status, text, Date.now() - started)).catch((e) => console.error(`gateway stream: ${e.message}`)));
  return new Response(toAgent, { status: res.status, headers: outHeaders });
}

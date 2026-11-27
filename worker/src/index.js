import { api } from "./api.js";
import { gateway } from "./gateway.js";
import { githubHook } from "./hooks.js";
import { invoke } from "./invoke.js";
import { dashboard, home } from "./pages.js";
import { runnerApi, schedule } from "./runner.js";
import { HttpError, json } from "./util.js";

const AGENT_HOST = /^([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)(?:--(\w+))?$/;

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const host = url.hostname;
  if (host !== env.DOMAIN && host.endsWith(`.${env.DOMAIN}`)) {
    const m = AGENT_HOST.exec(host.slice(0, -env.DOMAIN.length - 1));
    if (!m) return new Response("Not a Tidegate project address.", { status: 404 });
    return invoke(request, env, m[1], m[2], url.origin, url.pathname);
  }
  const path = url.pathname;
  // The same endpoints by path, for clients that cannot reach a subdomain: /p/<project>[--<version>]/<agent>
  const p = /^\/p\/([^/]+)(\/.*)?$/.exec(path);
  if (p) {
    const m = AGENT_HOST.exec(p[1]);
    if (!m) return new Response("Not a Tidegate project address.", { status: 404 });
    return invoke(request, env, m[1], m[2], `${url.origin}/p/${p[1]}`, p[2] ?? "/");
  }
  const gw = /^\/gw\/([0-9a-f]{48})\/(\w+)(\/.*)$/.exec(path);
  if (gw) return gateway(request, env, ctx, gw[1], gw[2], gw[3]);
  const hook = /^\/hooks\/([a-z0-9-]{1,32})\/github$/.exec(path);
  if (hook) return githubHook(request, env, hook[1]);
  if (path.startsWith("/api/runner/")) return runnerApi(request, env, path);
  if (path.startsWith("/api/")) return api(request, env, path);
  if (path === "/") return home(env);
  if (path === "/dashboard") return dashboard();
  return new Response("Not found.", { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Tidegate hit an internal error" }, 500);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(schedule(env));
  },
};

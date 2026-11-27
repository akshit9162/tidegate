// Tidegate's own pages: the deploy page and the live view of runs.
import { json } from "./util.js";

const CSS = `
:root{--bg:#f7f6f2;--card:#fff;--ink:#1c1b19;--mute:#6b6862;--line:#e3e0d8;--accent:#1f5f8b;--ok:#2f7d4f;--bad:#b3412e;--warn:#a26b12}
@media (prefers-color-scheme:dark){:root{--bg:#141412;--card:#1d1c1a;--ink:#ece9e2;--mute:#9c988f;--line:#2f2d29;--accent:#7fb4dc;--ok:#6cc08d;--bad:#ee8a76;--warn:#e0b25a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:960px;margin:0 auto;padding:32px 16px 64px}header{display:flex;gap:20px;align-items:baseline;margin-bottom:28px;flex-wrap:wrap}
header b{font-size:20px}header a{color:var(--mute);text-decoration:none}header a:hover{color:var(--ink)}
h1{font-size:28px;margin:0 0 6px}h2{font-size:17px;margin:28px 0 10px}p{margin:0 0 12px;color:var(--mute)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:12px}
input,button{font:inherit;border-radius:8px;border:1px solid var(--line);padding:8px 12px;background:var(--card);color:var(--ink)}
button{background:var(--ink);color:var(--bg);border:0;cursor:pointer}button:disabled{opacity:.5}
#drop{border:2px dashed var(--line);border-radius:12px;padding:44px 16px;text-align:center;color:var(--mute);cursor:pointer}
#drop.on{border-color:var(--accent);color:var(--ink)}code,pre{font:13px/1.45 ui-monospace,Menlo,monospace}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;max-height:320px;white-space:pre-wrap;margin:8px 0 0}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.mute{color:var(--mute)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.grow{flex:1;min-width:180px}
.tags span{display:inline-block;font-size:12px;border:1px solid var(--line);border-radius:99px;padding:1px 8px;margin:0 4px 4px 0;color:var(--mute)}
.cells{display:flex;gap:3px;flex-wrap:wrap}.cells i{width:14px;height:14px;border-radius:3px;display:inline-block;background:var(--line)}
.cells i.ok{background:var(--ok)}.cells i.review{background:var(--accent)}.cells i.failed,.cells i.timeout{background:var(--bad)}.cells i.running{background:var(--warn)}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mute);font-weight:500}a{color:var(--accent)}
textarea{font:inherit;width:100%;min-height:64px;border-radius:8px;border:1px solid var(--line);padding:8px 12px;background:var(--card);color:var(--ink);margin:10px 0}
button.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}button.link{background:none;color:var(--accent);padding:0;border:0}
.preview iframe{width:100%;height:640px;border:1px solid var(--line);border-radius:8px;margin-top:10px;background:#fff}`;

const page = (title, bodyHtml, script = "") => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${CSS}</style></head>
<body><main><header><b>Tidegate</b><a href="/">Deploy</a><a href="/dashboard">Runs</a></header>
${bodyHtml}</main>${script ? `<script type="module">${script}</script>` : ""}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const DEPLOY_JS = `
const $ = (s) => document.querySelector(s);
const out = $("#out");
const say = (html) => (out.innerHTML = html);
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const SKIP = /(^|\\/)(\\.git|node_modules|__pycache__|\\.venv|\\.DS_Store)(\\/|$)/;
async function walk(entry, prefix, list) {
  if (entry.isFile) return list.push(await new Promise((r, j) => entry.file((f) => r([prefix + entry.name, f]), j)));
  const reader = entry.createReader();
  for (;;) {
    const batch = await new Promise((r, j) => reader.readEntries(r, j));
    if (!batch.length) break;
    for (const e of batch) await walk(e, prefix + entry.name + "/", list);
  }
}
function strip(list) {
  const tops = new Set(list.map(([p]) => p.split("/")[0]));
  return tops.size === 1 && list.every(([p]) => p.includes("/")) ? list.map(([p, f]) => [p.slice(p.indexOf("/") + 1), f]) : list;
}
async function deploy(list) {
  const project = $("#name").value.trim();
  if (!project) return say('<span class="bad">Name the project first.</span>');
  list = strip(list).filter(([p]) => !SKIP.test(p));
  say("Reading " + list.length + " files…");
  const files = {}, bySha = {};
  for (const [p, f] of list) { const sha = hex(await crypto.subtle.digest("SHA-256", await f.arrayBuffer())); files[p] = sha; bySha[sha] = f; }
  const token = localStorage.getItem("tidegate:" + project) || "";
  const auth = token ? { authorization: "Bearer " + token } : {};
  let r = await fetch("/api/deploys", { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ project, files }) });
  let d = await r.json();
  if (!r.ok) return say('<span class="bad">' + d.error + "</span>");
  if (d.token) localStorage.setItem("tidegate:" + project, d.token);
  const t = d.token || token;
  for (const [i, sha] of d.missing.entries()) {
    say("Uploading " + (i + 1) + " of " + d.missing.length + " new files…");
    r = await fetch("/api/blobs/" + sha, { method: "PUT", headers: { authorization: "Bearer " + t, "x-tidegate-project": project }, body: bySha[sha] });
    if (!r.ok) return say('<span class="bad">' + (await r.json()).error + "</span>");
  }
  say("Checking…");
  r = await fetch("/api/versions/" + d.version + "/finalize", { method: "POST", headers: { authorization: "Bearer " + t } });
  const f = await r.json();
  if (!r.ok) return say('<span class="bad">' + f.error + "</span>");
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => "&#" + c.charCodeAt(0) + ";");
  let html = f.status === "ready" ? '<b class="ok">Live.</b> Agents: <a href="' + f.url + '">' + f.url + "</a>"
    : f.status === "checking" ? '<b class="warn">Checks are running</b> on a runner. It goes live when they pass; see <a href="/dashboard#project=' + project + '">runs</a>.'
    : '<b class="bad">Not published.</b> Fix these and drop the folder again:<pre>' + f.problems.map(esc).join("\\n") + "</pre>";
  if (d.token) html += '<p style="margin-top:12px">Your deploy token for <b>' + project + '</b> is saved in this browser. Copy it to deploy from the command line too:</p><pre>' + d.token + "</pre>";
  say(html);
}
const drop = $("#drop");
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("on"); };
drop.ondragleave = () => drop.classList.remove("on");
drop.ondrop = async (e) => {
  e.preventDefault(); drop.classList.remove("on");
  const list = [];
  for (const item of [...e.dataTransfer.items]) { const en = item.webkitGetAsEntry(); if (en) await walk(en, "", list); }
  deploy(list).catch((x) => say('<span class="bad">' + x.message + "</span>"));
};
drop.onclick = () => $("#pick").click();
$("#pick").onchange = (e) => deploy([...e.target.files].map((f) => [f.webkitRelativePath || f.name, f])).catch((x) => say('<span class="bad">' + x.message + "</span>"));`;

export function home(env) {
  const api = `${env.SCHEME ?? "https"}://${env.DOMAIN}${env.PORT ? `:${env.PORT}` : ""}`;
  return page("Tidegate", `
<h1>Deploy an AI agent</h1>
<p>Drop the agent's folder, with a tidegate.json naming its agents. Tidegate gives each one an HTTP endpoint and a schedule, runs it for up to an hour, keeps its secrets and files, and records every run. No git, no Dockerfile.</p>
<div class="card"><div class="row" style="margin-bottom:12px"><label for="name">Project name</label>
<input id="name" class="grow" placeholder="support-triage" pattern="[a-z0-9-]+" autocomplete="off"></div>
<div id="drop">Drop a folder here, or click to choose one</div><input id="pick" type="file" webkitdirectory hidden>
<div id="out" style="margin-top:14px"></div></div>
<h2>From the command line</h2>
<div class="card"><pre>tidegate deploy                # in the project folder; uploads changed files only
tidegate secret set ANTHROPIC_API_KEY
tidegate invoke triage '{"ticket": "..."}'
tidegate runs                  # recent runs and repeated problems
tidegate rollback</pre><p style="margin-top:10px">API: <code>${esc(api)}</code></p></div>`, DEPLOY_JS);
}

const DASH_JS = `
const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.hash.slice(1));
if (params.get("token")) { localStorage.setItem("tidegate:" + params.get("project"), params.get("token")); history.replaceState(null, "", "#project=" + params.get("project")); }
$("#project").value = params.get("project") || localStorage.getItem("tidegate:last") || "";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => "&#" + c.charCodeAt(0) + ";");
const ago = (t, now) => !t ? "" : t > now ? "in " + Math.round((t - now) / 60) + "m" : now - t < 90 ? (now - t) + "s ago" : now - t < 5400 ? Math.round((now - t) / 60) + "m ago" : Math.round((now - t) / 3600) + "h ago";
const pct = (x) => x == null ? "" : Math.round(x * 100) + "%";
const dur = (r, now) => r.started_at ? Math.round(((r.ended_at || now) - r.started_at) / 60 * 10) / 10 + " min" : "";
let timer, reviewKey = "";
// Replace a section only when its HTML changed: rebuilding the page every refresh moved the scroll position.
const put = (el, html) => { if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; } };
const notes = {};
const fileBtn = (r, f) => '<button class="link" data-run="' + r.id + '" data-file="' + esc(f) + '">' + esc(f) + "</button>";
function reviewCard(r) {
  const o = r.output && typeof r.output === "object" ? r.output : {};
  const rest = Object.fromEntries(Object.entries(o).filter(([k]) => !["title", "summary"].includes(k)));
  return '<div class="card" data-review="' + r.id + '"><b>' + esc(o.title || r.agent) + '</b> <span class="mute">' + esc(r.agent) + " run " + r.id + (r.parent ? ", revision of " + r.parent : "") + "</span>" +
    (r.flags.length ? '<p class="warn" style="margin:8px 0 0">Flagged: ' + r.flags.map(esc).join("; ") + "</p>" : "") +
    (r.judge && r.judge.results ? '<p style="margin:6px 0 0">Judge <span class="mute">(' + esc(r.judge.model) + ")</span>: " + Object.entries(r.judge.results).map(([k, x]) => '<span class="' + (x.pass === false ? "bad" : x.pass ? "ok" : "mute") + '">' + esc(k) + (x.good != null ? " " + x.good : "") + "</span>").join(" · ") + "</p>" : "") +
    (r.calls ? '<p style="margin:6px 0 0">' + r.calls + " model call" + (r.calls > 1 ? "s" : "") + ", " + (r.tokens || 0).toLocaleString() + ' tokens <span class="mute">(tidegate trace ' + r.id + ")</span></p>" : "") +
    (o.summary ? '<pre>' + esc(o.summary) + "</pre>" : "") +
    (r.files.length ? '<p style="margin:10px 0 0">Files: ' + r.files.map((f) => fileBtn(r, f)).join(" · ") + "</p>" : "") +
    '<div class="preview"></div>' +
    (Object.keys(rest).length ? '<details style="margin-top:8px"><summary class="mute">Full output</summary><pre>' + esc(JSON.stringify(rest, null, 1)) + "</pre></details>" : "") +
    '<textarea placeholder="Note: what to change (needed to revise), or why you rejected it">' + esc(notes[r.id] || "") + "</textarea>" +
    '<details class="fix"><summary class="mute">Edit the output yourself</summary><textarea class="output" spellcheck="false" style="min-height:160px;font:13px/1.45 ui-monospace,Menlo,monospace">' + esc(JSON.stringify(r.output, null, 1)) + '</textarea>' +
    '<p style="margin:0 0 8px">Your version is kept as an example the agent sees on later runs, and the next step runs with it.</p><button data-decide="correct">Save my version</button></details>' +
    '<div class="row" style="margin-top:10px"><button data-decide="approve">Approve</button><button class="ghost" data-decide="revise">Revise with note</button><button class="ghost" data-decide="reject">Reject</button><span class="mute msg"></span></div></div>';
}
async function load() {
  const project = $("#project").value.trim();
  if (!project) return;
  localStorage.setItem("tidegate:last", project);
  const token = localStorage.getItem("tidegate:" + project);
  if (!token) { $("#view").innerHTML = '<div class="card">No token for ' + esc(project) + ' in this browser. Run <code>tidegate dashboard</code> in the project folder to open this page signed in.</div>'; return; }
  const h = { authorization: "Bearer " + token };
  const [pr, rr, vr, sr] = await Promise.all([fetch("/api/projects/" + project, { headers: h }), fetch("/api/projects/" + project + "/runs?limit=100", { headers: h }), fetch("/api/projects/" + project + "/reviews", { headers: h }), fetch("/api/projects/" + project + "/scorecard", { headers: h })]);
  if (!pr.ok) { $("#view").innerHTML = '<div class="card bad">' + esc((await pr.json()).error) + "</div>"; return; }
  const p = await pr.json(), { runs, patterns, now } = await rr.json(), { reviews } = await vr.json(), { scorecard } = await sr.json();
  // Re-render reviews only when the waiting set changes, so a note being typed is never wiped.
  const key = reviews.map((r) => r.id).join(",");
  if (key !== reviewKey) {
    reviewKey = key;
    $("#reviews").innerHTML = reviews.length ? "<h2>Waiting for your review (" + reviews.length + ")</h2>" + reviews.map(reviewCard).join("") : "";
  }
  const running = runs.filter((r) => r.status === "running");
  const every = (s) => !s ? "on request" : "every " + (s >= 3600 ? s / 3600 + "h" : s / 60 + "m");
  const agents = p.agents.map((j) => { const last = runs.find((r) => r.agent === j.name && r.ended_at); const mine = runs.filter((r) => r.agent === j.name).slice(0, 40).reverse();
    return '<tr><td><b>' + esc(j.name) + '</b><br><code class="mute">' + esc(j.run) + '</code></td><td>' + every(j.every) + (j.http ? ", HTTP" + (j.public ? " (public)" : "") : "") + '</td><td>' +
      (last ? '<span class="' + (last.status === "ok" ? "ok" : "bad") + '">' + last.status + "</span> " + ago(last.ended_at, now) + ", " + dur(last, now) : '<span class="mute">not run yet</span>') +
      '</td><td><div class="cells">' + mine.map((r) => '<i class="' + (r.review === "waiting" ? "review" : r.status) + '" title="' + r.status + (r.review ? ", " + r.review : "") + " " + ago(r.queued_at, now) + '"></i>').join("") + "</div></td></tr>"; }).join("");
  // Lead with what needs a person; the detail below is for when something does.
  const needs = [];
  if (reviews.length) needs.push(reviews.length + (reviews.length > 1 ? " results are" : " result is") + " waiting for your review, below.");
  const latest = p.versions[0];
  if (latest && latest.status === "failed") needs.push("The last deploy (" + latest.id + ") failed its checks: " + latest.problems[0]);
  if (latest && latest.gate && latest.gate.status === "blocked") needs.push("The gate kept " + latest.id + " from going live: " + latest.gate.agents.flatMap((a) => a.worse.map((w) => a.agent + " " + w)).join("; ") + ". Promote anyway with tidegate promote " + latest.id + ".");
  if (latest && latest.gate && latest.gate.status === "replaying") needs.push("Version " + latest.id + " is replaying past inputs next to the live version; it goes live if it does no worse.");
  const unset = [...new Set(p.agents.flatMap((j) => j.secrets))].filter((s) => !p.secrets.includes(s));
  if (unset.length) needs.push("Secrets your agents ask for but are not set: " + unset.join(", ") + ". Run tidegate secret set NAME.");
  for (const j of p.agents) { const last = runs.find((r) => r.agent === j.name && r.ended_at); if (last && last.status !== "ok") needs.push("Agent " + j.name + " " + last.status + " on its last run: " + (last.problems[0] || "exit code " + last.exit_code)); }
  if (patterns.length) needs.push(patterns.length + " problem" + (patterns.length > 1 ? "s keep" : " keeps") + " coming back, the worst in " + patterns[0].runs + " of the last 20 runs: " + patterns[0].line);
  put($("#needs"),
    "<h2>Needs you</h2>" + (needs.length ? '<div class="card"><ul style="margin:0;padding-left:18px">' + needs.map((n) => "<li>" + esc(n) + "</li>").join("") + "</ul></div>" : '<div class="card ok">Nothing. The last run of every agent and every check passed, and nothing waits for review.</div>'));
  put($("#view"),
    '<div class="card row"><div class="grow"><b><a href="' + p.url + '">' + p.url + '</a></b><br><span class="mute">live version ' + esc(p.production || "none") + ", secrets: " + (p.secrets.join(", ") || "none") + "</span></div></div>" +
    "<h2>Running now (" + running.length + ")</h2>" + (running.map((r) => '<div class="card"><b>' + esc(r.agent || "checks") + '</b> <span class="mute">' + esc(r.trigger) + '</span> <span class="mute">started ' + ago(r.started_at, now) + ", last heartbeat " + ago(r.heartbeat_at, now) + '</span><pre>' + esc((r.log_tail || "").split("\\n").slice(-12).join("\\n")) + "</pre></div>").join("") || '<div class="card mute">Nothing running.</div>') +
    "<h2>Agents</h2>" + (agents ? '<div class="card"><table><tr><th>Agent</th><th>Runs</th><th>Last run</th><th>Recent runs</th></tr>' + agents + "</table></div>" : '<div class="card mute">No live version yet.</div>') +
    "<h2>Scorecard</h2>" + (scorecard.length ? '<div class="card" style="overflow:auto"><table><tr><th>Version</th><th>Agent</th><th>Runs</th><th>OK</th><th>Approved</th><th>First time</th><th>Auto</th><th>Tokens</th><th>Judge agrees</th><th>Evals</th></tr>' +
      scorecard.map((x) => "<tr><td>" + esc(x.version) + (x.version === p.production ? ' <span class="ok">live</span>' : "") + (x.kind === "replay" ? ' <span class="warn">replay</span>' : "") + "</td><td>" + esc(x.agent) + "</td><td>" + x.runs + "</td><td>" + pct(x.ok_rate) + "</td><td>" +
        (x.reviewed ? pct(x.approval_rate) + ' <span class="mute">of ' + x.reviewed + "</span>" : "") + "</td><td>" + pct(x.approved_first_time) + "</td><td>" + (x.auto || "") + "</td><td>" + (x.median_tokens ?? "") + "</td><td>" + (x.judge_agreement && x.judge_agreement.n ? pct(x.judge_agreement.rate) + ' <span class="mute">of ' + x.judge_agreement.n + "</span>" : "") + "</td><td>" +
        Object.entries(x.evals).map(([k, e]) => esc(k) + " " + (e.pass_rate != null ? pct(e.pass_rate) : "") + (e.mean != null ? " " + e.mean : "")).join("<br>") + "</td></tr>").join("") +
      '</table><p style="margin:8px 0 0">Approved is the share of reviewed runs you approved (your own edits count as not approved); first time leaves out revisions. Auto counts runs nothing flagged, approved without you. Tokens is the median per run. Judge agrees is how often the judge verdict matched yours. Replays rerun real inputs on a candidate version.</p></div>' : '<div class="card mute">No finished runs yet.</div>') +
    "<h2>Repeated problems</h2>" + (patterns.length ? '<div class="card"><table><tr><th>Runs</th><th>Line</th></tr>' + patterns.map((x) => "<tr><td>" + x.runs + "</td><td><code>" + esc(x.line) + "</code></td></tr>").join("") + "</table></div>" : '<div class="card mute">No problem seen in more than one of the last 20 runs.</div>') +
    "<h2>All runs</h2><div class=\\"card\\"><table><tr><th>When</th><th>What</th><th>From</th><th>Result</th><th>Time</th><th>Problems</th></tr>" +
    runs.map((r) => "<tr><td>" + ago(r.queued_at, now) + "</td><td>" + esc(r.agent || "checks") + "</td><td>" + esc(r.trigger) + '</td><td class="' + (r.status === "ok" ? "ok" : r.status === "running" || r.status === "queued" ? "warn" : "bad") + '">' + r.status + (r.review ? '<br><span class="mute" title="' + esc(r.review_note) + '">' + r.review + "</span>" : "") +
      "</td><td>" + dur(r, now) + "</td><td>" + (r.problems.length ? esc(r.problems[0]).slice(0, 140) + (r.problems.length > 1 ? ' <span class="mute">+' + (r.problems.length - 1) + "</span>" : "") : "") + "</td></tr>").join("") + "</table></div>");
}
$("#reviews").oninput = (e) => { const c = e.target.closest("[data-review]"); if (c && !e.target.classList.contains("output")) notes[c.dataset.review] = e.target.value; };
$("#reviews").onclick = async (e) => {
  const project = $("#project").value.trim(), h = { authorization: "Bearer " + localStorage.getItem("tidegate:" + project) };
  const f = e.target.closest("[data-file]");
  if (f) {
    const res = await fetch("/api/runs/" + f.dataset.run + "/files/" + encodeURIComponent(f.dataset.file), { headers: h });
    const url = URL.createObjectURL(await res.blob());
    f.closest("[data-review]").querySelector(".preview").innerHTML = '<iframe title="' + esc(f.dataset.file) + '" src="' + url + '"></iframe><a href="' + url + '" download="' + esc(f.dataset.file) + '">Download ' + esc(f.dataset.file) + "</a>";
    return;
  }
  const b = e.target.closest("[data-decide]");
  if (!b) return;
  const card = b.closest("[data-review]"), id = card.dataset.review;
  let output;
  if (b.dataset.decide === "correct") {
    try { output = JSON.parse(card.querySelector(".output").value); }
    catch (x) { card.querySelector(".msg").textContent = "Your version is not valid JSON: " + x.message; return; }
  }
  card.querySelectorAll("button").forEach((x) => (x.disabled = true));
  const res = await fetch("/api/runs/" + id + "/review", { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ decision: b.dataset.decide, note: notes[id] || "", output }) });
  const d = await res.json();
  if (!res.ok) { card.querySelector(".msg").textContent = d.error; card.querySelectorAll("button").forEach((x) => (x.disabled = false)); return; }
  delete notes[id];
  card.querySelector(".msg").textContent = d.review + (d.next_run ? "; queued run " + d.next_run : "");
  setTimeout(load, 800);
};
$("#go").onclick = load;
load(); timer = setInterval(load, 5000);`;

export function dashboard() {
  return page("Tidegate runs", `<h1>Runs</h1><p>What needs you first: results to review, failures, missing secrets. Then every run, what is running now, and problems that keep coming back. Refreshes every 5 seconds.</p>
<div class="card row"><input id="project" class="grow" placeholder="project name"><button id="go">Show</button></div><div id="needs"></div><div id="reviews"></div><div id="view"></div>`, DASH_JS);
}

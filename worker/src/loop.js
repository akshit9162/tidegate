// The improvement loop: measure each version, and replay old inputs on a candidate before it ships.
//
// Signals per version and agent, from what Tidegate already records:
//   - run outcome (ok / failed / timeout);
//   - the person's review: approved, revised or rejected; "approved first time" counts runs that were
//     not themselves a revision;
//   - evals the agent reports in its output as {"evals": {"name": true | 0.8 | {"pass": true, "score": 0.8}}}.
// Replays (trigger 'replay') are counted apart from live runs, so a candidate is compared on the same inputs.
import { queueRun } from "./runner.js";
import { HttpError } from "./util.js";

const DECIDED = ["approved", "corrected", "revised", "rejected"];
const SOURCE_TRIGGERS = ["http", "manual", "schedule", "review"];

/**
 * The run's output with the judge's graded answers added to its evals as judge.<question>, so flags,
 * the scorecard and the gate read one set of evals. An ungraded answer (no pass rule) is left out.
 */
export function withJudge(output, judge) {
  const results = judge && !judge.error ? judge.results : null;
  if (!results) return output;
  const extra = {};
  for (const [name, r] of Object.entries(results)) {
    if (r.pass == null && r.good == null) continue;
    extra[`judge.${name}`] = { ...(r.pass != null ? { pass: r.pass } : {}), ...(r.good != null ? { score: r.good } : {}) };
  }
  const base = output && typeof output === "object" && !Array.isArray(output) ? output : { value: output };
  return { ...base, evals: { ...(base.evals && typeof base.evals === "object" ? base.evals : {}), ...extra } };
}

/**
 * How often the judge agrees with the person: among runs both judged and decided by a person, the judge
 * "approves" when no graded answer failed, and the person approves only with approve (not correct,
 * revise or reject). Trust the judge in the gate only once this is high over enough runs.
 */
export function judgeAgreement(runs) {
  let n = 0, agree = 0;
  for (const r of runs) {
    if (!r.judge || r.judge.error || !DECIDED.includes(r.review)) continue;
    const judgeOk = Object.values(r.judge.results).every((x) => x.pass !== false);
    n++;
    if (judgeOk === (r.review === "approved")) agree++;
  }
  return { n, rate: rate(agree, n) };
}

function evalEntries(output) {
  const evals = output && typeof output === "object" ? output.evals : null;
  if (!evals || typeof evals !== "object") return [];
  return Object.entries(evals).map(([name, v]) => {
    if (typeof v === "boolean") return [name, { pass: v }];
    if (typeof v === "number") return [name, { score: v }];
    if (v && typeof v === "object") return [name, { pass: typeof v.pass === "boolean" ? v.pass : undefined, score: typeof v.score === "number" ? v.score : undefined }];
    return [name, {}];
  });
}

const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function scorecard(runs) {
  const groups = new Map();
  for (const r of runs) {
    if (r.kind !== "agent" || ["queued", "running"].includes(r.status)) continue;
    const kind = r.trigger === "replay" ? "replay" : "live";
    const key = `${r.version}|${r.agent}|${kind}`;
    if (!groups.has(key)) groups.set(key, { version: r.version, agent: r.agent, kind, runs: [] });
    groups.get(key).runs.push(r);
  }
  return [...groups.values()].map(({ version, agent, kind, runs: rs }) => {
    const decided = rs.filter((r) => DECIDED.includes(r.review));
    const firsts = decided.filter((r) => r.trigger !== "review"); // not itself a revision
    const evals = {};
    for (const r of rs) {
      for (const [name, v] of evalEntries(r.output)) {
        const e = (evals[name] ??= { n: 0, passed: 0, judged: 0, scores: [] });
        e.n++;
        if (v.pass !== undefined) {
          e.judged++;
          if (v.pass) e.passed++;
        }
        if (v.score !== undefined) e.scores.push(v.score);
      }
    }
    return {
      version, agent, kind,
      runs: rs.length,
      ok_rate: rate(rs.filter((r) => r.status === "ok").length, rs.length),
      reviewed: decided.length,
      approved: decided.filter((r) => r.review === "approved").length,
      corrected: decided.filter((r) => r.review === "corrected").length,
      auto: rs.filter((r) => r.review === "auto").length,
      revised: decided.filter((r) => r.review === "revised").length,
      rejected: decided.filter((r) => r.review === "rejected").length,
      approval_rate: rate(decided.filter((r) => r.review === "approved").length, decided.length),
      approved_first_time: rate(firsts.filter((r) => r.review === "approved").length, firsts.length),
      waiting: rs.filter((r) => r.review === "waiting").length,
      median_seconds: median(rs.filter((r) => r.started_at && r.ended_at).map((r) => r.ended_at - r.started_at)),
      median_tokens: median(rs.filter((r) => r.tokens != null).map((r) => r.tokens)),
      judge_agreement: judgeAgreement(rs),
      evals: Object.fromEntries(Object.entries(evals).map(([name, e]) => [name, {
        n: e.n, pass_rate: rate(e.passed, e.judged), mean: e.scores.length ? Math.round((e.scores.reduce((a, b) => a + b, 0) / e.scores.length) * 1000) / 1000 : null,
      }])),
    };
  });
}

export async function loadScorecard(env, project, agent) {
  const rows = (await env.DB.prepare(
    `SELECT r.kind, r.agent, r.trigger, r.version, r.status, r.output, r.review, r.parent, r.started_at, r.ended_at, r.judge, v.created_at AS version_at,
       (SELECT SUM(COALESCE(c.input_tokens, 0) + COALESCE(c.output_tokens, 0)) FROM calls c WHERE c.run = r.id) AS tokens
     FROM runs r JOIN versions v ON v.id = r.version WHERE r.project = ? AND r.gate IS NULL ${agent ? "AND r.agent = ?" : ""} ORDER BY r.queued_at DESC LIMIT 2000`,
  ).bind(...(agent ? [project, agent] : [project])).all()).results;
  const order = new Map(rows.map((r) => [r.version, r.version_at]));
  return scorecard(rows.map((r) => {
    const judge = JSON.parse(r.judge ?? "null");
    return { ...r, judge, output: withJudge(r.output == null ? null : JSON.parse(r.output), judge) };
  }))
    .sort((a, b) => (order.get(b.version) ?? 0) - (order.get(a.version) ?? 0) || a.agent.localeCompare(b.agent) || a.kind.localeCompare(b.kind));
}

async function sources(env, project, agent, n) {
  return (await env.DB.prepare(
    `SELECT id, input FROM runs WHERE project = ? AND agent = ? AND kind = 'agent' AND trigger IN (${SOURCE_TRIGGERS.map(() => "?").join(",")})
     AND parent IS NULL AND input IS NOT NULL AND status IN ('ok', 'failed', 'timeout') ORDER BY queued_at DESC LIMIT ?`,
  ).bind(project, agent, ...SOURCE_TRIGGERS, n).all()).results;
}

/** Rerun the agent's last `last` real inputs on `version`. Returns the queued run ids. */
export async function replay(env, project, agent, version, last = 10) {
  const v = await env.DB.prepare("SELECT id, config FROM versions WHERE id = ? AND project = ? AND status = 'ready'").bind(version, project).first();
  if (!v) throw new HttpError(404, `${version} is not a ready version of ${project}; deploy it with --no-promote first`);
  if (!JSON.parse(v.config).agents.some((a) => a.name === agent)) throw new HttpError(404, `version ${version} has no agent ${agent}`);
  const found = await sources(env, project, agent, Math.min(Math.max(Number(last) || 10, 1), 50));
  if (!found.length) throw new HttpError(404, `${agent} has no finished runs with an input to replay`);
  const queued = [];
  for (const s of found) queued.push(await queueRun(env, { project, agent, version, trigger: "replay", input: JSON.parse(s.input), replayOf: s.id }));
  return queued;
}

// ---- the deploy gate ----
// A version deployed to go live, in a project whose tidegate.json has "gate", is not promoted straight away.
// Tidegate reruns the last `replay` real inputs of each gated agent on the candidate and on the live version
// side by side (runs tagged gate = candidate), and promotes only if the candidate is not worse on any
// agent: ok rate and each eval's pass rate and mean, within `tolerance`. A blocked candidate stays ready
// and can still be promoted by hand.

/** Queue the gate's replays. Returns false when there is nothing to compare, so the caller promotes. */
export async function startGate(env, project, candidate, config, production) {
  const live = await env.DB.prepare("SELECT config FROM versions WHERE id = ?").bind(production).first();
  const liveAgents = new Set(JSON.parse(live?.config ?? "{}").agents?.map((a) => a.name) ?? []);
  const names = (config.gate.agents ?? config.agents.map((a) => a.name)).filter((n) => liveAgents.has(n));
  let queued = 0;
  for (const agent of names) {
    for (const s of await sources(env, project, agent, config.gate.replay)) {
      const input = JSON.parse(s.input);
      for (const version of [candidate, production]) {
        await queueRun(env, { project, agent, version, trigger: "replay", input, replayOf: s.id, gate: candidate });
        queued++;
      }
    }
  }
  if (!queued) return false;
  await env.DB.prepare("UPDATE versions SET gate = ? WHERE id = ?")
    .bind(JSON.stringify({ status: "replaying", against: production, runs: queued, tolerance: config.gate.tolerance, judge: config.judge?.gate === true }), candidate).run();
  return true;
}

/** Compare the candidate's gate replays with the live version's. Pure, so it is unit tested. */
export function judgeGate(runs, candidate, tolerance = 0) {
  const side = (rs) => {
    const card = scorecard(rs.map((r) => ({ ...r, kind: "agent", trigger: "live" })))[0];
    return card ? { runs: card.runs, ok_rate: card.ok_rate, evals: card.evals } : { runs: 0, ok_rate: null, evals: {} };
  };
  const agents = [];
  for (const agent of [...new Set(runs.map((r) => r.agent))].sort()) {
    const mine = runs.filter((r) => r.agent === agent);
    const cand = side(mine.filter((r) => r.version === candidate));
    const live = side(mine.filter((r) => r.version !== candidate));
    const worse = [];
    const below = (a, b) => a != null && b != null && a < b - tolerance;
    if (below(cand.ok_rate, live.ok_rate)) worse.push(`ok rate ${pctText(cand.ok_rate)} vs ${pctText(live.ok_rate)} live`);
    for (const [name, e] of Object.entries(cand.evals)) {
      const l = live.evals[name];
      if (!l) continue;
      if (below(e.pass_rate, l.pass_rate)) worse.push(`eval ${name} passes ${pctText(e.pass_rate)} vs ${pctText(l.pass_rate)} live`);
      if (below(e.mean, l.mean)) worse.push(`eval ${name} averages ${e.mean} vs ${l.mean} live`);
    }
    agents.push({ agent, candidate: cand, live, worse });
  }
  return { status: agents.some((a) => a.worse.length) ? "blocked" : "passed", agents };
}

const pctText = (x) => (x == null ? "-" : `${Math.round(x * 100)}%`);

/**
 * Settle every gate whose replays have all finished. Safe to call any number of times: the verdict is
 * written by one conditional UPDATE from 'replaying', and promotion only moves production off the version
 * the gate compared against, so a person who promoted something else meanwhile is not overridden.
 */
export async function settleGates(env, only = null) {
  const open = (await env.DB.prepare(`SELECT id, project, gate FROM versions WHERE gate LIKE '%"status":"replaying"%' ${only ? "AND id = ?" : ""}`)
    .bind(...(only ? [only] : [])).all()).results;
  for (const v of open) {
    const runs = (await env.DB.prepare("SELECT agent, version, status, output, judge FROM runs WHERE gate = ?").bind(v.id).all()).results;
    if (runs.some((r) => ["queued", "running"].includes(r.status))) continue;
    const gate = JSON.parse(v.gate);
    // The judge's answers count only when tidegate.json asks ("judge": {"gate": true}).
    const outputOf = (r) => {
      const out = r.output == null ? null : JSON.parse(r.output);
      return gate.judge ? withJudge(out, JSON.parse(r.judge ?? "null")) : out;
    };
    const verdict = { ...gate, ...judgeGate(runs.map((r) => ({ ...r, output: outputOf(r) })), v.id, gate.tolerance ?? 0) };
    const won = await env.DB.prepare("UPDATE versions SET gate = ? WHERE id = ? AND gate = ?").bind(JSON.stringify(verdict), v.id, v.gate).run();
    if (won.meta.changes && verdict.status === "passed") {
      await env.DB.prepare("UPDATE projects SET production = ? WHERE name = ? AND production = ?").bind(v.id, v.project, gate.against).run();
    }
  }
}

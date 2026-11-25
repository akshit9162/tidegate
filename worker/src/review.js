// A person's decision on a run that waits for review. Each decision is one conditional UPDATE from
// 'waiting', so a double click or a retried request queues nothing twice.
//   approve: runs the agent's "then" agent (if any) with the reviewed output, your note and its files
//   correct: you write the output the agent should have given; it is kept as a labelled example and
//            "then" runs with your output instead of the agent's
//   revise:  reruns the same agent with its original input plus your note, the previous output and files
//   reject:  records your note; nothing runs
// With review.when "flagged", only runs that something flags wait; the rest are approved automatically
// (review 'auto') and their "then" agent runs at once.
import { withJudge } from "./loop.js";
import { queueRun } from "./runner.js";
import { HttpError, now } from "./util.js";
import { versionMeta } from "./versions.js";

export const DECISIONS = { approve: "approved", correct: "corrected", revise: "revised", reject: "rejected" };
const MAX_NOTE = 4000;
const MAX_CORRECTED = 256 * 1024;

/** Why a finished run needs a person. Empty means nothing flagged it. */
export function flagRun({ output, problems = [], trigger, minConfidence = 0.7, judgeError = null }) {
  const flags = [];
  if (judgeError) flags.push(`the judge could not answer: ${judgeError}`.slice(0, 200));
  const o = output && typeof output === "object" && !Array.isArray(output) ? output : {};
  if (o.review === true) flags.push("the agent asked for review");
  if (trigger === "review") flags.push("a revision you asked for");
  if (typeof o.confidence === "number" && o.confidence < minConfidence) flags.push(`confidence ${o.confidence} is below ${minConfidence}`);
  for (const [name, v] of Object.entries(o.evals && typeof o.evals === "object" ? o.evals : {})) {
    if (v === false || (v && typeof v === "object" && v.pass === false)) flags.push(`eval ${name} failed`);
  }
  if (problems.length) flags.push(`errors in the log: ${problems[0]}`.slice(0, 200));
  if (output == null) flags.push("the agent wrote no output");
  return flags;
}

/** The review state a finished run starts in, and why. */
export function reviewState(agent, run, status, output, problems, judge = null) {
  if (status !== "ok" || !agent?.review || run.trigger === "replay" || output?.review === false) return { review: null, flags: [] };
  const flags = flagRun({ output: withJudge(output, judge), problems, trigger: run.trigger, minConfidence: agent.review.min_confidence, judgeError: judge?.error ?? null });
  return { review: agent.review.when === "flagged" && !flags.length ? "auto" : "waiting", flags };
}

async function liveAgents(env, run) {
  const prod = (await env.DB.prepare("SELECT production FROM projects WHERE name = ?").bind(run.project).first())?.production;
  const version = prod ?? run.version;
  return { version, agents: (await versionMeta(env, version)).config.agents };
}

/** Queue the "then" agent of an approved, corrected or auto-approved run. Returns the new run id or null. */
export async function runThen(env, run, { note = "", output, corrected = false }) {
  const { version, agents } = await liveAgents(env, run);
  const then = agents.find((a) => a.name === run.agent)?.review?.then;
  if (!then || !agents.some((a) => a.name === then)) return null;
  const next = await queueRun(env, { project: run.project, agent: then, version, trigger: "review", parent: run.id, inputFiles: JSON.parse(run.files ?? "null"),
    input: { approved: run.id, note, output, ...(corrected ? { corrected: true } : {}) } });
  await env.DB.prepare("UPDATE runs SET next_run = ? WHERE id = ?").bind(next, run.id).run();
  return next;
}

export async function decide(env, run, decision, note = "", corrected = undefined) {
  const verdict = DECISIONS[decision];
  if (!verdict) throw new HttpError(400, "decision is approve, correct, revise or reject");
  note = String(note ?? "").slice(0, MAX_NOTE);
  if (decision === "revise" && !note.trim()) throw new HttpError(400, "say what to change; the note is the agent's instructions for the next draft");
  let fixed = null;
  if (decision === "correct") {
    if (corrected === undefined) throw new HttpError(400, 'correct needs "output": the output the agent should have given');
    fixed = JSON.stringify(corrected);
    if (fixed.length > MAX_CORRECTED) throw new HttpError(413, "the corrected output is over 256 KB");
  }
  const taken = await env.DB.prepare("UPDATE runs SET review = ?, review_note = ?, reviewed_at = ?, corrected = ? WHERE id = ? AND review = 'waiting'")
    .bind(verdict, note, now(), fixed, run.id).run();
  if (!taken.meta.changes) {
    const cur = await env.DB.prepare("SELECT review FROM runs WHERE id = ?").bind(run.id).first();
    throw new HttpError(409, cur.review ? `run ${run.id} was already ${cur.review}` : `run ${run.id} is not waiting for review`);
  }

  const output = run.output == null ? null : JSON.parse(run.output);
  let next = null;
  if (decision === "approve") next = await runThen(env, run, { note, output });
  else if (decision === "correct") next = await runThen(env, run, { note, output: corrected, corrected: true });
  else if (decision === "revise") {
    const { version, agents } = await liveAgents(env, run);
    if (agents.some((a) => a.name === run.agent)) {
      const original = run.input == null ? null : JSON.parse(run.input);
      const base = original && typeof original === "object" && !Array.isArray(original) ? original : { input: original };
      next = await queueRun(env, { project: run.project, agent: run.agent, version, trigger: "review", parent: run.id, inputFiles: JSON.parse(run.files ?? "null"),
        input: { ...base, revise: { run: run.id, note, output } } });
      await env.DB.prepare("UPDATE runs SET next_run = ? WHERE id = ?").bind(next, run.id).run();
    }
  }
  return { run: run.id, review: verdict, note, next_run: next };
}

// The input a run was first given, without the revision Tidegate added, so an example reads like a real request.
function originalInput(text) {
  const v = text == null ? null : JSON.parse(text);
  if (!v || typeof v !== "object" || Array.isArray(v) || !("revise" in v)) return v;
  const { revise: _revise, ...rest } = v;
  return Object.keys(rest).length === 1 && "input" in rest ? rest.input : rest;
}

/**
 * Reviewed runs of an agent, newest first, for $TIDEGATE_EXAMPLES:
 *   good:  outputs a person approved, or wrote themselves (corrected wins over the agent's draft)
 *   avoid: outputs a person rejected, with their note
 * The run's own input is left out, so a replay cannot copy the answer it is being measured on.
 */
export async function examplesFor(env, project, agent, n, currentInput) {
  if (!n) return null;
  const rows = (await env.DB.prepare(
    "SELECT id, input, output, corrected, review, review_note FROM runs WHERE project = ? AND agent = ? AND review IN ('approved', 'corrected', 'rejected') ORDER BY reviewed_at DESC, id DESC LIMIT 60",
  ).bind(project, agent).all()).results;
  const skip = currentInput == null ? null : JSON.stringify(originalInput(currentInput));
  const good = [], avoid = [];
  for (const r of rows) {
    const input = originalInput(r.input);
    if (skip !== null && JSON.stringify(input) === skip) continue;
    if (r.review === "rejected") {
      if (avoid.length < Math.ceil(n / 2)) avoid.push({ run: r.id, input, output: JSON.parse(r.output ?? "null"), note: r.review_note || "" });
    } else if (good.length < n) {
      good.push({ run: r.id, input, output: JSON.parse(r.corrected ?? r.output ?? "null"), source: r.review, note: r.review_note || "" });
    }
  }
  return { good, avoid };
}

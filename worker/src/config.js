// tidegate.json: the agents in a project, how each is triggered, and which files they keep between runs.
// Parsed once at the boundary; everything after trusts the returned shape.

const UNITS = { s: 1, m: 60, h: 3600, d: 86400 };
export const MIN_EVERY = 15 * 60;
export const MAX_TIMEOUT = 60 * 60;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SECRET = /^[A-Z][A-Z0-9_]{0,63}$/;

export function seconds(text) {
  const m = /^(\d+)\s*([smhd])$/.exec(String(text).trim());
  return m ? Number(m[1]) * UNITS[m[2]] : null;
}

function cleanPath(p) {
  const s = String(p).replace(/^\.\//, "");
  return s && !s.startsWith("/") && !s.split("/").includes("..") ? s : null;
}

/**
 * Returns { config, problems }; config is usable only when problems is empty.
 * An agent: { name, run, description, every (seconds or null), http, public, timeout, secrets, review, examples, trace }.
 * review is null, or { then, when, min_confidence }: an ok run waits for a person ("always"), or only when
 *   something flags it ("flagged"; the rest are approved automatically), and approving runs agent `then`.
 * examples: how many reviewed runs to hand the agent in $TIDEGATE_EXAMPLES (0 turns it off).
 * trace: whether the agent's model calls go through the gateway and are recorded.
 * The project: { agents, state, checks, gate, image }. gate is null or { replay, agents, tolerance }.
 */
export function parseConfig(text) {
  if (text == null) return { config: null, problems: ['tidegate.json: missing; it names your agents, e.g. {"agents": [{"name": "triage", "run": "python agent.py"}]}'] };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { config: null, problems: [`tidegate.json: not valid JSON (${e.message})`] };
  }
  const problems = [];
  const agents = [];
  if (!Array.isArray(raw.agents) || !raw.agents.length) problems.push('tidegate.json: "agents" must list at least one agent');
  for (const [i, a] of (raw.agents ?? []).entries()) {
    const where = `tidegate.json: agents[${i}]`;
    if (!NAME.test(a.name ?? "")) problems.push(`${where}: "name" must be lowercase letters, digits and dashes`);
    if (!a.run) problems.push(`${where}: "run" is the command that starts the agent, e.g. "python agent.py"`);
    let every = null;
    if (a.every != null) {
      every = seconds(a.every);
      if (every == null) problems.push(`${where}: "every" must look like "15m", "3h" or "1d"`);
      else if (every < MIN_EVERY) problems.push(`${where}: "every" is ${a.every}; the shortest is 15m`);
    }
    const timeout = seconds(a.timeout ?? "15m");
    if (timeout == null || timeout > MAX_TIMEOUT) problems.push(`${where}: "timeout" must be 60m or less`);
    const secrets = a.secrets ?? [];
    for (const s of secrets) if (!SECRET.test(s)) problems.push(`${where}: secret name ${JSON.stringify(s)} must be UPPER_CASE`);
    let review = null;
    if (a.review === true) review = { then: null, when: "always", min_confidence: 0.7 };
    else if (a.review && typeof a.review === "object") {
      review = { then: a.review.then ?? null, when: a.review.when ?? "always", min_confidence: a.review.min_confidence ?? 0.7 };
      if (!["always", "flagged"].includes(review.when)) problems.push(`${where}: review "when" is "always" or "flagged"`);
      if (typeof review.min_confidence !== "number" || review.min_confidence < 0 || review.min_confidence > 1) problems.push(`${where}: review "min_confidence" is a number from 0 to 1`);
    } else if (a.review != null && a.review !== false) problems.push(`${where}: "review" is true, or {"then": "<agent to run once approved>", "when": "always" | "flagged"}`);
    const examples = a.examples ?? 5;
    if (!Number.isInteger(examples) || examples < 0 || examples > 20) problems.push(`${where}: "examples" is a whole number from 0 to 20`);
    agents.push({ name: a.name, run: a.run, description: String(a.description ?? ""), every, http: a.http !== false, public: a.public === true, timeout, secrets, review,
      examples, trace: a.trace !== false });
  }
  if (new Set(agents.map((a) => a.name)).size !== agents.length) problems.push("tidegate.json: agent names must be unique");
  for (const a of agents) {
    const then = a.review?.then;
    if (then == null) continue;
    if (then === a.name) problems.push(`tidegate.json: agent "${a.name}" cannot run itself once approved; "Revise" already reruns it with your note`);
    else if (!agents.some((b) => b.name === then)) problems.push(`tidegate.json: agent "${a.name}" runs "${then}" once approved, but there is no agent "${then}"`);
  }

  const state = [];
  for (const s of raw.state ?? []) {
    const p = cleanPath(s);
    if (p) state.push(p);
    else problems.push(`tidegate.json: state path ${JSON.stringify(s)} must be inside the project`);
  }
  let gate = null;
  if (raw.gate === true) raw.gate = {};
  if (raw.gate && typeof raw.gate === "object") {
    gate = { replay: raw.gate.replay ?? 10, agents: raw.gate.agents ?? null, tolerance: raw.gate.tolerance ?? 0 };
    if (!Number.isInteger(gate.replay) || gate.replay < 1 || gate.replay > 50) problems.push('tidegate.json: gate "replay" is how many past inputs to rerun, 1 to 50');
    if (typeof gate.tolerance !== "number" || gate.tolerance < 0 || gate.tolerance > 1) problems.push('tidegate.json: gate "tolerance" is a number from 0 to 1');
    for (const g of gate.agents ?? []) if (!agents.some((a) => a.name === g)) problems.push(`tidegate.json: gate names agent "${g}", which is not in "agents"`);
  } else if (raw.gate != null && raw.gate !== false) problems.push('tidegate.json: "gate" is true, or {"replay": 10, "agents": [...], "tolerance": 0}');
  const image = raw.image == null ? null : String(raw.image);
  const judge = raw.judge == null ? null : parseJudge(raw.judge, agents, problems);
  return { config: { agents, state, checks: (raw.checks ?? []).map(String), gate, image, judge }, problems };
}

export const JUDGE_PROVIDERS = { jev: "jev-latest", gemini: "gemini-decision-1", openai: null };

/**
 * tidegate.json "judge": a decision model that answers typed questions about each finished run.
 * { provider: jev | gemini | openai (any OpenAI-compatible server), model, url, key (a secret name),
 *   agents (default all), gate (judge answers count in the deploy gate; default false), questions }.
 * A question is TypeSafe's and Google's shape, plus when it passes:
 *   noul:   { instructions, pass: "yes" | "no" (the good answer, default "yes"), threshold (default 0.5) }
 *   choice: { instructions, criteria: {option: description}, pass: [good options] (none: not graded) }
 *   score:  { instructions, criteria: [lowest .. highest level], min (lowest passing level; none: not graded) }
 */
function parseJudge(j, agents, problems) {
  const where = 'tidegate.json: "judge"';
  if (typeof j !== "object" || Array.isArray(j)) {
    problems.push(`${where} is an object: {"provider": "jev" | "gemini" | "openai", "questions": {...}}`);
    return null;
  }
  const provider = j.provider;
  if (!(provider in JUDGE_PROVIDERS)) problems.push(`${where}: "provider" is jev, gemini or openai (any OpenAI-compatible server, such as vLLM or Ollama)`);
  const model = j.model ?? JUDGE_PROVIDERS[provider] ?? null;
  if (!model) problems.push(`${where}: "model" names the model to ask`);
  if (provider === "openai" && !j.url) problems.push(`${where}: "url" is the OpenAI-compatible server's base URL, e.g. http://localhost:11434/v1`);
  if (j.key != null && !/^[A-Z][A-Z0-9_]{0,63}$/.test(j.key)) problems.push(`${where}: "key" is the name of a secret holding the API key, UPPER_CASE`);
  for (const a of j.agents ?? []) if (!agents.some((x) => x.name === a)) problems.push(`${where} names agent "${a}", which is not in "agents"`);
  const questions = {};
  const entries = Object.entries(j.questions ?? {});
  if (!entries.length) problems.push(`${where}: "questions" needs at least one question`);
  for (const [name, q] of entries) {
    const at = `${where}: question "${name}"`;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) problems.push(`${at}: names are letters, digits, - and _`);
    if (!q || !q.instructions) { problems.push(`${at}: "instructions" is the question to ask`); continue; }
    if (q.type === "noul") {
      if (![undefined, "yes", "no"].includes(q.pass)) problems.push(`${at}: "pass" is "yes" or "no", the good answer`);
      const threshold = q.threshold ?? 0.5;
      if (typeof threshold !== "number" || threshold <= 0 || threshold >= 1) problems.push(`${at}: "threshold" is between 0 and 1`);
      questions[name] = { type: "noul", instructions: q.instructions, pass: q.pass ?? "yes", threshold };
    } else if (q.type === "choice") {
      const options = q.criteria && typeof q.criteria === "object" && !Array.isArray(q.criteria) ? Object.keys(q.criteria) : [];
      if (options.length < 2) problems.push(`${at}: "criteria" maps at least two options to descriptions`);
      for (const o of q.pass ?? []) if (!options.includes(o)) problems.push(`${at}: "pass" names "${o}", which is not an option`);
      questions[name] = { type: "choice", instructions: q.instructions, criteria: q.criteria, pass: q.pass ?? null, threshold: q.threshold ?? 0.5 };
    } else if (q.type === "score") {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10) problems.push(`${at}: "criteria" lists 2 to 10 levels, lowest first`);
      if (q.min != null && !(Number.isInteger(q.min) && q.min >= 0 && q.min < (q.criteria?.length ?? 0))) problems.push(`${at}: "min" is the index of the lowest passing level`);
      questions[name] = { type: "score", instructions: q.instructions, criteria: q.criteria, min: q.min ?? null };
    } else problems.push(`${at}: "type" is noul, choice or score`);
  }
  return { provider, model, url: j.url ?? null, key: j.key ?? null, agents: j.agents ?? null, gate: j.gate === true, questions };
}

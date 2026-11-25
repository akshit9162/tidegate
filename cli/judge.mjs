// The judge: a decision model answers tidegate.json's typed questions about a finished run (its input
// and output), and each answer becomes an eval named judge.<question>. Providers:
//   jev     TypeSafe's System One API         POST {state, model, questions}        Authorization: Bearer
//   gemini  Google's Decisions API            POST {model, input, questions}        x-goog-api-key
//   openai  any OpenAI-compatible server (vLLM, Ollama, Together, Groq, OpenAI): one call per question
//           asking for a single letter, with probabilities read from the token logprobs
// Questions use TypeSafe's and Google's shared shape (noul / choice / score with instructions and criteria),
// so jev and gemini receive them unchanged.

const ENDPOINTS = { jev: "https://api.typesafe.ai/v1/systemone", gemini: "https://generativelanguage.googleapis.com/v1beta/decisions" };
const MAX_STATE = 100_000;

export function runState(input, output) {
  const text = JSON.stringify({ input, output }, null, 1);
  return text.length > MAX_STATE ? `${text.slice(0, MAX_STATE)}\n[truncated]` : text;
}

const wire = (q) => ({ type: q.type, instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) });

/** Probability that the answer is good (noul, choice) or the score itself, and whether it passes. */
export function grade(q, a) {
  if (q.type === "noul") {
    const good = q.pass === "no" ? 1 - a.noul : a.noul;
    return { good: round(good), pass: good >= q.threshold };
  }
  if (q.type === "choice") {
    if (!q.pass) return { good: null, pass: null };
    const good = q.pass.reduce((s, o) => s + (a.probabilities?.[o] ?? (a.choice === o ? 1 : 0)), 0);
    return { good: round(good), pass: good >= q.threshold };
  }
  return { good: a.score, pass: q.min == null ? null : a.score >= q.min };
}

const round = (x) => Math.round(x * 1000) / 1000;

// ---- open-weight and other OpenAI-compatible servers ----

const LETTERS = "ABCDEFGHIJ";

function options(q) {
  if (q.type === "noul") return [["yes", "Yes"], ["no", "No"]];
  if (q.type === "choice") return Object.entries(q.criteria).map(([k, d]) => [k, d ? `${k}: ${typeof d === "string" ? d : JSON.stringify(d)}` : k]);
  return q.criteria.map((d, i) => [String(i), typeof d === "string" ? d : JSON.stringify(d)]);
}

/** Probabilities over the options from the first token's top logprobs, or from the text when a server has none. */
export function letterProbabilities(choice, keys) {
  const scores = new Map();
  for (const t of choice?.logprobs?.content?.[0]?.top_logprobs ?? []) {
    const letter = String(t.token).trim().toUpperCase().slice(0, 1);
    const i = LETTERS.indexOf(letter);
    if (i >= 0 && i < keys.length) scores.set(keys[i], (scores.get(keys[i]) ?? 0) + Math.exp(t.logprob));
  }
  if (!scores.size) {
    const i = LETTERS.indexOf(String(choice?.message?.content ?? "").trim().toUpperCase().slice(0, 1));
    if (i >= 0 && i < keys.length) scores.set(keys[i], 1);
  }
  const total = [...scores.values()].reduce((a, b) => a + b, 0);
  if (!total) throw new Error("the judge's reply named no option");
  return Object.fromEntries(keys.map((k) => [k, round((scores.get(k) ?? 0) / total)]));
}

function answerFromProbabilities(q, probs) {
  const top = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
  if (q.type === "noul") return { type: "noul", noul: probs.yes, confidence: top[1] };
  if (q.type === "choice") return { type: "choice", choice: top[0], probabilities: probs, confidence: top[1] };
  const score = round(Object.entries(probs).reduce((s, [k, p]) => s + Number(k) * p, 0));
  return { type: "score", score, probabilities: probs, confidence: top[1] };
}

async function askOpenAI(judge, key, state, fetchFn) {
  const answers = {};
  const usage = { input_tokens: 0, output_tokens: 0 };
  for (const [name, q] of Object.entries(judge.questions)) {
    const opts = options(q);
    const prompt = `An AI agent finished a run. Its input and output:\n${state}\n\nQuestion: ${typeof q.instructions === "string" ? q.instructions : JSON.stringify(q.instructions)}\n` +
      opts.map(([, label], i) => `${LETTERS[i]}. ${label}`).join("\n") + `\n\nReply with only the letter of the best answer (${LETTERS.slice(0, opts.length).split("").join(", ")}).`;
    const res = await fetchFn(`${judge.url.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: judge.model, messages: [{ role: "user", content: prompt }], max_tokens: 1, temperature: 0, logprobs: true, top_logprobs: 20 }),
    });
    if (!res.ok) throw new Error(`the judge returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    usage.input_tokens += body.usage?.prompt_tokens ?? 0;
    usage.output_tokens += body.usage?.completion_tokens ?? 0;
    answers[name] = answerFromProbabilities(q, letterProbabilities(body.choices?.[0], opts.map(([k]) => k)));
  }
  return { answers, usage };
}

// ---- hosted decision models ----

async function askDecisionApi(judge, key, state, fetchFn) {
  const questions = Object.fromEntries(Object.entries(judge.questions).map(([n, q]) => [n, wire(q)]));
  const gemini = judge.provider === "gemini";
  const res = await fetchFn(judge.url ?? ENDPOINTS[judge.provider], {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? (gemini ? { "x-goog-api-key": key } : { authorization: `Bearer ${key}` }) : {}) },
    body: JSON.stringify(gemini ? { model: judge.model, input: state, questions } : { model: judge.model, state, questions }),
  });
  if (!res.ok) throw new Error(`the judge returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const u = body.usage ?? {};
  return { model: body.model ?? null, answers: body.answers ?? {}, usage: { input_tokens: u.input_tokens ?? u.total_input_tokens ?? 0, output_tokens: u.output_tokens ?? u.total_output_tokens ?? 0 } };
}

/**
 * Ask the judge about one run. Returns { provider, model, ms, usage, results: {question: {answer, good, pass}} }.
 * Throws on a provider error; the caller records it, and the run is flagged for a person.
 */
export async function judgeRun(judge, key, state, fetchFn = fetch) {
  const started = Date.now();
  const { answers, usage, model } = judge.provider === "openai" ? await askOpenAI(judge, key, state, fetchFn) : await askDecisionApi(judge, key, state, fetchFn);
  const results = {};
  for (const [name, q] of Object.entries(judge.questions)) {
    const a = answers[name];
    if (!a) throw new Error(`the judge did not answer "${name}"`);
    results[name] = { answer: a, ...grade(q, a) };
  }
  // The model that answered, not the alias asked for: "jev-latest" changes underneath, and agreement is per model.
  return { provider: judge.provider, model: model ?? judge.model, ms: Date.now() - started, usage, results };
}

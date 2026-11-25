# Tidegate: spec

Status: built and tested locally, not deployed. 2026-11-25.

**Tidegate is the Vercel for AI agents that keep getting better, and the software factory for one
person.** You deploy a folder of agents; every run is recorded; you approve, revise or reject what
they produce; and those decisions, with the evals the agents report, become a scorecard per version
and the material for the next version. An improver proposes changes, Tidegate replays real inputs on the
candidate, and you promote it only if it scores at least as well. No GitHub, Dockerfile or server setup.

## Two pillars (2026-11-25)
1. **Push any agent, get an endpoint and traces, with zero instrumentation.** Any language or framework
   (raw SDKs, PydanticAI, CrewAI, LangGraph, a Dockerfile): `tidegate deploy` or `git push tidegate main`
   gives a live endpoint, and every model call is recorded without a decorator, an SDK or OpenTelemetry.
   LangSmith, Langfuse and Braintrust are framework-agnostic too, so the claim is "zero instrumentation
   plus hosting", not "framework-agnostic".
2. **The loop runs out of the box.** Only risky runs reach a person; a person's fix becomes the agent's
   example and a labelled case; a version that does worse on real inputs does not go live.

The measure of both: the share of runs approved first time goes up, and review minutes per run go down.

The bet: running agents is a commodity (Trigger.dev, Modal, Inngest and Anthropic's Managed Agents all
do it). What nobody owns is the loop from "this draft was wrong" to "the next version is provably
better", run by one person whose attention is the scarce resource (the Warp "software factory" talk
and Armin Ronacher's "workshop before the factory"). Review decisions are the missing signal: most
agents have no ground truth, but every approve, revise and reject is a labelled example.

## The loop
| Step | What Tidegate does | Status |
|---|---|---|
| Deploy | Agent setup as code; versions kept forever; rollback and promote are one pointer | Built |
| Record | Every run's input, output, log, files, problems, and every model call it made (gateway) | Built |
| Review | `"review": {"then", "when"}`: only flagged runs wait; approve, correct (edit the output), revise with a note, or reject | Built |
| Measure | Scorecard per version and agent: ok rate, approval rate, approved first time, auto-approved, tokens, evals | Built |
| Improve | Corrected and approved outputs reach later runs in `$TIDEGATE_EXAMPLES`; an improver agent proposes changes | Built (examples built in; improver per project, e.g. Job Scout's `improve`) |
| Prove | `"gate"`: every deploy replays real inputs on the candidate and the live version, and goes live only if no worse | Built |
| Factory | Coding agents (Claude Code on a runner) as workers: issue or failure pattern, PR, checks, review, merge | Next |

The first factory is Job Scout (`job-watch/tailor`): tailor a resume to a job in the person's exact
LaTeX format, gate it on format and facts, review it, record it, and improve the tailoring rules from
the review notes.

## The problem
Vercel made deploying a website one command. Deploying an agent still means putting these together:
- something that runs for minutes, not seconds. Vercel and Netlify functions stop after seconds
  to a few minutes, and an agent that researches, scrapes or works through a queue runs longer;
- a scheduler: GitHub Actions cron, or a server with crontab;
- an endpoint so other systems can call it, plus a queue so a slow agent does not hold the caller;
- secrets that the agent can read but that are never committed;
- somewhere to keep files between runs. Job Scout commits `seen.json` back to its repo;
- a record of what each run did, and a way to notice when the same thing keeps failing.

Render, Railway and Fly can host this, but you write the Dockerfile and the queue yourself.
Hosted agent builders (Dify and similar) run their own agent format, not your code.

## Who it's for
1. Developers who wrote an agent in Python or Node, with any SDK or framework, and want it running.
2. AI coding agents (Claude Code and others) deploying what they just built, through MCP.
3. Small teams running agents on a schedule: triage, digests, watchers, research jobs.

## The agent contract
A project is a folder with `tidegate.json`:
```json
{
  "agents": [
    { "name": "triage", "run": "python3 triage.py", "description": "Sort a support ticket.",
      "timeout": "5m", "secrets": ["ANTHROPIC_API_KEY"] },
    { "name": "digest", "run": "python3 digest.py", "every": "1d", "http": false }
  ],
  "state": ["tickets.json"],
  "checks": ["python3 -m unittest discover -s tests -q"]
}
```
- An agent is any command. Tidegate installs `requirements.txt` or `package.json` dependencies first. A
  project with a `Dockerfile` runs inside its own image (with `tidegate runner --isolate docker`).
- **Examples:** `$TIDEGATE_EXAMPLES` is a JSON file `{good: [{input, output, source, note}], avoid: [{input,
  output, note}]}`: the agent's recent outputs a person approved or corrected (a correction wins over the
  draft), and those they rejected with their note. The run's own input is left out, so a replay cannot copy
  its answer. `"examples": N` per agent (default 5, 0 turns it off). Auto-approved runs are not examples:
  only a person's decision is a label.
- **Model calls:** `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` point at Tidegate's gateway (see Traces).
  `"trace": false` per agent turns it off; a secret of the same name wins.
- **Signals the agent can give:** `confidence` (0 to 1), `evals`, and `review` (true to ask for a person,
  false for nothing to review) in its output.
- **Input and output are files**, so any language works: the run's JSON input is at
  `$TIDEGATE_INPUT`, and the agent writes its JSON output to `$TIDEGATE_OUTPUT`. Logs are stdout and
  stderr.
- **Triggers:** HTTP (on by default), `every` (15m or longer), or by hand with `tidegate invoke`.
- **State:** files listed in `state` are restored before each run and saved after it, even after
  a failed run.
- **Secrets:** the agent receives only the secrets it lists, and never the runner's own credentials.
- **Limits:** timeout up to 60 minutes; output up to 256 KB; input up to 1 MB.

## Calling an agent
- `POST https://<project>.tidegate.dev/<agent>` with a JSON body starts a run and returns
  `{run, status, status_url}` (202).
- `?wait=N` holds the request up to 30 seconds and returns the output when the run finishes in
  time (200).
- `GET /runs/<id>` returns status and output. `GET /` lists the agents.
- Agents need the project token unless `"public": true`.
- The same endpoints are served at `https://tidegate.dev/p/<project>/...` for clients that cannot
  use subdomains, and at `<project>--<version>` for one version.

## What one deploy does
1. Uploads only files whose hash is new, and stores the version unchanged forever.
2. Checks it in the Worker: tidegate.json is valid, each agent's entry file was uploaded, and no
   file contains an API key or private key. Errors name the file and line.
3. Runs tidegate.json `checks` (the project's tests) on a runner.
4. Points production at the version once checks pass, or, with `"gate"`, once its replays do no worse than the live version. Rollback points production back.

## A person in the loop
Most agents that act in the world need someone to say yes first. An agent with
`"review": {"then": "<agent>"}` in tidegate.json stops after each successful run:
- the run waits, listed first on the runs page ("Needs you") and in `tidegate reviews`, with its
  output's `title` and `summary` and any files it wrote to `$TIDEGATE_FILES`, previewed inline;
- **Approve** runs the `then` agent with `{approved, note, output}` and the files in
  `$TIDEGATE_INPUT_FILES`;
- **Revise** reruns the same agent with its original input plus `revise: {note, output}` and the
  previous files, so the next draft starts from the last one;
- **Reject** records the note and runs nothing.
- **Correct** replaces the output with one the person writes (`tidegate correct RUN --output JSON`, or
  "Edit the output yourself" on the runs page). It is kept as the run's labelled output, handed to later
  runs as an example, and the `then` agent runs with it (`corrected: true`).

**Only what is flagged.** With `"review": {"when": "flagged", "min_confidence": 0.7}`, a run waits only
when something flags it: the agent asked (`review: true`), its `confidence` is below the threshold, an
eval failed, the log has errors, it wrote no output, or it is a revision the person asked for. The rest
are approved automatically (review `auto`) and the `then` agent runs at once. The flags are shown on the
review card, so the person sees why. `"when": "always"` (the default) keeps every run waiting.

Each decision is one conditional UPDATE from `waiting`, so a double click queues nothing twice.
Nothing holds a runner while it waits. There is deliberately no MCP tool to approve, so a coding
agent cannot sign off its own work.

## Seeing what agents do
Records every run: trigger, input, output, log, exit code, time, and the error lines in the log.
The runs page and `tidegate runs` show:
- **Needs you**, at the top: a failed deploy, missing secrets, agents whose last run failed, and
  repeated problems. The goal is that a person reads three lines, not a log (Armin Ronacher's
  point that human attention is the limit).
- what is running now, with a live log tail;
- each agent's recent runs as a strip of green and red;
- **repeated problems:** the same error line across runs, with numbers blanked so "HTTP Error 429"
  from 3 runs groups into one line.

## Traces without instrumentation
The runner points each agent's `ANTHROPIC_BASE_URL` at `<tidegate>/gw/<run token>/anthropic` and
`OPENAI_BASE_URL` at `.../openai/v1`. The official SDKs read these variables, so an agent's model calls go
through Tidegate with no code change. The gateway forwards each call unchanged with the agent's own key,
streams the response back as it arrives, and records model, status, input and output tokens and time per
call, with request and response bodies in R2 (keys are forwarded, never stored). The token is minted per
run at claim and works only while that run is running. `tidegate trace RUN` lists the calls; the review card
shows calls and tokens; the scorecard shows median tokens per run.

## The deploy gate
With `"gate": {"replay": 10, "agents": [...], "tolerance": 0}` in tidegate.json, a deploy that passes its
checks is not promoted at once. Tidegate reruns each gated agent's last `replay` real inputs on the candidate
and on the live version side by side, then compares them per agent: ok rate, and each eval's pass rate and
mean. The candidate goes live only if none is worse by more than `tolerance`. Otherwise it stays ready,
the live version stays, and `tidegate deploy` (and `git push`) report what got worse:

    Blocked: worse than the live version on 10 real inputs. The live version stays.
      draft: short 0% (live 100%)
        worse: eval short passes 0% vs 100% live
      Ship it anyway: tidegate promote v2

`tidegate promote` still overrides. The verdict is written by one conditional UPDATE, and promotion only
moves production off the version the gate compared against, so a manual promote in the meantime wins.
Gate replays are kept out of the scorecard. Replays are never reviewed and never trigger `then` agents;
an agent that acts in the world itself should check `TIDEGATE_TRIGGER=replay`.

## Isolation
`tidegate runner --isolate docker` runs every check and agent run in a container: the project's own
`Dockerfile` if it has one, else tidegate.json `"image"` or a Python or Node base with the project's
dependencies installed, built once per content hash. Each run gets only its folder at `/work`, 1 GB of
memory, one CPU, a process limit and no new privileges. Secrets reach it through an env file outside the
folder, never the command line. Agents reach Tidegate at `host.docker.internal`.

## The judge
A decision model answers typed questions about every finished run (its input and output) and returns
probabilities, not prose. The runner asks it after the run, with an API key the agent never sees.

```json
"judge": {
  "provider": "jev",
  "key": "JUDGE_KEY",
  "agents": ["reply"],
  "gate": false,
  "questions": {
    "rude": { "type": "noul", "instructions": "Is the reply rude to the customer?", "pass": "no" },
    "team": { "type": "choice", "instructions": "Which team should own this?",
              "criteria": { "billing": "money", "tech": "bugs", "spam": "junk" }, "pass": ["billing", "tech"] },
    "quality": { "type": "score", "instructions": "How well does it answer?",
                 "criteria": ["wrong", "partly right", "fully right"], "min": 1 }
  }
}
```
- **Questions** use the shape TypeSafe and Google share: `noul` (yes/no), `choice` (options with
  descriptions) and `score` (ordered levels). `pass` says which answer is good; a question without one
  is recorded but not graded.
- **Providers.** `jev` (TypeSafe, `POST api.typesafe.ai/v1/systemone`, `{state, model, questions}`,
  model `jev-latest`), `gemini` (Google, `POST generativelanguage.googleapis.com/v1beta/decisions`,
  `{model, input, questions}`, model `gemini-decision-1`), and `openai`: any OpenAI-compatible server with
  a `url`, which is how open-weight models run (vLLM, Ollama, Together, Groq). For those Tidegate asks for
  one letter per question and reads the probabilities from the token logprobs.
- **What the answers do.** Each graded answer becomes an eval named `judge.<question>`, so a failed one
  flags the run for review, the scorecard shows its pass rate, and, with `"gate": true`, the deploy gate
  compares it too. A judge that errors flags the run, so a broken judge never waves a run through.
- **Whether to trust it.** The scorecard's "judge agrees" column is how often the judge's verdict (no
  graded answer failed) matched the person's (approved), over runs both decided. Turn on `"gate": true`
  once it is high over enough runs.

Provider landscape, November 2026 (prices from aggregators; verify before use):
- **Hosted decision models:** TypeSafe Jev (about $0.04 per million input tokens, output free;
  `POST api.typesafe.ai/v1/systemone`), Google Gemini Decision 1 (Decisions API, about $0.10 per
  million input, launched 2026-11-11, multimodal). Microsoft and OpenAI have announced their own.
- **Open-weight decision models**, served by the customer or on Tidegate's runners: JevK5 (Apache-2.0,
  Qwen3.5 4B/9B), Kev (0.8B to 27B, Jev-compatible API), Strands Decider (Gemma 4), or AnyJev, which
  reads answers from any open model's logits. Young projects with self-reported numbers.
- **Open-weight judges and guards** for specific rubrics: Atla Selene 1 Mini (8B), Prometheus 2,
  Patronus Glider and Flow Judge (about 3.8B); Qwen3Guard, Granite Guardian, Shieldstral and
  gpt-oss-safeguard for safety and injection checks.
Calibration varies: an independent evaluation found open Qwen choice probabilities about as well
calibrated as Jev's, Gemma overconfident, and open models weaker on yes/no. So the judge is calibrated on
the person's own review decisions (they are the labels) before its scores can block a deploy.

## How people deploy
| Path | How | Status |
|---|---|---|
| Command line | `tidegate deploy` in the folder | Built |
| Drag and drop | Drop a folder on tidegate.dev | Built |
| From an AI chat | MCP tools `deploy`, `invoke`, `status`, `runs` (`tidegate mcp`) | Built |
| API | `POST /api/deploys`, `PUT /api/blobs/<sha>`, `POST /api/versions/<id>/finalize` | Built |
| Git | `git remote add tidegate tidegate::<project>`, then `git push tidegate main`: the `git-remote-tidegate` helper deploys the pushed commit (committed files only), gated like any deploy | Built |
| Pull request previews | A deploy per pull request with its own `<project>--<version>` address | v1 |

## Architecture
| Part | Choice | Why |
|---|---|---|
| API, endpoints, pages | One Cloudflare Worker | Global, cheap, no servers |
| Files and versions | R2: blobs by sha256, one file list per version | Re-uploads skipped; rollback is a pointer |
| Metadata, runs, secrets, state | D1 | Runs need conditional updates; KV's eventual consistency would lose state writes |
| Scheduling | Cron Trigger each minute queues due runs; runners also ask | Works with or without Cloudflare cron |
| Running agents | `tidegate runner`: claims a queued run, builds the folder, installs dependencies, runs with a clean environment (in a container with `--isolate docker`), heartbeats every 15s, uploads log, state and output | Runs anywhere; a runner that dies is detected after 3 minutes |
| Model calls | The gateway route in the same Worker; calls in D1, bodies in R2 | No SDK in the agent; one place sees every call |
| Secrets | AES-GCM with a key held only by the Worker; decrypted only into the claim for that run | Not in files, not in logs |
| Auth | One token per project, created by its first deploy; a separate runner token | Simple; accounts come later |

A run moves queued → running → ok / failed / timeout. Each step is one conditional UPDATE, so two
runners never take the same run and a retried request changes nothing.

## Built in the MVP (2026-11-23)
- Everything marked Built above, plus versions, rollback, checks, secrets, state, schedules,
  timeouts, the runs page and terminal view.
- `examples/ticket-triage`: a two-agent project (HTTP triage, daily digest) with tests.
- `npm test`: 8 unit tests. `node test/e2e.mjs`: 11 end-to-end steps against a running Worker and
  runner. All pass locally.

## Built 2026-11-25: the two pillars
- `review.when: "flagged"`, auto-approval, the `correct` decision and the edit box on the runs page.
- `$TIDEGATE_EXAMPLES` from approved, corrected and rejected runs.
- The model-call gateway, `tidegate trace`, tokens on the review card and scorecard.
- The deploy gate.
- `tidegate runner --isolate docker` and `git push tidegate main`.
- The judge: Jev, Gemini Decision and any OpenAI-compatible (open-weight) server, as evals, flags and an
  opt-in gate input, with agreement against the person on the scorecard.
- `npm test`: 19 unit tests. `node test/e2e.mjs`: 20 steps with the plain runner, plus an isolation step
  with `E2E_ISOLATE=docker` and a Docker runner. All pass locally.

## Not built yet
- **Hosting it:** a Cloudflare account, the D1 database and R2 bucket, the domain and wildcard DNS.
  Needs a go-ahead, as it is a public deploy.
- **Hosted isolation:** `--isolate docker` isolates runs on a runner you operate. The hosted product needs
  runners on Cloudflare Containers or microVMs, with network egress rules, before public signups.
- **Accounts:** GitHub, Google or email sign-in instead of one token per project.
- **Durable runs:** an agent that suspends mid-run while waiting (for a webhook) and resumes later.
  Waiting for a person is covered by review, which splits the work into two runs.
- **Streaming output** over the endpoint, and **cancel**.

## Next: agents that improve with as little of a person as possible
The goal: deploy an agent once, and it gets better on its own, with every change proven on real inputs
before it goes live. A person steps in only when the judge is unsure or the loop stops finding gains.
Not "no humans": a person spends time only where their judgment matters, and reads results rather than
every run or diff. How much they still review is set by the stakes (`spot_check`, `open_pr`, `digest`).
Today the gate stops an agent getting worse, but every improvement still starts with a person: they
review flagged runs and they write the next version. These two features remove both.

### 1. The judge takes over review once it has earned it
```json
"review": { "when": "flagged", "then": "send", "judge_review": { "agreement": 0.95, "min_runs": 50 } }
```
- Per agent, the scorecard already measures how often the judge agrees with the person, over runs both
  decided. Once agreement is at least `agreement` over at least `min_runs` of the most recent such runs,
  the judge decides instead of the person: a run with no failed graded answer is approved (and `then`
  runs); a run with a failed answer is rejected, with the judge's answers as the note.
- The person still sees the runs the judge is unsure about: any graded answer whose probability is within
  `margin` (default 0.15) of its threshold, any run the judge errored on, and runs with low `confidence`.
- Judge review switches itself off when agreement on the person's spot checks falls below `agreement`: a
  sample (`spot_check`, default 5%) of the judge's decisions still goes to the person, and their decision
  counts toward agreement. Every judge decision is marked as such on the runs page and the scorecard.
- Judge decisions never feed `$TIDEGATE_EXAMPLES` as `good` or `avoid`; only the person's do, so the
  judge cannot train the agent on its own mistakes.

### 2. The improve loop
```json
"improve": { "agent": "reply", "every": "1d", "edit": ["prompt.md", "reply.py"], "model": "claude-opus-5-5",
             "min_new": 10, "max_tries": 3 }
```
- On a schedule, once the agent has at least `min_new` new failed, rejected or corrected runs since the
  last attempt, Tidegate builds a brief: the failures with their inputs and outputs, the person's notes
  and corrections, the eval and judge results, and the current contents of the `edit` files.
- A model proposes a change to only the `edit` files. Tidegate deploys it with `--no-promote`, so its
  checks run, then runs the gate against the live version on recent real inputs, including the failures.
- If the gate passes and at least one eval or judge pass rate is better, the candidate goes live. If not,
  the attempt and the gate's report go back to the model, up to `max_tries`; then the loop waits for the
  next round. Every attempt, its diff and its gate verdict are kept as a version, so a person can read
  what changed and why, and `tidegate rollback` undoes it.
- With `"improve": {"open_pr": true}`, the proven change becomes a pull request instead of going live
  (the Factory row), for teams that want a person to merge.
- Guardrails: replays never trigger `then`; the loop never edits tidegate.json, `checks` or tests (a
  candidate that changes them is rejected); token spend per round is capped (`budget`, in tokens).
- The model that proposes changes never sees secret values. Secrets in run logs, inputs and outputs are
  replaced with placeholders (`{{SECRET:ANTHROPIC_API_KEY}}`) before the brief is built, and a candidate
  that contains a known secret value is rejected.
- Guarding against slop. The gate checks outcomes, not whether the agent's code stays healthy, and models
  left alone tend to add rather than tidy (SlopCodeBench, 2026: best model about 16% at evolving a codebase
  over many changes). So the loop is kept narrow:
  - By default it edits only prompt and rule files (`.md`, `.txt`, `.json` data listed in `edit`). Listing a
    code file in `edit` requires `open_pr: true`, so a person merges every code change.
  - A candidate's diff is capped (`max_diff`, default 40 changed lines). Between two candidates that both
    pass, the smaller one wins, and one that removes lines wins over one that adds them.
  - Each change is described in one plain sentence ("added a rule: never promise a fix date"), kept with
    the version.
  - Once a month (`digest`, default on), the person gets one message: what the loop changed, which evals
    moved, and the files as they now stand, so they read the result instead of every diff. If the person
    has not opened two digests in a row, the loop pauses until they do: it never runs unattended for long.
- This replaces the per-project improver agent and items 4 and "Improvement as a Tidegate built-in"
  below. Built after launch, as the second launch moment: "deploy once, it improves itself, every change
  proven before it goes live."

### 3. Tell the person where they already are
```json
"notify": { "slack": "SLACK_WEBHOOK", "when": ["review", "blocked", "improved", "judge_off"] }
```
- `slack`, `discord` or `telegram` names a secret holding the webhook (or bot token and chat). Tidegate
  posts one short message per event, batched to at most one per `every` (default 15m) per project:
  - `review`: "3 runs of reply need you", with links to each run;
  - `blocked`: the gate's verdict for a blocked deploy, and the `promote` command;
  - `improved`: the improve loop shipped a change, with its diff and the evals that went up;
  - `judge_off`: judge review switched itself off, and why.
- Messages carry run links and numbers, never inputs, outputs or secrets.
- Without `notify`, flagged runs wait on the runs page, which nobody watches. This matters more for
  "as little of a person as possible" than any other feature: the person should hear from Tidegate only
  when it needs them, and never have to check.

### How we will describe it, once built
"Deploy an agent once. It gets better on its own, every change proven on real inputs, and it only
messages you when it needs a person." Frame it as back pressure for agents: the gate and judge raise the quality of
what comes out before a person sees it. Not before judge review and the improve loop exist.

Order: notifications (small, and useful today), then judge review (it needs only the scorecard and judge that exist), then the improve loop (it needs
judge review, or the person, to produce labelled failures to learn from).

## The closed loop: what is left (in order)
1. **Threshold preview:** "what if `min_confidence` were 0.8" on past runs: how many would have waited,
   and how many the person then changed. No redeploy.
2. **Flags grouped by reason**, as repeated problems are today, so ten runs with the same failed eval
   read as one line.
3. **Shadow traffic:** a copy of live inputs runs on a candidate for a while, next to the gate's replay.
4. **The improver opens a pull request** (the Factory row), proven by the gate before a person sees it.
- Cost per run (tokens times a price table) next to tokens.
- Replays that stub an agent's side effects, beyond the `TIDEGATE_TRIGGER=replay` convention.
- Improvement as a Tidegate built-in (`"improve": {"agent", "edit"}`) instead of an agent each project
  writes; and coding agents that edit code, not only prompts and rules.
- A run token minted per run instead of the TIDEGATE_TOKEN secret the improver uses today.

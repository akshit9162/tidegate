# Tidegate: spec

Status: built and tested locally, not deployed. 2026-11-25; market, `tidegate new` and pr-steward lessons added 2026-11-26.

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

## Where the market is going (2026-11-26)
Read from public sources in November 2026; several are secondary roundups, so treat the numbers as
direction, not fact.
- **Building agents is crowded and consolidating.** The category has split into no-code canvases for
  operations teams (Zapier Agents, n8n, Make) and code-first frameworks for engineers (Claude Agent SDK,
  LangGraph, CrewAI), with enterprise suites on top (Copilot Studio, Agentforce, Gemini Enterprise,
  ServiceNow). OpenAI is reported to be shutting down its visual Agent Builder and its Evals platform on
  2026-11-30; Relay.app shut in September; Dialpad and Ada agreed to combine on 2026-11-04, one of about
  eight customer-service AI acquisitions since mid-2025.
- **Buyers build their own.** G2's 2026 report: 42% of buyers use agent-builder platforms (up), 27% use
  ready-made agents (down); software-engineering use cases up 77% year on year.
- **Pricing moves to usage and outcomes** (Zendesk now charges per resolved issue).
- **Money goes to evals and observability:** Braintrust ($80M Series B, $800M post, Feb 2026), LangSmith
  ($1.25B valuation), Patronus ($50M, moving toward simulation), seeds for Respan, Galtea, ZeroEval.
- **The gap:** those tools show what an agent did after the fact. Nobody owns the step that decides
  whether a change to an agent may ship, which matters most once agents change themselves. Investors also
  now ask agent startups for production reliability data with categorized failure modes.

**Positioning that follows:** Tidegate is the release gate for agents that improve themselves: every
change, whether a person's or the agent's own, is replayed on real inputs and ships only if it is no
worse. A no-code builder on its own would enter the shrinking, crowded half of the market; as a front
door to the gate (`tidegate new`, below) it joins the half that is growing ("build your own") to the half
that is funded ("trust it"). For the Show HN (2026-12-08), lead with the gate and use pr-steward (below)
as the demo: a week of it answering review comments, the rule changes it tried, and the ones the gate
blocked.

Sources: [G2 2026 AI Agents Insight Report](https://sell.g2.com/g2-2026-ai-agents-insight-report),
[viktor.com builders comparison](https://viktor.com/blog/best-ai-agent-builders),
[vybe.build platforms 2026](https://www.vybe.build/blog/best-ai-agent-platforms-2026),
[AI Business Weekly, November 2026](https://aibusinessweekly.net/p/ai-agent-news),
[customer-service agents market (Yahoo Finance)](https://finance.yahoo.com/technology/ai/articles/ai-customer-agents-market-forecast-155600162.html),
[agent-eval startups (The Deep Feed)](https://www.thedeepfeed.ai/posts/2026-06-25-agent-eval-startups-metric-nobody-trusts/),
[self-improving agent ops (StartupXO)](https://startupxo.com/en/ideas/2026/07/2026-07-01-self-improving-agent-ops/),
[agent evaluation landscape (Presenc)](https://presenc.ai/research/ai-agent-evaluation-startups-2026).

## Amp (ampcode.com), read 2026-11-27
**What it is.** A coding agent and development environment. Each thread runs in a cloud sandbox (an "orb")
that keeps going after the laptop closes, or in a "runner" on your own machine (`amp --no-tui`). Orbs
wake on outside events: a review on a pull request, CI failing on main, a new Linear issue, a plugin
webhook, or a schedule the thread sets itself. "Ship" commits, rebases, runs the test suite in the orb
and pushes, or opens a PR ("Push to Branch"), or follows a custom prompt ("Custom Ship"). There is an SDK
(`@ampcode/sdk`, `execute({prompt, executor: 'orb' | 'runner'})`) and agent-to-agent threads. Pricing: a
free Hobby tier with unlimited self-hosted orbs and runners, then $20/month with 45,000 orb minutes.

**Does it compete with Tidegate?** Not with the gate. Amp's docs cover no hosting of agents as services,
no evals or replays, no check that a change to an agent's prompt or rules made it worse, no per-version
scorecard and no review queue (the nearest thing is a snoozed thread holding a question until a person
answers). Amp's "Ship" step only runs the repo's tests. Its one eval mention fans out fresh orbs to see
whether a repo's AGENTS.md is enough, which tests the repo, not an agent. It is aimed at coding work.
Tidegate is for any agent that runs on its own.

**It does overlap with pr-steward.** An orb that wakes on a PR review or a CI failure and pushes a fix
covers most of what `watch` + `fix` do, hosted and with no polling. So the Show HN demo must not lead
with "an agent that answers your review comments": people will say Amp does that. Lead with what Amp
lacks: the `rules.md` changes `learn` proposed, and the ones the gate blocked on replay. An Amp user could
put their Amp agent behind the gate. Amp is a possible worker, not a rival: an agent in `tidegate.json`
can call `amp -x` or the SDK the way pr-steward calls `claude -p`.

**What to take** (1 and 2 built 2026-11-27, 3 is in `tidegate new` below, 4 is in the pitch):
1. **Wake on events, not only `every`.** `"on": {"github": {"events": ["pull_request_review", "check_run"],
   "secret": "GITHUB_WEBHOOK_SECRET"}}` per agent: a webhook URL per project that starts a run with the event as input. pr-steward's 15-minute
   poll becomes a push. Verify GitHub's HMAC signature on every delivery. Amp leaves signature checks
   to the plugin; Tidegate should not.
2. **An agent schedules its own follow-up.** Amp threads set their own next wake-up. Let the output say
   `{"follow_up": {"in": "20m", "input": {...}}}`, so `fix` can check CI on its pushed commit and report the
   outcome itself (feeding `POST /runs/<id>/outcome`, below) instead of waiting for the weekly `learn`.
   Limit one pending follow-up per run, and stop after 5 follow-ups in a row.
3. **A ship policy in plain words.** "Custom Ship" is a prompt of up to 10,000 characters that decides
   how work lands. A `tidegate new` project could take its `checks` and hard gates the same way, written
   as sentences and compiled into code the person can read.
4. **Same runner, two places.** Amp keeps your own machine and its hosted orbs behind one interface.
   This matches `tidegate dev` plus hosted runners later. Keep that split in the pitch.

**What not to take:** orbs and live preview portals. That is compute, which we said we will not compete
on (Trigger.dev, Modal, Managed Agents, and now Amp).

Sources: [ampcode.com](https://ampcode.com/), [docs](https://ampcode.com/docs),
[automations and webhooks](https://ampcode.com/docs/orbs/automations),
[shipping](https://ampcode.com/docs/orbs/shipping), [SDK](https://ampcode.com/docs/sdk),
[runners](https://ampcode.com/docs/cli/runners), [pricing](https://ampcode.com/pricing).

## GitHub's agents, read 2026-11-27
GitHub runs agents inside repos: the Copilot cloud agent (an issue or prompt becomes a PR; since June 2026
also on schedules and repo events), Agent HQ (Claude and Codex assigned to the same issue, compared side
by side), Copilot code review (generally available March 2026), and Agentic Workflows (`gh-aw`, Markdown
compiled to Actions, generally available 2026-10-28, also for non-coding work such as triage and reports).
Billing is usage-based since 2026-06-01 (Pro $10, Pro+ $39, Business $19/user, Enterprise $39/user a month,
each including that much in credits).

**Overlap.** Like Amp, they cover running agents on events and schedules, which is where pr-steward sits.
None replays recorded production inputs on a changed prompt or agent and promotes it only if it does no
worse: a change to a custom agent's profile or to AGENTS.md goes live through ordinary PR review. No
per-version scorecard, no review queue outside PRs. The closest are experimental: `gh aw trial` (runs a
workflow in a scratch repo, `--repeat` for consistency, one chosen issue as context, no bulk replay, no
promotion) and `gh-aw` A/B experiments with deterministic graders (draft spec v0.2.0). That work is the
one to watch: it is GitHub heading toward the gate. Our answer is the same as for Amp: their agents can
run behind Tidegate, and the gate is the part they do not have.

Sources: [cloud agent automations](https://github.blog/changelog/2026-06-02-schedule-and-automate-tasks-with-copilot-cloud-agent/),
[Agent HQ](https://github.blog/news-insights/company-news/welcome-home-agents/),
[Agentic Workflows GA](https://github.blog/changelog/2026-10-28-github-agentic-workflows-generally-available),
[TrialOps](https://github.github.com/gh-aw/experimental/trial-ops/),
[graders spec](https://github.github.com/gh-aw/specs/graders-specification/),
[usage-based billing](https://github.blog/changelog/2026/04/27/github-copilot-is-moving-to-usage-based-billing/).

## Trigger.dev, read 2026-11-27
Open-source durable background jobs in TypeScript, now pitched for AI agents: `chat.agent` (durable
multi-turn agents), waitpoints for a person's approval, cron and verified webhooks, OTel traces with model
cost, atomic versions with `deploy --skip-promotion` and `promote`, and `prompts.define()` (prompts
versioned per deploy, with token, cost and latency per prompt version). Free, then $10 and $50 a month
plus compute.

**Overlap.** It has every piece of the gate except the decision. `runs.replay(id, {version})` and bulk
replay rerun past payloads on a chosen version, but nothing compares the outputs. Promotion is by hand
or automatic, never "only if no worse". No evals, judge, per-version scorecard or review queue. It is the
nearest neighbour so far: a Trigger.dev user could build the gate from its parts, and Tidegate could run
on top of it (replay on a candidate, score, promote). The pitch against it is that the comparison and
the promote decision are the product.

Sources: [replaying](https://trigger.dev/docs/replaying), [versioning](https://trigger.dev/docs/versioning),
[prompts](https://trigger.dev/docs/ai/prompts), [pricing](https://trigger.dev/pricing).

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
- **Triggers:** HTTP (on by default), `every` (15m or longer), GitHub webhooks (`"on": {"github": {"events",
  "secret"}}`, signature checked, redeliveries ignored), a follow-up the agent asks for in its output
  (`{"follow_up": {"in": "20m", "input": {...}}}`, 1m to 1d, at most 5 in a row), or by hand with
  `tidegate invoke`.
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
messages you when it needs a person. It runs on your machine today and on ours later, the same way." Frame it as back pressure for agents: the gate and judge raise the quality of
what comes out before a person sees it. Not before judge review and the improve loop exist.

Order: notifications (small, and useful today), then judge review (it needs only the scorecard and judge that exist), then the improve loop (it needs
judge review, or the person, to produce labelled failures to learn from).

### 4. `tidegate new`: describe an agent, get one that ships through the gate
```
tidegate new "answer review comments on my open PRs, fixing what's valid with a failing test first"
```
- A front door, not a second product. A coding agent (Claude Code on the runner, the Factory row) writes
  a normal project: the agent's code, `tidegate.json`, `checks` (unit tests with stubbed side effects),
  evals the agent reports, and a `rules.md` the improve loop may edit later. The output is readable code
  in a folder the person owns, not a hidden format: that is the difference from the canvas builders.
- Before the first deploy it generates sample inputs, runs them as replays (`TIDEGATE_TRIGGER=replay`, no
  side effects), and shows the person the outputs and evals. The person says yes once; after that the
  gate, judge review and the improve loop take over.
- It writes in the patterns pr-steward proved necessary (next section): side effects skipped on replay,
  hard gates before anything irreversible, `retry` for passing failures, `notify`, a kill switch.
- **Hard rules in plain words.** Like Amp's "Custom Ship" prompt, the person may write the rules
  ("push only if a test fails before and passes after; never touch CI files; at most 80 lines") as
  sentences. `tidegate new` turns each one into a check in code, with a test that breaks it, and shows the
  sentence next to its code. The sentence is documentation; the code is the rule, so a model reading it
  cannot argue its way past it.
- Who it is for decides the scope: developers who skip the boilerplate (CLI, readable code) first.
  Non-developers would need hosted runners, connectors (Gmail, Slack) and a web editor: later, if ever.
- Test: from one sentence, regenerate something close to pr-steward that passes its end-to-end tests.

## The first unattended agent: pr-steward (2026-11-26)
`~/projects/pr-steward`, deployed to the local Tidegate. Three agents look after the owner's open pull
requests with no approval step: `watch` (every 15m) finds new review comments, reviews, CI failures and
conflicts and sends each to `fix`; `fix` runs headless Claude Code in a checkout, and pushes only if a
named test fails before and passes after, the diff is at most 80 lines, no protected file is touched, the
typecheck is no worse, and the push budget allows; `learn` (weekly) labels what happened after each action
from GitHub (reviewer pushback, CI on the pushed commit, bot withdrawals, merges), proposes a `rules.md`
change of at most 40 lines that keeps the output contract and the untrusted-input rule, and deploys it
through the gate. It is the improve loop (item 2) built by hand in one project, and the source of these
platform gaps, each found by running it:
- **State races (bug).** The runner uploads every `state` file after every run, changed or not, and the
  server overwrites. A long `fix` run therefore wrote back an old copy of what `watch` recorded meanwhile,
  which would have answered the same comment twice. pr-steward keeps state on local disk instead. Fix:
  upload only files that changed, and refuse a write whose base version is not the current one
  (compare-and-swap), or scope state per agent.
- **Host logins under the clean environment.** Runs get `HOME` set to the work folder and no `USER`, so
  CLIs that find their login through them (Claude Code's keychain entry needs `USER`; `gh`, git
  credentials) are signed out. Fine for hosted runners; for `tidegate dev` on the person's own machine,
  offer `"host_login": true` per agent, which passes the real `HOME` and `USER`.
- **Replays run beside live runs.** The gate replays a candidate and the live version at once, while live
  runs continue, so an agent with a working folder outside the run (a git checkout) needs one per replay.
  Replays of event-driven agents also need the world as it was: pr-steward checks out the event's old
  commit. Document both in the agent contract next to `TIDEGATE_TRIGGER=replay`.
- **Retry.** A run that fails for a passing reason (usage limit, network) is lost unless the agent
  retries it; `watch` does, with backoff. Built-in: `"retry": {"max": 6, "backoff": "15m"}` per agent,
  plus `"retry": true` in the output for failures the agent knows will pass.
- **Agents calling agents.** `watch` starts `fix` runs over HTTP with the project's deploy token as a
  secret. A run token scoped to "start runs of this project" would replace it (already listed below).
- **Outcome labels without a person.** The improve loop as specified learns from review decisions; an
  agent that acts in the world gets better labels from what the world did next. Let an agent report
  outcomes for earlier runs (`POST /runs/<id>/outcome {label, signals}`) so the scorecard and the improve
  loop use them like review decisions.
- **Notifications.** pr-steward posts macOS notifications and keeps an activity log by hand: evidence
  for building `notify` (item 3) first.
- **Gate size.** Five replays per version cost about ten model runs per deploy and are noisy on pass
  rates; the gate should report its sample size and treat small samples as "not worse" only within a
  margin.
- **Isolation.** The agent's tests run as the owner's user, including tests the model wrote; a comment
  that talked the model into a hostile test reaches everything the account can. `--isolate docker` is the
  answer, which hosted runners need anyway.

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

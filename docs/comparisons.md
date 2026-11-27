# How Tidegate compares

Read from each product's own docs and pricing pages on 2026-11-27. Products change quickly; if something
here is wrong or out of date, open an issue or a pull request with the source and we will fix it.

## The short version
Tidegate's one job is the deploy decision: replay the real inputs an agent received on the new version
and on the live one, side by side, and promote the new version only if it does no worse. The products
below are good at things Tidegate does not try to do. None of them documents that comparison as a
built-in step of a deploy. LangSmith and Braintrust come closest: both can build a dataset from
production traces and run evals on it in CI, and you write the pass or fail rule yourself.

| | Runs agents on events and schedules | Records model calls | Evals and experiments | Review queue | Replays real inputs on a new version | Promotes only if no worse, automatically |
|---|---|---|---|---|---|---|
| **Tidegate** | Yes (HTTP, schedules, GitHub webhooks, follow-ups) | Yes, through a base-URL gateway, no SDK | Evals the agent reports, plus an optional judge model | Yes, flagged runs only | Yes, on every deploy | Yes |
| **Amp** | Yes (cloud orbs or your own runner) | Not covered here | No eval of an agent's changes documented | No | No | No |
| **GitHub's agents** | Yes (Copilot cloud agent, Agentic Workflows) | Not covered here | Experimental: `gh aw trial`, graders | Pull request review | No | No |
| **Trigger.dev** | Yes (durable jobs, cron, webhooks) | OpenTelemetry traces with model cost | No | Waitpoints for approval | Yes, by hand or in bulk, on a version you choose | No: promotion is by hand or automatic |
| **LangSmith** | Yes (Agent Server) | SDK wrappers or OpenTelemetry | Yes: datasets, experiments, online evaluators | Annotation queues | Yes, as backtesting on a dataset built from traces | Not built in; an example CI pipeline shows how to build it |
| **Braintrust** | No ("Agent deployment through the SDK is not supported") | SDK or its Gateway | Yes: experiments with a diff against a baseline | Human review | Yes, as experiments on a dataset built from logs | No: its GitHub Action posts results; a custom reporter can fail CI |

## Amp
A coding agent whose threads run in cloud sandboxes ("orbs") or on a runner on your own machine. Orbs wake
on outside events: "an orb can wake up when CI fails on GitHub, when someone opens a Linear issue, when a
monitor raises an alert, or when an event arrives from Discord"
([event-driven orbs](https://ampcode.com/news/event-driven-orbs)), and on pull request activity:
"Comments, reviews, and CI results show up in the same thread"
([GitHub listeners](https://ampcode.com/news/github-listeners)). Schedules and webhooks are in the
[automations docs](https://ampcode.com/docs/orbs/automations). Pricing: a free Hobby tier, then $20 a
month with 45,000 orb minutes ([pricing](https://ampcode.com/pricing)).

**Where it is ahead:** hosted compute, and a polished agent that answers review comments and fixes CI.
**What it does not document:** replaying past inputs on a changed agent, evals of an agent's own changes,
or promotion gated on them. **Together:** an agent in `tidegate.json` can call Amp the way any program can,
and its prompt and rules then deploy through the gate.

## GitHub's agents
The Copilot cloud agent turns an issue or a prompt into a pull request, and since June 2026 also runs on
schedules and repository events ([changelog](https://github.blog/changelog/2026-06-02-schedule-and-automate-tasks-with-copilot-cloud-agent/)).
GitHub Agentic Workflows (`gh-aw`) compile Markdown into Actions and became generally available on
2026-10-28 ([changelog](https://github.blog/changelog/2026-10-28-github-agentic-workflows-generally-available)).
A change to an agent's instructions goes live through ordinary pull request review.

**Closest to the gate:** `gh aw trial` "creates a temporary private repository" and runs a workflow there
([TrialOps](https://github.github.com/gh-aw/experimental/trial-ops/)), and the draft
[graders spec](https://github.github.com/gh-aw/specs/graders-specification/) computes deterministic
metrics for experiments. Neither replays recorded production inputs or gates a deploy today. This is the
area to watch.

## Trigger.dev
Open-source durable background jobs in TypeScript, now pitched for AI agents. It has most of the parts of
a gate: deploy without promoting (`--skip-promotion`, then `promote`;
[deployment](https://trigger.dev/docs/deployment/overview)), replay a past run on a chosen version, also in
bulk ([replaying](https://trigger.dev/docs/replaying)), and prompts versioned per deploy
([prompts](https://trigger.dev/docs/ai/prompts)). Nothing compares the replayed outputs or decides
promotion from them. Free, then $10 and $50 a month plus compute ([pricing](https://trigger.dev/pricing)).

**Where it is ahead:** durable execution, scale and a hosted service. **Together:** you could build the
gate from its parts; Tidegate is that comparison and decision, already built.

## LangSmith
The closest on evaluation. It documents backtesting: "Production logs are converted into a dataset, then
newer versions process these examples to assess performance on past, realistic user inputs"
([evaluation types](https://docs.langchain.com/langsmith/evaluation-types)). Automation rules add traces
to datasets ([datasets](https://docs.langchain.com/langsmith/manage-datasets-in-application)); pytest and
Vitest integrations raise assertion errors in CI ([pytest](https://docs.langchain.com/langsmith/pytest),
[Vitest/Jest](https://docs.langchain.com/langsmith/vitest-jest)); and an
[example CI/CD pipeline](https://docs.langchain.com/langsmith/cicd-pipeline-example) promotes to production
if all evaluations pass. It hosts agents as LangSmith Agent Server
([deployment](https://docs.langchain.com/langsmith/deployment)). Tracing uses SDK wrappers or
[OpenTelemetry](https://docs.langchain.com/langsmith/trace-with-opentelemetry). Self-hosting is an
Enterprise add-on ([self-hosted](https://docs.langchain.com/langsmith/self-hosted)). Developer plan free
up to 5,000 traces a month, Plus $39 per seat a month ([pricing](https://www.langchain.com/pricing)).

**Where it is ahead:** a mature evaluation product, many evaluator types, a large ecosystem.
**The difference:** in LangSmith you assemble the gate (dataset rules, a CI job, thresholds, the promote
step). In Tidegate it is the deploy: the last N real inputs, both versions side by side, no worse within a
tolerance, or the live version stays. No SDK or tracing code in the agent.

## Braintrust
Experiments are "the immutable, comparable record of your eval runs"
([experiments](https://docs.braintrust.dev/guides/experiments)), with a diff view that marks regressions
against a baseline ([compare](https://docs.braintrust.dev/evaluate/compare-experiments)). Datasets can be
built from production logs ([datasets](https://docs.braintrust.dev/annotate/datasets)). Its
[GitHub Action](https://github.com/braintrustdata/eval-action) runs evals and posts a summary on the pull
request; a custom reporter can fail the CI process ([run in CI](https://docs.braintrust.dev/evaluate/run-in-ci)).
It has online scoring, human review and an OpenAI-compatible
[Gateway](https://docs.braintrust.dev/deploy/gateway). It does not host agents: "Agent deployment through
the SDK is not supported" ([functions](https://docs.braintrust.dev/deploy/functions)). Starter free, Pro
$249 a month ([pricing](https://www.braintrust.dev/pricing)).

**Where it is ahead:** experiment analysis, scoring at scale, team workflows. **The difference:** Braintrust
tells you a version regressed; Tidegate is also where the agent runs, so it can keep the worse version
from going live.

## Where Tidegate is behind
- No hosted version. You run it with `tidegate dev` or on your own Cloudflare account.
- The gate compares small samples (the last `replay` inputs, 10 by default) with a tolerance, not a
  statistical test.
- Replays rerun the agent for real, including model calls. Side effects are skipped only if the agent
  checks `TIDEGATE_TRIGGER=replay`.
- The gate is only as good as the evals the agent reports, or the judge you configure.
- One token per project, no accounts, no streaming output.

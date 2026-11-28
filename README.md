# Tidegate

[![npm](https://img.shields.io/npm/v/tidegate)](https://www.npmjs.com/package/tidegate) [![test](https://github.com/akshit9162/tidegate/actions/workflows/test.yml/badge.svg)](https://github.com/akshit9162/tidegate/actions/workflows/test.yml) [![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**A worse agent can't go live.** Tidegate is an open-source deploy gate for AI agents. Every deploy
replays the last real inputs your agent received on the new version and on the live one, compares them,
and promotes the new version only if it does no worse. Otherwise the live version stays, and the deploy
says what got worse:

```text
Blocked: worse than the live version on 2 real inputs. The live version stays.
  reply: short 100% (live 100%), no_promises 0% (live 100%)
    worse: eval no_promises passes 0% vs 100% live
  Ship it anyway: tidegate promote <version>
```

<p align="center"><img src="docs/demo.gif" alt="A change that makes a support agent promise fixes is blocked by the gate on 5 real inputs; the fix goes live." width="760"></p>

It gates every change the same way: a prompt edit, a model swap, or a rule the agent rewrote itself.
Around the gate, Tidegate hosts the agents (any language; endpoints, schedules, GitHub webhooks, secrets,
saved files), records every model call with no SDK, and sends only the risky runs to a person.

Other tools run agents on events and schedules (GitHub's agents, Amp, Trigger.dev) or score them after
the fact (LangSmith, Braintrust). Tidegate decides whether a change may ship.
[How it compares](docs/comparisons.md), with sources.

Status: 0.1. It runs on your machine (`tidegate dev`) or on your own Cloudflare account. There is no hosted
version yet.

## Try it in two minutes
You need Node 20 or later and Python 3. No account, no API key.

```sh
npm install -g tidegate
git clone https://github.com/akshit9162/tidegate && cd tidegate/examples/support-reply
tidegate dev                   # all of Tidegate on this machine; leave it running
```
In a second terminal, in the same folder:
```sh
tidegate deploy                # live at http://localhost:8787/p/support-reply
tidegate invoke reply '{"email": "Where is my order?"}'
tidegate invoke reply '{"email": "My parcel is late"}'
```

### Watch the gate block a worse agent
Change the reply so it makes a promise the agent's `no_promises` eval forbids, and deploy it:
```sh
sed -i.bak 's/get back to you shortly/guarantee a fix by tomorrow/' reply.py
tidegate deploy                # Blocked: worse than the live version on 2 real inputs. The live version stays.
mv reply.py.bak reply.py
tidegate deploy                # Gate passed: the original goes live again
```
The gate reran the real emails you sent on both versions and compared them. Without an API key the
example answers from a template; set one with `tidegate secret set ANTHROPIC_API_KEY` to use a model.

## The loop
| Step | What Tidegate does |
|---|---|
| Deploy | `tidegate deploy` or `git push tidegate main`. Python, Node, or a Dockerfile; versions kept, rollback is one command. |
| Record | Input, output, log and files of every run, and every model call it made (model, tokens, time). |
| Review | With `"review": {"when": "flagged"}`, only runs with low confidence, a failed eval, a failed judge question or errors wait for you. Approve, edit the output, revise with a note, or reject. |
| Learn | Outputs you approved or corrected reach later runs in `$TIDEGATE_EXAMPLES`. |
| Judge | A decision model (TypeSafe Jev, Google Gemini Decision, or an open-weight model) answers typed questions about every run. |
| Prove | With `"gate"`, each deploy replays recent real inputs on the new and the live version, and goes live only if it does no worse. Add `"replay_failed": 5` to also replay older inputs that went wrong, as a separate group: the deploy reports how many the new version gets right, and fixing old failures never excuses a regression on recent ones. |

## Why not a host plus a tracing tool plus an eval tool
Most teams glue together a host (Render, Modal, AWS), a tracing tool that needs code in the agent, and an
eval script, then compare versions by hand. Tidegate is one place for all three with no instrumentation
code, and the comparison is part of the deploy, not a step someone remembers. See
[docs/comparisons.md](docs/comparisons.md) for where LangSmith, Braintrust, Moda, Trigger.dev, Amp and
GitHub's agents fit, and where they are ahead.

## Writing an agent
- Read the input from the JSON file at `$TIDEGATE_INPUT` and write the output as JSON to `$TIDEGATE_OUTPUT`.
  Print logs to stdout. That is the whole contract, so any language and any framework works.
- Call your model as usual. `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` point at Tidegate, which records
  each call and passes it on with your own key.
- Report how sure you are and how you did: `{"confidence": 0.8, "evals": {"cites_source": true}}`.
- `$TIDEGATE_EXAMPLES` holds reviewed outputs: `good` (approved or corrected) and `avoid` (rejected, with
  the reviewer's note). Use them as few-shot examples.
- Files in tidegate.json `state` are kept between runs; files written to `$TIDEGATE_FILES` are kept with the
  run and shown in review; listed secrets arrive as environment variables.
- `"review": {"then": "send", "when": "flagged"}` holds risky runs for a person and runs `send` with the
  approved output. Replays never trigger `send`; an agent that acts itself should check
  `TIDEGATE_TRIGGER=replay`.
- `"on": {"github": {"events": ["pull_request_review.submitted", "check_run"], "secret": "GITHUB_WEBHOOK_SECRET"}}`
  starts a run for each GitHub webhook delivery of those events, with `{event, action, delivery, payload}`
  as input. Point the repo's webhook at the `github_webhook_url` that `tidegate status` prints, with content
  type `application/json` and the same secret (`tidegate secret set GITHUB_WEBHOOK_SECRET`). Deliveries
  with a wrong signature are refused, and a redelivery starts nothing new.
- `{"follow_up": {"in": "20m", "input": {...}}}` in the output runs the agent again later, for example to
  check CI on a commit it pushed. From 1 minute to 1 day ahead, at most 5 in a row; replays never follow up.

`examples/support-reply` uses all of this; `examples/review-reply` drafts replies to review comments from
a GitHub webhook and posts the ones you approve; `examples/ticket-triage` shows state and schedules. The full
design, including the judge and the gate, is in [SPEC.md](SPEC.md).

## Commands
Install with `npm install -g tidegate`. Outside a clone of this repo, `npx tidegate` works without installing.
```sh
tidegate deploy [--no-promote] [--replay AGENT]   # upload; live when checks (and the gate) pass
tidegate invoke AGENT [JSON]                       # run an agent and print its output
tidegate reviews | approve | correct | revise | reject RUN
tidegate runs | trace RUN | scorecard [AGENT] | logs RUN
tidegate promote VERSION | rollback [VERSION]
tidegate secret set NAME
tidegate dashboard                                 # the runs page, signed in
tidegate runner [--isolate docker]                 # run agents, each in a container with docker
tidegate mcp                                       # deploy, invoke, status and runs as MCP tools
```
`git remote add tidegate tidegate::<project>` then `git push tidegate main` deploys the pushed commit
(with `git-remote-tidegate` on your PATH, for example through `npm link`).

## Run it from source
```sh
npm install
npm link                     # puts tidegate and git-remote-tidegate on your PATH
tidegate dev                   # Worker, local database and a runner; data in ~/.tidegate/dev
```
Tidegate is a Cloudflare Worker (D1 and R2) plus a runner you can run anywhere, including inside your
own infrastructure, so agent code and secrets can stay on your machines.

## Run it on your own Cloudflare account
```sh
npx wrangler d1 create tidegate          # put the printed database_id in wrangler.toml
npx wrangler r2 bucket create tidegate-files
npm run db:remote                        # create the tables
openssl rand -base64 32 | npx wrangler secret put SECRETS_KEY
openssl rand -hex 24 | tee /dev/tty | npx wrangler secret put RUNNER_TOKEN
npx wrangler deploy
```
Set `DOMAIN` and `SCHEME` in wrangler.toml to your Worker's address. Then run a runner anywhere,
with the same token: `RUNNER_TOKEN=... TIDEGATE_API=https://your-worker tidegate runner --isolate docker`.

## Contributing
Start with an issue labelled [good first issue](https://github.com/akshit9162/tidegate/labels/good%20first%20issue);
[CONTRIBUTING.md](CONTRIBUTING.md) says how to run everything and what a pull request needs. Questions and
ideas go to [Discussions](https://github.com/akshit9162/tidegate/discussions).

## Tests
```sh
npm test                     # unit tests

# end to end, once: local secrets and tables
printf 'SECRETS_KEY=%s\nRUNNER_TOKEN=%s\n' "$(openssl rand -base64 32)" "$(openssl rand -hex 24)" > .dev.vars
npm run db
npm run dev:e2e              # a Worker pointed at the test's mock model API
set -a; . ./.dev.vars; set +a; tidegate runner   # second terminal (E2E_ISOLATE=docker with --isolate docker)
node test/e2e.mjs            # third terminal
```

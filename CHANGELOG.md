# Changelog

All notable changes to Tidegate. Versions follow [semver](https://semver.org); while it is 0.x, a minor
version may change the tidegate.json format, and the entry says how to update.

## Unreleased

Added:
- `"gate": {"replay_failed": N}` also replays the last N older inputs that went wrong (the run failed or
  timed out, a person rejected, revised or corrected it, or an eval failed). They are judged apart from
  the recent inputs, by the same no-worse rule, and the deploy reports
  `went right on 3 of 5 inputs that went wrong before (live 0)`. "Went right" means the replay did not fail
  and no eval failed, so a rejection is only rechecked when the agent has an eval or a judge for it.

## 0.1.1 (2026-11-27)

Added:
- GitHub webhooks start runs: `"on": {"github": {"events": [...], "secret": "NAME"}}` per agent, at
  `/hooks/<project>/github`. Each delivery's `X-Hub-Signature-256` is checked against the named secret, and
  redeliveries are ignored. Runs started this way are real inputs, so the gate replays them.
  `tidegate status` prints the webhook address.
- An agent can ask for one later run with `{"follow_up": {"in": "20m", "input": {...}}}` in its output
  (1 minute to 1 day; at most 5 in a row).
- `examples/review-reply`: drafts a reply to each review comment GitHub sends, waits for your approval,
  then posts it. Includes signed sample deliveries, so it runs without GitHub.
- `docs/comparisons.md`: how Tidegate compares with Amp, GitHub's agents, Trigger.dev, LangSmith and
  Braintrust, with sources.

Fixed:
- A project without `checks` never went live; its versions stayed "ready" with no live version, while
  `tidegate deploy` printed "Live". `deploy` now says "Ready, but not live" whenever the server did not
  promote the version.
- `tidegate dev --port N` started its runner against port 8787 unless `TIDEGATE_API` was also set, and
  printed a deploy hint that did the same.

Changed:
- The npm page shows the current README and a new package description. Install with
  `npm install -g tidegate`; `npx tidegate` inside a clone of this repo fails because npx finds the repo's
  own package.

## 0.1.0 (2026-11-25)

First public release.

- Deploy gate: each deploy replays recent real inputs on the new and the live version and goes live only
  if it does no worse.
- `tidegate dev`: the Worker, a local database and a runner on one machine, no account.
- Review of flagged runs, corrections as examples, gateway traces with no SDK, judge (Jev, Gemini
  Decision, any OpenAI-compatible server), `git push tidegate main`, Docker isolation, MCP server.
- tidegate.json rejects unknown keys and suggests the one you meant.
- Unknown commands and options exit with status 2.

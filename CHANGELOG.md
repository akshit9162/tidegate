# Changelog

All notable changes to Tidegate. Versions follow [semver](https://semver.org); while it is 0.x, a minor
version may change the tidegate.json format, and the entry says how to update.

## 0.1.1 (unreleased)

- GitHub webhooks start runs: `"on": {"github": {"events": [...], "secret": "NAME"}}` per agent, at
  `/hooks/<project>/github`. Each delivery's `X-Hub-Signature-256` is checked against the named secret, and
  redeliveries are ignored. Runs started this way are real inputs, so the gate replays them.
- An agent can ask for one later run with `{"follow_up": {"in": "20m", "input": {...}}}` in its output
  (1 minute to 1 day; at most 5 in a row).
- Fixed: `tidegate dev --port N` started its runner against port 8787 unless `TIDEGATE_API` was also set,
  and printed a deploy hint that did the same.

- The npm page shows the current README: install with `npm install -g tidegate`. `npx tidegate` inside a
  clone of this repo fails because npx finds the repo's own package.
- New package description.
- Fixed: a project without `checks` never went live; its versions stayed "ready" with no live version,
  while `tidegate deploy` printed "Live". `deploy` now says "Ready, but not live" whenever the server did
  not promote the version.

## 0.1.0 (2026-11-25)

First public release.

- Deploy gate: each deploy replays recent real inputs on the new and the live version and goes live only
  if it does no worse.
- `tidegate dev`: the Worker, a local database and a runner on one machine, no account.
- Review of flagged runs, corrections as examples, gateway traces with no SDK, judge (Jev, Gemini
  Decision, any OpenAI-compatible server), `git push tidegate main`, Docker isolation, MCP server.
- tidegate.json rejects unknown keys and suggests the one you meant.
- Unknown commands and options exit with status 2.

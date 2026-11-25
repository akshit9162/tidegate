# Changelog

All notable changes to Tidegate. Versions follow [semver](https://semver.org); while it is 0.x, a minor
version may change the tidegate.json format, and the entry says how to update.

## 0.1.0 (unreleased)

First public release.

- Deploy gate: each deploy replays recent real inputs on the new and the live version and goes live only
  if it does no worse.
- `tidegate dev`: the Worker, a local database and a runner on one machine, no account.
- Review of flagged runs, corrections as examples, gateway traces with no SDK, judge (Jev, Gemini
  Decision, any OpenAI-compatible server), `git push tidegate main`, Docker isolation, MCP server.
- tidegate.json rejects unknown keys and suggests the one you meant.
- Unknown commands and options exit with status 2.

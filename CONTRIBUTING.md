# Contributing

Issues and pull requests are welcome. Issues labelled
[good first issue](https://github.com/akshit9162/tidegate/labels/good%20first%20issue) are small and say
when they are done; comment on one to take it, so two people do not build the same thing. For anything
larger than a small fix, open an issue first so we can agree on the shape before you write code.

We aim to give every pull request a first review within two working days.

## Set up
```sh
npm install
npm link            # tidegate and git-remote-tidegate on your PATH
tidegate dev        # Worker, local database and a runner
npm test            # unit tests, a few seconds
```
To try a change without touching your own data, give it its own folder and port:
`TIDEGATE_HOME=/tmp/tg tidegate dev --port 8790`, and `TIDEGATE_API=http://localhost:8790` for other
commands.

## Where things are
| Path | What |
|---|---|
| `cli/tidegate.mjs` | Every command; `CliError` for errors a user should see |
| `worker/src/config.js` | tidegate.json: parsing, defaults, the messages for mistakes |
| `worker/src/runner.js` | Queueing and finishing runs, follow-ups |
| `worker/src/loop.js` | The gate, replays and the scorecard |
| `worker/src/review.js` | Flags and review decisions |
| `worker/src/hooks.js` | GitHub webhooks |
| `examples/` | Agents people copy; each has its own tests in `checks` |
| `test/*.test.mjs` | Unit tests (`node --test`); `test/e2e.mjs` runs against a live Worker |

## Before you open a pull request
- `npm test` passes, and new behaviour has a test.
- If you change something used in many places (an error, an option, a message format), search for every
  use (`grep -rn "CliError(" cli worker`) and change them all in the same pull request. List them in the
  description, so the review can check none was missed.
- For changes to deploys, runs, review, the gate or the judge, the end-to-end test passes too:
  `npm run dev:e2e`, then `tidegate runner` in a second terminal, then `node test/e2e.mjs`.
- Keep the agent contract (`$TIDEGATE_INPUT`, `$TIDEGATE_OUTPUT` and the other variables) backwards
  compatible, or say clearly in the pull request that it breaks it.
- User-facing changes get a line in `CHANGELOG.md` under the next version.

By contributing you agree that your contribution is licensed under the Apache License 2.0.

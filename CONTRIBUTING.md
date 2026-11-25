# Contributing

Issues and pull requests are welcome. For anything larger than a small fix, open an issue first so we
can agree on the shape before you write code.

## Set up
```sh
npm install
npm link            # tidegate and git-remote-tidegate on your PATH
tidegate dev        # Worker, local database and a runner
```

## Before you open a pull request
- `npm test` passes.
- For changes to deploys, runs, review, the gate or the judge, the end-to-end test passes too:
  `npm run dev:e2e`, then `tidegate runner` in a second terminal, then `node test/e2e.mjs`.
- Keep the agent contract (`$TIDEGATE_INPUT`, `$TIDEGATE_OUTPUT` and the other variables) backwards
  compatible, or say clearly in the pull request that it breaks it.

By contributing you agree that your contribution is licensed under the Apache License 2.0.

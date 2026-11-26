# Error codes

The CLI prints `tidegate: <CODE>: <message>`. The code is stable, so scripts and agents can match on it; the prose may change.

| Code | Exit | Meaning | Fix |
|---|---|---|---|
| `TG_USAGE` | 2 | The command or option is not one this CLI knows | Run `tidegate --help`; the message names the closest command |
| `TG_NO_CONFIG` | 2 | No `tidegate.json` in the folder being deployed | Run deploy inside an agent's folder, or create `{"agents": [{"name": "triage", "run": "python agent.py"}]}` |
| `TG_UNREACHABLE` | 1 | Nothing answered at the API address | Start one with `tidegate dev`, or point `TIDEGATE_API` at your server |
| `TG_HTTP` | 1 | The server said no; the message carries its status and reason | Read the reason: usually a missing token, an unreachable upstream, or a project that does not exist |
| `TG_NO_TOKEN` | 1 | No deploy token for this project on this machine | Deploy the project from this machine first, or set a token of your own |
| `TG_NO_RUNNER_TOKEN` | 1 | `tidegate runner` was started without its worker token | Set `RUNNER_TOKEN` to the worker's runner token |
| `TG_BAD_ISOLATE` | 1 | `--isolate` was given a value other than `none` or `docker` | Use `--isolate none` or `--isolate docker` |
| `TG_NO_DOCKER` | 1 | `--isolate docker` without a working Docker | Start Docker, or run with `--isolate none` |
| `TG_DOCKER` | 1 | A container image failed to build | Read the build output; usually a missing dependency file or a bad base image |
| `TG_INSTALL_FAILED` | 1 | `pip install -r requirements.txt` or `npm install` failed | Run the same command in the folder to see the real error |
| `TG_DB_FAILED` | 1 | The local database could not be created | Run `npm run db` and check that `wrangler` is installed and logged in |
| `TG_WORKER_STOPPED` | 1 | The local Worker exited during `tidegate dev` | The tail of its log is in the message |
| `TG_WORKER_TIMEOUT` | 1 | The local Worker did not answer within 90 seconds | Check the port is free and the log tail for the reason |
| `TG_BLOB_CORRUPT` | 1 | A downloaded blob did not match its hash | Run the command again; if it repeats, the artifact on the server is damaged |
| `TG_UNKNOWN_TOOL` | 1 | An MCP client asked for a tool that does not exist | Call `tidegate mcp` and use the tools it lists |

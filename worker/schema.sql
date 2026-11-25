-- Projects own versions; production is a pointer into versions, so rollback is one UPDATE.
CREATE TABLE IF NOT EXISTS projects (
  name TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  production TEXT,
  created_at INTEGER NOT NULL
);

-- A version is unchangeable once finalized. Its file list lives in R2 at versions/<id>.json.
-- status: uploading -> checking -> ready | failed
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  status TEXT NOT NULL,
  config TEXT NOT NULL,           -- tidegate.json as stored
  problems TEXT,                  -- JSON list of check failures
  promote INTEGER NOT NULL DEFAULT 1,
  on_ready TEXT,                  -- JSON {"replay": {"agent", "last"}}: replays to queue once the version is ready
  gate TEXT,                      -- JSON: tidegate.json "gate" verdict {status: replaying | passed | blocked, against, agents}
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS versions_project ON versions(project, created_at);

-- Work for the runner: a check of a version, or one run of an agent.
-- status: queued -> running -> ok | failed | timeout
-- review (agents with "review" in tidegate.json, after an ok run): waiting -> approved | revised | rejected | corrected,
-- or auto when review.when is "flagged" and nothing flagged the run
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  kind TEXT NOT NULL,             -- check | agent
  agent TEXT,
  trigger TEXT NOT NULL,          -- deploy | schedule | http | manual
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT,                     -- JSON the run was started with
  output TEXT,                    -- JSON the agent wrote to $TIDEGATE_OUTPUT
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  heartbeat_at INTEGER,
  ended_at INTEGER,
  exit_code INTEGER,
  problems TEXT,                  -- JSON list of error lines found in the log
  log_tail TEXT,
  parent TEXT,                    -- the reviewed run whose decision queued this one
  files TEXT,                     -- JSON {name: sha256} the agent wrote to $TIDEGATE_FILES
  input_files TEXT,               -- JSON {name: sha256} handed to this run in $TIDEGATE_INPUT_FILES
  review TEXT,                    -- waiting | approved | revised | rejected | corrected | auto
  review_note TEXT,
  reviewed_at INTEGER,
  next_run TEXT,                  -- the run the decision queued
  replay_of TEXT,                 -- for trigger 'replay': the run whose input this run reuses
  flags TEXT,                     -- JSON list: why this run was sent for review
  corrected TEXT,                 -- JSON output a person wrote in place of the agent's (review 'corrected')
  gate TEXT,                      -- for gate replays: the candidate version they judge
  trace_token TEXT,               -- sha256 of the token the run's model calls carry through the gateway
  judge TEXT                      -- JSON: the judge's answers {provider, model, ms, usage, results} or {error}
);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status, queued_at);
CREATE INDEX IF NOT EXISTS runs_project ON runs(project, queued_at);
CREATE INDEX IF NOT EXISTS runs_review ON runs(project, review);
CREATE INDEX IF NOT EXISTS runs_gate ON runs(gate);
CREATE INDEX IF NOT EXISTS runs_trace ON runs(trace_token);

-- Model calls an agent made through the gateway; request and response bodies are in R2 at calls/<id>.json.
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  run TEXT NOT NULL,
  project TEXT NOT NULL,
  provider TEXT NOT NULL,         -- anthropic | openai
  path TEXT NOT NULL,
  model TEXT,
  status INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  ms INTEGER,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS calls_run ON calls(run, at);

CREATE TABLE IF NOT EXISTS secrets (
  project TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,            -- AES-GCM, base64 iv + ciphertext
  PRIMARY KEY (project, name)
);

-- Files agents keep between runs (tidegate.json "state"), restored before each run and saved after it.
CREATE TABLE IF NOT EXISTS state (
  project TEXT NOT NULL,
  path TEXT NOT NULL,
  blob TEXT NOT NULL,             -- sha256 of the content in R2
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project, path)
);

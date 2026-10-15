-- The run list and the gateway's spend-guard flags (docs/claude-opus/31, "Spend guards"),
-- moved out of the global RunIndex Durable Object (owner, 2026-10-15). Only adds.
--
-- runs: one row per race run or repository engine, the columns RunIndex stored (run,
-- created_at, body: the RunListItem JSON) plus updated_at, so a late write never replaces a
-- newer one. Each RunDO upserts its row in the background when its phase or task counts
-- change; rows are validated when read back. Listed newest first, by (created_at, run).
CREATE TABLE runs (
  run TEXT PRIMARY KEY,
  created_at TEXT NOT NULL, -- ISO 8601, when the run began
  updated_at TEXT NOT NULL, -- ISO 8601, when the row was written
  body TEXT NOT NULL -- RunListItem JSON
);
CREATE INDEX runs_created ON runs (created_at DESC, run DESC);

-- gateway_flags: gateway-wide switches, one row each. `halt` (the kill switch) holds
-- {"reason","at"} while runs are halted; `run_index_backfill` records the one-time copy of
-- RunIndex's rows.
CREATE TABLE gateway_flags (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL, -- JSON
  updated_at INTEGER NOT NULL -- unix milliseconds
);

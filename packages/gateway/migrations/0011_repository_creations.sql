-- Who created which repository, when and through which client (docs/claude-opus/20 §10): the
-- rate limit on creations (20 per person per hour, across the web, `repo_create`, the API and
-- pushes) counts these rows. Unlike `repository_audit` they stay when the repository is
-- deleted, so deleting does not reset the limit. Only adds.
CREATE TABLE repository_creations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('web', 'repo_create', 'api', 'push')),
  at INTEGER NOT NULL -- unix milliseconds
);
CREATE INDEX repository_creations_actor ON repository_creations (actor_id, at);

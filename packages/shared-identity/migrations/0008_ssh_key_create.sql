-- Push-to-create over SSH (docs/claude-opus/20-repositories.md §10). The setup script asks
-- for the `create` scope in its key request (`wants_create`); the approval page shows it,
-- ticked by default, and a key approved with it ticked (`may_create`) carries `create`, as
-- does the HTTPS token setup hands the same machine. Keys added before, or pasted in
-- Settings, keep read and write only. Only adds.
ALTER TABLE ssh_keys ADD COLUMN may_create INTEGER NOT NULL DEFAULT 0 CHECK (may_create IN (0, 1));
ALTER TABLE ssh_key_requests ADD COLUMN wants_create INTEGER NOT NULL DEFAULT 0 CHECK (wants_create IN (0, 1));

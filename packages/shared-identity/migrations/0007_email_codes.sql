-- Email sign-in by six-digit code (docs/claude-opus/19-accounts-and-auth.md §6). Only adds.
-- One row per code sent: the browser that asked holds a random ticket (cookie) whose SHA-256
-- keys the row; the code is stored only as an HMAC under a server secret. Ten minutes, single
-- use, five attempts. Rows live an hour so the per-address hourly cap can count them.
--
-- magic_links (0001) is no longer read or written. It is left in place so a deployment
-- still running older code during a rollout keeps working; a later migration drops it.

CREATE TABLE email_codes (
  ticket_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  purpose TEXT NOT NULL CHECK (purpose IN ('signin', 'add_email')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,  -- add_email: the signed-in person
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX email_codes_email ON email_codes(email, created_at);

/**
 * The server-side commit's idempotency (`server-commit.ts`), in the collaboration tools' table
 * (`collaboration/store.ts`): a key reused with the same input replays the first commit; with
 * other input it is refused. The input is stored as its SHA-256 (a commit may carry 192 KiB
 * of text), with the writer's method (`bean_commit`, `editor_save`). A commit pushes between
 * the lookup and the record; the engine runs one key's tries one at a time (`key-queue.ts`).
 */
import type { BeanCommitted } from '@gitstalk/shared-race/bean-commit';
import { BeanCommitted as BeanCommittedSchema } from '@gitstalk/shared-race/bean-commit';

export type CommitIdentity = {
  /** The key's scope: the bean of `bean_commit`, `save:@<handle>` for the editors. */
  readonly bean: string;
  readonly actor: string;
  readonly key: string;
};

/** What a key was used for: the writer's method and its input, hashed. */
export type CommitPayload = { readonly method: string; readonly input: unknown };

export type Replay =
  | { readonly kind: 'none' }
  | { readonly kind: 'replay'; readonly result: BeanCommitted }
  | { readonly kind: 'mismatch' };

/** The first result of this key, when the key was used before. */
export async function replayedCommit(
  sql: SqlStorage,
  identity: CommitIdentity,
  attempt: CommitPayload,
): Promise<Replay> {
  const payload = await payloadOf(attempt);
  const previous = sql
    .exec<{ payload: string; result: string }>(
      'SELECT payload, result FROM collaboration_idempotency WHERE bean = ? AND key = ?',
      identity.bean,
      identity.key,
    )
    .toArray()[0];
  if (previous === undefined) return { kind: 'none' };
  if (previous.payload !== payload) return { kind: 'mismatch' };
  return { kind: 'replay', result: BeanCommittedSchema.parse(JSON.parse(previous.result)) };
}

/** Records a pushed commit under its key. */
export async function recordCommit(
  sql: SqlStorage,
  identity: CommitIdentity,
  committed: { readonly attempt: CommitPayload; readonly result: BeanCommitted },
): Promise<void> {
  sql.exec(
    'INSERT OR IGNORE INTO collaboration_idempotency (bean, actor, key, payload, result) VALUES (?, ?, ?, ?, ?)',
    identity.bean,
    identity.actor,
    identity.key,
    await payloadOf(committed.attempt),
    JSON.stringify(committed.result),
  );
}

async function payloadOf(attempt: CommitPayload): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(attempt.input));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return JSON.stringify({ method: attempt.method, sha256: hex });
}

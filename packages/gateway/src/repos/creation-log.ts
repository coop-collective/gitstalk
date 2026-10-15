/**
 * The log of repository creations (`migrations/0011_repository_creations.sql`), which the
 * creation rate limit counts: `MAX_CREATIONS_PER_HOUR` per person, whatever the client.
 */
import type { CreationVia } from '@gitstalk/shared-race/repo-create';

export type CreationEntry = {
  readonly actorId: string;
  readonly repoId: string;
  readonly via: CreationVia;
};

export type CreationLog = {
  /** How many repositories the person created since `sinceMs`. */
  countSince(actorId: string, sinceMs: number): Promise<number>;
  record(entry: CreationEntry, nowMs: number): Promise<void>;
};

export function d1CreationLog(db: D1Database): CreationLog {
  return {
    async countSince(actorId, sinceMs) {
      const row = await db
        .prepare('SELECT COUNT(*) AS n FROM repository_creations WHERE actor_id = ? AND at >= ?')
        .bind(actorId, sinceMs)
        .first<{ readonly n: number }>();
      return row?.n ?? 0;
    },
    async record(entry, nowMs) {
      await db
        .prepare(
          'INSERT INTO repository_creations (actor_id, repo_id, via, at) VALUES (?, ?, ?, ?)',
        )
        .bind(entry.actorId, entry.repoId, entry.via, nowMs)
        .run();
    },
  };
}

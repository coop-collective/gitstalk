/**
 * The `RepoDerivedDO`'s SQLite: the sprout's first-parent chain (one row per commit, by its
 * position), each deriver's rows by path and position with how far it has computed, and the
 * facts the repository events tell (bean titles, decision cards, the stalk's head). The
 * engine's own storage is never touched; everything here can be dropped and derived again.
 */
import { z } from 'zod';

import { DerivedCommitKind } from '@gitstalk/shared-race/derived';

/** A commit of the chain as stored. */
export const StoredCommit = z.object({
  seq: z.number().int(),
  sha: z.string(),
  kind: DerivedCommitKind,
  bean: z.string().nullable(),
  title: z.string(),
  /** For a revert or reset: the position whose state it puts back. */
  restores: z.number().int().nullable(),
  at_ms: z.number(),
});
export type StoredCommit = z.infer<typeof StoredCommit>;

export const StoredBean = z.object({
  bean: z.string(),
  title: z.string(),
  actor: z.string().nullable(),
  reverted: z.number().int(),
});
export type StoredBean = z.infer<typeof StoredBean>;

const Head = z.object({ version: z.number().int(), seq: z.number().int() });
export type DeriverHead = z.infer<typeof Head>;
const RowText = z.object({ seq: z.number().int(), row: z.string() });
const Card = z.object({ bean: z.string(), card: z.string() });
const LineHead = z.object({ sha: z.string() });
/** Values bound in one `IN (…)` query (Durable Object SQLite allows 100 parameters). */
const MAX_BOUND = 90;

/** Creates the tables (idempotent; safe in the constructor). */
export function migrateDerivedStore(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS chain (
     seq INTEGER PRIMARY KEY,
     sha TEXT NOT NULL UNIQUE,
     kind TEXT NOT NULL,
     bean TEXT,
     title TEXT NOT NULL,
     restores INTEGER,
     at_ms INTEGER NOT NULL
   )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS deriver_heads (
     name TEXT PRIMARY KEY,
     version INTEGER NOT NULL,
     seq INTEGER NOT NULL
   )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS derived_rows (
     deriver TEXT NOT NULL,
     path TEXT NOT NULL,
     seq INTEGER NOT NULL,
     row TEXT NOT NULL,
     PRIMARY KEY (deriver, path, seq)
   ) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS beans (
     bean TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     actor TEXT,
     reverted INTEGER NOT NULL DEFAULT 0
   )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS decision_beans (
     card TEXT NOT NULL,
     bean TEXT NOT NULL,
     PRIMARY KEY (card, bean)
   ) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS line_heads (name TEXT PRIMARY KEY, sha TEXT NOT NULL)`);
}

export function commitBySha(sql: SqlStorage, sha: string): StoredCommit | null {
  const [row] = sql.exec('SELECT * FROM chain WHERE sha = ?', sha).toArray();
  return row === undefined ? null : StoredCommit.parse(row);
}

/** The chain's commits at these positions. */
export function commitsAt(sql: SqlStorage, seqs: readonly number[]): StoredCommit[] {
  return selectIn(sql, 'SELECT * FROM chain WHERE seq IN', seqs).map((row) =>
    StoredCommit.parse(row),
  );
}

/** The chain's newest commit, or null before anything was derived. */
export function chainTip(sql: SqlStorage): StoredCommit | null {
  const [row] = sql.exec('SELECT * FROM chain ORDER BY seq DESC LIMIT 1').toArray();
  return row === undefined ? null : StoredCommit.parse(row);
}

export function appendCommits(sql: SqlStorage, commits: readonly StoredCommit[]): void {
  for (const commit of commits)
    sql.exec(
      'INSERT INTO chain (seq, sha, kind, bean, title, restores, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
      commit.seq,
      commit.sha,
      commit.kind,
      commit.bean,
      commit.title,
      commit.restores,
      commit.at_ms,
    );
}

/** Drops the chain and every derived row (the line was rewritten); facts from events stay. */
export function clearChain(sql: SqlStorage): void {
  sql.exec('DELETE FROM chain');
  sql.exec('DELETE FROM derived_rows');
  sql.exec('DELETE FROM deriver_heads');
}

/**
 * How far a deriver has computed. A stored version other than `version` (the code changed
 * how it derives) drops its rows first, so it is computed again from the base.
 */
export function deriverHead(sql: SqlStorage, name: string, version: number): DeriverHead {
  const [row] = sql.exec('SELECT version, seq FROM deriver_heads WHERE name = ?', name).toArray();
  const head = row === undefined ? null : Head.parse(row);
  if (head !== null && head.version === version) return head;
  sql.exec('DELETE FROM derived_rows WHERE deriver = ?', name);
  return setDeriverHead(sql, name, { version, seq: 0 });
}

export function setDeriverHead(sql: SqlStorage, name: string, head: DeriverHead): DeriverHead {
  sql.exec(
    `INSERT INTO deriver_heads (name, version, seq) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET version = excluded.version, seq = excluded.seq`,
    name,
    head.version,
    head.seq,
  );
  return head;
}

/** Writes a deriver's rows for one position (a recomputed position replaces its rows). */
export function writeRows(
  sql: SqlStorage,
  input: { readonly deriver: string; readonly seq: number },
  rows: readonly { readonly path: string; readonly row: string }[],
): void {
  for (const { path, row } of rows)
    sql.exec(
      'INSERT OR REPLACE INTO derived_rows (deriver, path, seq, row) VALUES (?, ?, ?, ?)',
      input.deriver,
      path,
      input.seq,
      row,
    );
}

/** The deriver's newest row for a path at or before a position, as stored JSON text. */
export function rowAt(
  sql: SqlStorage,
  deriver: string,
  at: { readonly path: string; readonly seq: number },
): string | null {
  const [row] = sql
    .exec(
      'SELECT seq, row FROM derived_rows WHERE deriver = ? AND path = ? AND seq <= ? ORDER BY seq DESC LIMIT 1',
      deriver,
      at.path,
      at.seq,
    )
    .toArray();
  return row === undefined ? null : RowText.parse(row).row;
}

/** The deriver's rows for a path at or before a position, newest first, at most `limit`. */
export function rowsUpTo(
  sql: SqlStorage,
  deriver: string,
  at: { readonly path: string; readonly seq: number; readonly limit: number },
): { readonly seq: number; readonly row: string }[] {
  return sql
    .exec(
      'SELECT seq, row FROM derived_rows WHERE deriver = ? AND path = ? AND seq <= ? ORDER BY seq DESC LIMIT ?',
      deriver,
      at.path,
      at.seq,
      at.limit,
    )
    .toArray()
    .map((row) => RowText.parse(row));
}

/** A bean's title and actor, as its `bean.opened` event told them (a later one wins). */
export function recordBean(
  sql: SqlStorage,
  bean: { readonly bean: string; readonly title: string; readonly actor: string | null },
): void {
  sql.exec(
    `INSERT INTO beans (bean, title, actor) VALUES (?, ?, ?)
     ON CONFLICT (bean) DO UPDATE SET title = excluded.title, actor = excluded.actor`,
    bean.bean,
    bean.title,
    bean.actor,
  );
}

export function markReverted(sql: SqlStorage, bean: string): void {
  sql.exec(
    `INSERT INTO beans (bean, title, reverted) VALUES (?, '', 1)
     ON CONFLICT (bean) DO UPDATE SET reverted = 1`,
    bean,
  );
}

export function recordDecision(sql: SqlStorage, card: string, beans: readonly string[]): void {
  for (const bean of beans)
    sql.exec('INSERT OR IGNORE INTO decision_beans (card, bean) VALUES (?, ?)', card, bean);
}

export function beansNamed(sql: SqlStorage, beans: readonly string[]): StoredBean[] {
  return selectIn(sql, 'SELECT * FROM beans WHERE bean IN', beans).map((row) =>
    StoredBean.parse(row),
  );
}

/** Decision cards by bean, for these beans. */
export function cardsOf(sql: SqlStorage, beans: readonly string[]): Map<string, string[]> {
  const cards = new Map<string, string[]>();
  for (const row of selectIn(sql, 'SELECT bean, card FROM decision_beans WHERE bean IN', beans)) {
    const { bean, card } = Card.parse(row);
    cards.set(bean, [...(cards.get(bean) ?? []), card]);
  }
  return cards;
}

/** A line the events move. */
export type LineName = 'sprout' | 'stalk';

export function setLineHead(sql: SqlStorage, name: LineName, sha: string): void {
  sql.exec(
    'INSERT INTO line_heads (name, sha) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET sha = excluded.sha',
    name,
    sha,
  );
}

export function lineHead(sql: SqlStorage, name: LineName): string | null {
  const [row] = sql.exec('SELECT sha FROM line_heads WHERE name = ?', name).toArray();
  return row === undefined ? null : LineHead.parse(row).sha;
}

/** `query (?, ?, …)` over `values`, in chunks under SQLite's bound-parameter limit. */
function selectIn(
  sql: SqlStorage,
  query: string,
  values: readonly (string | number)[],
): Record<string, SqlStorageValue>[] {
  const unique = [...new Set(values)];
  const rows: Record<string, SqlStorageValue>[] = [];
  for (let start = 0; start < unique.length; start += MAX_BOUND) {
    const chunk = unique.slice(start, start + MAX_BOUND);
    const marks = chunk.map(() => '?').join(', ');
    rows.push(...sql.exec(`${query} (${marks})`, ...chunk).toArray());
  }
  return rows;
}

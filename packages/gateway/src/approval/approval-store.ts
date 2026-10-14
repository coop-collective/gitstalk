/**
 * What an engine remembers about approval rules, in its RunDO's SQLite: each bean's latest
 * route receipt (with the fingerprint of the change it judged, so a re-check of the same
 * change reuses a triage instead of asking Clef again), and the approvals people gave, per
 * bean revision (its pushed head; '' in a race, where beans have no pushes).
 */
import { RouteReceipt } from '@gitstalk/shared-race/approval-policy';

const KEPT_ROWS = 1000;

/** A person's approval of one bean revision. */
export type Approval = { readonly actor: string; readonly atMs: number };

export function migrateApprovalStore(sql: SqlStorage): void {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS bean_routes (bean TEXT PRIMARY KEY, receipt TEXT NOT NULL, fingerprint TEXT NOT NULL, at INTEGER NOT NULL)',
  );
  sql.exec(
    'CREATE TABLE IF NOT EXISTS bean_approvals (bean TEXT NOT NULL, revision TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (bean, revision))',
  );
}

export function saveRoute(
  sql: SqlStorage,
  entry: { readonly receipt: RouteReceipt; readonly fingerprint: string },
): void {
  sql.exec(
    'INSERT OR REPLACE INTO bean_routes (bean, receipt, fingerprint, at) VALUES (?, ?, ?, ?)',
    entry.receipt.bean,
    JSON.stringify(entry.receipt),
    entry.fingerprint,
    entry.receipt.at,
  );
  sql.exec(
    'DELETE FROM bean_routes WHERE bean NOT IN (SELECT bean FROM bean_routes ORDER BY at DESC LIMIT ?)',
    KEPT_ROWS,
  );
}

/** The bean's latest receipt and the fingerprint it judged; null when it was never routed. */
export function readRoute(
  sql: SqlStorage,
  bean: string,
): { readonly receipt: RouteReceipt; readonly fingerprint: string } | null {
  const row = sql
    .exec<{ receipt: string; fingerprint: string }>(
      'SELECT receipt, fingerprint FROM bean_routes WHERE bean = ?',
      bean,
    )
    .toArray()[0];
  if (row === undefined) return null;
  const receipt = RouteReceipt.safeParse(JSON.parse(row.receipt));
  return receipt.success ? { receipt: receipt.data, fingerprint: row.fingerprint } : null;
}

export function saveApproval(
  sql: SqlStorage,
  entry: { readonly bean: string; readonly revision: string | null; readonly approval: Approval },
): void {
  sql.exec(
    'INSERT OR REPLACE INTO bean_approvals (bean, revision, actor, at) VALUES (?, ?, ?, ?)',
    entry.bean,
    entry.revision ?? '',
    entry.approval.actor,
    entry.approval.atMs,
  );
}

export function readApproval(
  sql: SqlStorage,
  bean: string,
  revision: string | null,
): Approval | null {
  const row = sql
    .exec<{ actor: string; at: number }>(
      'SELECT actor, at FROM bean_approvals WHERE bean = ? AND revision = ?',
      bean,
      revision ?? '',
    )
    .toArray()[0];
  return row === undefined ? null : { actor: row.actor, atMs: row.at };
}

/**
 * What an engine remembers about approval rules, in its RunDO's SQLite: each bean's latest
 * route receipt (with the fingerprint of the change it judged, so a re-check of the same
 * change reuses a triage instead of asking Clef again), and the approvals people gave, per
 * bean revision (its pushed head; '' in a race, where beans have no pushes), with the note,
 * the client it came through and its idempotency key beside them (`bean_approval_notes`, a
 * table of its own so engines that already have `bean_approvals` need no column migration).
 */
import { RouteReceipt } from '@gitstalk/shared-race/approval-policy';

const KEPT_ROWS = 1000;

/** A person's approval of one bean revision. */
export type Approval = {
  readonly actor: string;
  readonly atMs: number;
  readonly note: string | null;
  /** `web` or `MCP (<client>)`; '' for approvals stored before it was kept. */
  readonly client: string;
  readonly idempotencyKey: string | null;
};

export function migrateApprovalStore(sql: SqlStorage): void {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS bean_routes (bean TEXT PRIMARY KEY, receipt TEXT NOT NULL, fingerprint TEXT NOT NULL, at INTEGER NOT NULL)',
  );
  sql.exec(
    'CREATE TABLE IF NOT EXISTS bean_approvals (bean TEXT NOT NULL, revision TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (bean, revision))',
  );
  sql.exec(
    'CREATE TABLE IF NOT EXISTS bean_approval_notes (bean TEXT NOT NULL, revision TEXT NOT NULL, note TEXT, client TEXT NOT NULL, idempotency_key TEXT, PRIMARY KEY (bean, revision))',
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
  sql.exec(
    'INSERT OR REPLACE INTO bean_approval_notes (bean, revision, note, client, idempotency_key) VALUES (?, ?, ?, ?, ?)',
    entry.bean,
    entry.revision ?? '',
    entry.approval.note,
    entry.approval.client,
    entry.approval.idempotencyKey,
  );
}

const APPROVAL_COLUMNS =
  'a.revision, a.actor, a.at, n.note, n.client, n.idempotency_key FROM bean_approvals a LEFT JOIN bean_approval_notes n ON n.bean = a.bean AND n.revision = a.revision';

type ApprovalRow = {
  revision: string;
  actor: string;
  at: number;
  note: string | null;
  client: string | null;
  idempotency_key: string | null;
};

export function readApproval(
  sql: SqlStorage,
  bean: string,
  revision: string | null,
): Approval | null {
  const row = sql
    .exec<ApprovalRow>(
      `SELECT ${APPROVAL_COLUMNS} WHERE a.bean = ? AND a.revision = ?`,
      bean,
      revision ?? '',
    )
    .toArray()[0];
  return row === undefined ? null : approvalOf(row);
}

/** The approval of `bean` that idempotency key `key` made, and its revision; null when none. */
export function readApprovalByKey(
  sql: SqlStorage,
  bean: string,
  key: string,
): { readonly revision: string; readonly approval: Approval } | null {
  const row = sql
    .exec<ApprovalRow>(
      `SELECT ${APPROVAL_COLUMNS} WHERE a.bean = ? AND n.idempotency_key = ?`,
      bean,
      key,
    )
    .toArray()[0];
  return row === undefined ? null : { revision: row.revision, approval: approvalOf(row) };
}

function approvalOf(row: ApprovalRow): Approval {
  return {
    actor: row.actor,
    atMs: row.at,
    note: row.note,
    client: row.client ?? '',
    idempotencyKey: row.idempotency_key,
  };
}

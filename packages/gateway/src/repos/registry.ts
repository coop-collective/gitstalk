/**
 * The repository registry in D1 (`migrations/0001_repositories.sql`): records, the per-owner
 * name uniqueness (a unique index on the lower-cased name), each repository's own history and
 * its old addresses (`0009`: a rename or a transfer leaves a redirect, `resolve` follows it).
 * D1 rather than a Durable Object because every read here is a cross-repository index (an
 * owner's list, a handle and name lookup, activity across repositories) and the uniqueness
 * is one index; the engine's hot state stays in its own Durable Object.
 */
import { assertNever } from '../engine/errors';
import { z } from 'zod';

import type { IdentityEnv } from '@gitstalk/shared-identity/identity-env';
import { resolveRetiredHandle } from '@gitstalk/shared-identity/profiles';

import type {
  RepoOrigin,
  RepoOwner,
  RepoOwnerKind,
  RepoVisibility,
  RepositoryActivity,
  RepositoryListing,
  RepositoryRecord,
} from '@gitstalk/shared-race/repos';

import { activityOf, activityQuery, indexDeletes } from '../repo-events/index-store';

/** What creating a record needs; the registry stamps the times. */
export type NewRepository = {
  readonly id: string;
  readonly owner: RepoOwner;
  readonly ownerKind: RepoOwnerKind;
  readonly name: string;
  readonly description: string;
  readonly visibility: RepoVisibility;
  readonly origin: RepoOrigin;
  readonly artifactsRepo: string;
  readonly engineId: string;
};

export type RegistryPatch = {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly visibility?: RepoVisibility | undefined;
  readonly website?: string | undefined;
  readonly topics?: readonly string[] | undefined;
  readonly social_image_key?: string | null | undefined;
};

export type Registry = {
  /** Reserves the name; false when the owner already has a repository by that name. */
  reserve(repo: NewRepository, nowMs: number): Promise<boolean>;
  /** Marks a reserved repository ready, with its engine, and records its creation. */
  markReady(id: string, engineId: string, nowMs: number): Promise<RepositoryRecord | null>;
  /**
   * A repository created empty whose first push became its stalk: its new engine and origin,
   * with an activity line; null when it is missing.
   */
  restart(
    id: string,
    start: { readonly engineId: string; readonly origin: RepoOrigin },
    nowMs: number,
  ): Promise<RepositoryRecord | null>;
  byId(id: string): Promise<RepositoryRecord | null>;
  /** The repository at `/<owner>/<name>` now; old addresses are `resolve`'s. */
  byName(ownerHandle: string, name: string): Promise<RepositoryRecord | null>;
  /**
   * The repository an address names, now or before: its current name, else a redirect left by
   * a rename or a transfer (chains end at the current name), else the same through the
   * owner's new handle when `ownerHandle` is one they retired. Every lookup by address (git
   * over HTTPS and SSH, MCP, the web) goes through here, so old remotes keep working.
   */
  resolve(ownerHandle: string, name: string): Promise<RepositoryRecord | null>;
  /** The repository an engine drives, whatever its name is now. */
  byEngine(engineId: string): Promise<RepositoryRecord | null>;
  /** The owner's active repositories (default) or archived ones, newest first. */
  byOwner(ownerId: string, listing?: RepositoryListing): Promise<readonly RepositoryRecord[]>;
  /** The ready repositories among `ids`, in no particular order. */
  byIds(ids: readonly string[]): Promise<readonly RepositoryRecord[]>;
  /** Applies the patch; 'taken' when a rename collides, null when the repository is missing. */
  update(
    id: string,
    patch: RegistryPatch,
    nowMs: number,
  ): Promise<RepositoryRecord | 'taken' | null>;
  /** Archives (`archived`) or unarchives (`active`), with its activity line; null when missing. */
  setListing(id: string, to: RepositoryListing, nowMs: number): Promise<RepositoryRecord | null>;
  remove(id: string): Promise<void>;
  /**
   * Moves a repository to another owner (a person or an org), with its activity line: 'taken'
   * when the new owner has one by that name, null when it is missing. A person who receives a
   * repository stops being its collaborator (they own it now). The old address redirects; an
   * internal repository moved to a person becomes private (only orgs have internal ones).
   */
  transfer(
    id: string,
    to: { readonly kind: RepoOwnerKind; readonly id: string; readonly handle: string },
    nowMs: number,
  ): Promise<RepositoryRecord | 'taken' | null>;
  /**
   * Activity in the person's repositories, their own and those shared with them: the
   * registry's lines and the engines' (written by the `repo-events` consumer), newest first.
   * `orgIds`: orgs whose every repository they read (their role or base permission);
   * `memberOrgIds`: orgs whose internal repositories they read (any membership).
   */
  activity(
    userId: string,
    limit: number,
    orgIds?: readonly string[],
    memberOrgIds?: readonly string[],
  ): Promise<readonly RepositoryActivity[]>;
};

const MAX_ACTIVITY = 100;

const Row = z.object({
  id: z.string(),
  owner_id: z.string(),
  owner_handle: z.string(),
  owner_kind: z.enum(['user', 'org']).default('user'),
  name: z.string(),
  description: z.string(),
  visibility: z.enum(['public', 'private']),
  /** 0009: 1 for an internal repository (stored with visibility 'private'). */
  internal: z.number().default(0),
  origin_json: z.string(),
  artifacts_repo: z.string(),
  engine_id: z.string(),
  default_branch: z.string(),
  state: z.enum(['provisioning', 'ready']),
  created_at: z.string(),
  updated_at: z.string(),
  archived_at: z.string().nullable(),
  website: z.string().default(''),
  topics_json: z.string().default('[]'),
  social_image_key: z.string().nullable().default(null),
});

const Topics = z.array(z.string());

const Origin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('empty'), first_push: z.literal('becomes-stalk').optional() }),
  z.object({ kind: z.literal('template'), template: z.enum(['typescript-starter']) }),
  z.object({ kind: z.literal('import'), url: z.string() }),
  z.object({ kind: z.literal('push'), ref: z.string() }),
]);

const SELECT = 'SELECT * FROM repositories';

/**
 * The registry on the forge database. `identity` (IDENTITY_DB) lets `resolve` follow a
 * retired handle to the person's new one; without it old handles resolve only through
 * redirects recorded under them.
 */
export function d1Registry(db: D1Database, identity?: IdentityEnv): Registry {
  const one = async (sql: string, ...values: unknown[]): Promise<RepositoryRecord | null> => {
    const row = await db
      .prepare(sql)
      .bind(...values)
      .first();
    return row === null ? null : recordOf(row);
  };
  const byName = (ownerHandle: string, name: string): Promise<RepositoryRecord | null> =>
    one(
      `${SELECT} WHERE owner_handle = ? AND name_key = ? AND state = 'ready'`,
      ownerHandle,
      name.toLowerCase(),
    );
  const redirected = (ownerHandle: string, name: string): Promise<RepositoryRecord | null> =>
    one(
      `SELECT r.* FROM repository_redirects d JOIN repositories r ON r.id = d.repo_id
       WHERE d.owner_handle = ? AND d.name_key = ? AND r.state = 'ready'`,
      ownerHandle,
      name.toLowerCase(),
    );
  const at = async (ownerHandle: string, name: string): Promise<RepositoryRecord | null> =>
    (await byName(ownerHandle, name)) ?? redirected(ownerHandle, name);
  return {
    async reserve(repo, nowMs) {
      const at = iso(nowMs);
      const stored = storedVisibility(repo.visibility);
      try {
        await db.batch([
          db
            .prepare(
              `INSERT INTO repositories (id, owner_id, owner_handle, owner_kind, name, name_key,
                 description, visibility, internal, origin_json, artifacts_repo, engine_id, state,
                 created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?)`,
            )
            .bind(
              repo.id,
              repo.owner.id,
              repo.owner.handle,
              repo.ownerKind,
              repo.name,
              repo.name.toLowerCase(),
              repo.description,
              stored.visibility,
              stored.internal,
              JSON.stringify(repo.origin),
              repo.artifactsRepo,
              repo.engineId,
              at,
              at,
            ),
          // A new repository at an old address takes it over: the redirect is dropped.
          dropRedirect(db, repo.owner.handle, repo.name),
        ]);
        return true;
      } catch (error: unknown) {
        if (isUniqueViolation(error)) return false;
        throw error;
      }
    },
    async markReady(id, engineId, nowMs) {
      const record = await one(`${SELECT} WHERE id = ?`, id);
      if (record === null) return null;
      const at = iso(nowMs);
      await db.batch([
        db
          .prepare(
            `UPDATE repositories SET state = 'ready', engine_id = ?, updated_at = ? WHERE id = ?`,
          )
          .bind(engineId, at, id),
        activityInsert(db, record, at, 'created', createdText(record.origin)),
      ]);
      return { ...record, engine_id: engineId, updated_at: at };
    },
    async restart(id, start, nowMs) {
      const record = await one(`${SELECT} WHERE id = ? AND state = 'ready'`, id);
      if (record === null) return null;
      const at = iso(nowMs);
      const restarted = {
        ...record,
        engine_id: start.engineId,
        origin: start.origin,
        updated_at: at,
      };
      await db.batch([
        db
          .prepare(
            'UPDATE repositories SET engine_id = ?, origin_json = ?, updated_at = ? WHERE id = ?',
          )
          .bind(start.engineId, JSON.stringify(start.origin), at, id),
        activityInsert(db, restarted, at, 'created', createdText(start.origin)),
      ]);
      return restarted;
    },
    byId: (id) => one(`${SELECT} WHERE id = ? AND state = 'ready'`, id),
    byName,
    async resolve(ownerHandle, name) {
      const found = await at(ownerHandle, name);
      if (found !== null || identity === undefined) return found;
      // An owner who changed handle: the same name (or its redirect) under the new handle.
      const current = await resolveRetiredHandle(identity, ownerHandle);
      return current === null ? null : at(current, name);
    },
    byEngine: (engineId) => one(`${SELECT} WHERE engine_id = ? AND state = 'ready'`, engineId),
    async byOwner(ownerId, listing = 'active') {
      const archived = listing === 'archived' ? 'IS NOT NULL' : 'IS NULL';
      const { results } = await db
        .prepare(
          `${SELECT} WHERE owner_id = ? AND state = 'ready' AND archived_at ${archived}
           ORDER BY created_at DESC, id`,
        )
        .bind(ownerId)
        .all();
      return results.map(recordOf);
    },
    async byIds(ids) {
      if (ids.length === 0) return [];
      const { results } = await db
        .prepare(`${SELECT} WHERE state = 'ready' AND id IN (SELECT value FROM json_each(?))`)
        .bind(JSON.stringify(ids))
        .all();
      return results.map(recordOf);
    },
    async update(id, patch, nowMs) {
      const before = await one(`${SELECT} WHERE id = ? AND state = 'ready'`, id);
      if (before === null) return null;
      const after: RepositoryRecord = {
        ...before,
        name: patch.name ?? before.name,
        description: patch.description ?? before.description,
        visibility: patch.visibility ?? before.visibility,
        website: patch.website ?? before.website ?? '',
        topics: patch.topics ?? before.topics ?? [],
        social_image_key:
          patch.social_image_key === undefined
            ? (before.social_image_key ?? null)
            : patch.social_image_key,
        updated_at: iso(nowMs),
      };
      const stored = storedVisibility(after.visibility);
      const isRenamed = before.name.toLowerCase() !== after.name.toLowerCase();
      try {
        await db.batch([
          db
            .prepare(
              `UPDATE repositories SET name = ?, name_key = ?, description = ?, visibility = ?,
                 internal = ?, website = ?, topics_json = ?, social_image_key = ?, updated_at = ?
               WHERE id = ?`,
            )
            .bind(
              after.name,
              after.name.toLowerCase(),
              after.description,
              stored.visibility,
              stored.internal,
              after.website ?? '',
              JSON.stringify(after.topics ?? []),
              after.social_image_key ?? null,
              after.updated_at,
              id,
            ),
          ...(isRenamed ? moveStatements(db, before, after) : []),
          ...changes(before, after).map((change) =>
            activityInsert(db, after, after.updated_at, change.kind, change.text),
          ),
        ]);
      } catch (error: unknown) {
        if (isUniqueViolation(error)) return 'taken';
        throw error;
      }
      return after;
    },
    async setListing(id, to, nowMs) {
      const before = await one(`${SELECT} WHERE id = ? AND state = 'ready'`, id);
      if (before === null) return null;
      const isArchived = before.archived_at !== null;
      if (isArchived === (to === 'archived')) return before;
      const at = iso(nowMs);
      const after: RepositoryRecord = {
        ...before,
        archived_at: to === 'archived' ? at : null,
        updated_at: at,
      };
      await db.batch([
        db
          .prepare('UPDATE repositories SET archived_at = ?, updated_at = ? WHERE id = ?')
          .bind(after.archived_at, at, id),
        to === 'archived'
          ? activityInsert(db, after, at, 'archived', 'Archived: read-only, pushes refused.')
          : activityInsert(db, after, at, 'unarchived', 'Unarchived: pushes are accepted again.'),
      ]);
      return after;
    },
    async remove(id) {
      await db.batch([
        ...indexDeletes(db, id),
        db.prepare('DELETE FROM repository_redirects WHERE repo_id = ?').bind(id),
        db.prepare('DELETE FROM repository_activity WHERE repo_id = ?').bind(id),
        db.prepare('DELETE FROM deploy_tokens WHERE repo_id = ?').bind(id),
        db.prepare('DELETE FROM repository_members WHERE repo_id = ?').bind(id),
        db.prepare('DELETE FROM repository_invitations WHERE repo_id = ?').bind(id),
        db.prepare('DELETE FROM repository_sessions WHERE repo_id = ?').bind(id),
        db.prepare('DELETE FROM repository_audit WHERE repo_id = ?').bind(id),
        ...actionsDeletes(db, id),
        db.prepare('DELETE FROM repositories WHERE id = ?').bind(id),
      ]);
    },
    async activity(userId, limit, orgIds = [], memberOrgIds = []) {
      const { results } = await activityQuery(
        db,
        `(a.owner_id = ?1 OR a.repo_id IN (SELECT repo_id FROM repository_members WHERE user_id = ?1)
          OR r.owner_id IN (SELECT value FROM json_each(?2))
          OR (r.internal = 1 AND r.owner_id IN (SELECT value FROM json_each(?3))))
         AND r.state = 'ready'`,
      )
        .bind(
          userId,
          JSON.stringify(orgIds),
          JSON.stringify(memberOrgIds),
          Math.max(1, Math.min(MAX_ACTIVITY, Math.trunc(limit))),
        )
        .all();
      return results.map(activityOf);
    },
    async transfer(id, to, nowMs) {
      const before = await one(`${SELECT} WHERE id = ? AND state = 'ready'`, id);
      if (before === null) return null;
      const at = iso(nowMs);
      // Only orgs have internal repositories: moved to a person, it becomes private (as GitHub).
      const becomesPrivate = to.kind === 'user' && before.visibility === 'internal';
      const after: RepositoryRecord = {
        ...before,
        owner: { id: to.id, handle: to.handle },
        owner_kind: to.kind,
        visibility: becomesPrivate ? 'private' : before.visibility,
        updated_at: at,
      };
      const stored = storedVisibility(after.visibility);
      try {
        await db.batch([
          db
            .prepare(
              `UPDATE repositories SET owner_id = ?, owner_handle = ?, owner_kind = ?, visibility = ?,
                 internal = ?, updated_at = ?
               WHERE id = ?`,
            )
            .bind(to.id, to.handle, to.kind, stored.visibility, stored.internal, at, id),
          ...moveStatements(db, before, after),
          db
            .prepare('UPDATE repository_activity SET owner_id = ? WHERE repo_id = ?')
            .bind(to.id, id),
          db.prepare('UPDATE deploy_tokens SET owner_id = ? WHERE repo_id = ?').bind(to.id, id),
          db
            .prepare('DELETE FROM repository_members WHERE repo_id = ? AND user_id = ?')
            .bind(id, to.id),
          db
            .prepare('DELETE FROM repository_invitations WHERE repo_id = ? AND invitee_id = ?')
            .bind(id, to.id),
          activityInsert(
            db,
            after,
            at,
            'transferred',
            `Transferred from ${before.owner.handle} to ${to.handle}.`,
          ),
          ...(becomesPrivate
            ? [
                activityInsert(
                  db,
                  after,
                  at,
                  'visibility',
                  'Made private: only organizations have internal repositories.',
                ),
              ]
            : []),
        ]);
      } catch (error: unknown) {
        if (isUniqueViolation(error)) return 'taken';
        throw error;
      }
      return after;
    },
  };
}

function recordOf(row: unknown): RepositoryRecord {
  const parsed = Row.parse(row);
  return {
    id: parsed.id,
    owner: { id: parsed.owner_id, handle: parsed.owner_handle },
    owner_kind: parsed.owner_kind,
    name: parsed.name,
    description: parsed.description,
    visibility: parsed.internal === 1 ? 'internal' : parsed.visibility,
    origin: Origin.parse(JSON.parse(parsed.origin_json)),
    artifacts_repo: parsed.artifacts_repo,
    engine_id: parsed.engine_id,
    default_branch: parsed.default_branch,
    created_at: parsed.created_at,
    updated_at: parsed.updated_at,
    archived_at: parsed.archived_at,
    website: parsed.website,
    topics: Topics.parse(JSON.parse(parsed.topics_json)),
    social_image_key: parsed.social_image_key,
  };
}

/**
 * How a visibility is stored: 0001's CHECK allows only public and private, so internal is
 * private with `internal = 1` (an older gateway reads it as private: it fails closed).
 */
function storedVisibility(visibility: RepoVisibility): {
  readonly visibility: 'public' | 'private';
  readonly internal: 0 | 1;
} {
  return visibility === 'internal'
    ? { visibility: 'private', internal: 1 }
    : { visibility, internal: 0 };
}

/**
 * A repository leaving `before`'s address for `after`'s (a rename or a transfer): the old
 * address redirects to it, and a redirect that pointed at the new address is dropped (the
 * repository is there now). Earlier redirects already point at the id, so chains still land.
 */
function moveStatements(
  db: D1Database,
  before: RepositoryRecord,
  after: RepositoryRecord,
): D1PreparedStatement[] {
  return [
    dropRedirect(db, after.owner.handle, after.name),
    db
      .prepare(
        `INSERT OR REPLACE INTO repository_redirects (owner_handle, name_key, owner_id, repo_id,
           created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        before.owner.handle,
        before.name.toLowerCase(),
        before.owner.id,
        before.id,
        after.updated_at,
      ),
  ];
}

/** Forgets the redirect at an address: a repository is (or will be) there now. */
function dropRedirect(db: D1Database, ownerHandle: string, name: string): D1PreparedStatement {
  return db
    .prepare('DELETE FROM repository_redirects WHERE owner_handle = ? AND name_key = ?')
    .bind(ownerHandle, name.toLowerCase());
}

type Change = { readonly kind: RepositoryActivity['kind']; readonly text: string };

function changes(before: RepositoryRecord, after: RepositoryRecord): Change[] {
  const out: Change[] = [];
  if (before.name !== after.name)
    out.push({ kind: 'renamed', text: `Renamed from ${before.name}.` });
  if (before.description !== after.description)
    out.push({ kind: 'described', text: 'Description changed.' });
  if (before.visibility !== after.visibility)
    out.push({ kind: 'visibility', text: `Made ${after.visibility}.` });
  if (
    before.website !== after.website ||
    JSON.stringify(before.topics) !== JSON.stringify(after.topics) ||
    before.social_image_key !== after.social_image_key
  )
    out.push({ kind: 'described', text: 'Profile changed: website, topics or social image.' });
  return out;
}

function createdText(origin: RepoOrigin): string {
  switch (origin.kind) {
    case 'empty':
      return origin.first_push === undefined
        ? 'Created with a README.'
        : 'Created empty: its first push becomes the stalk.';
    case 'template':
      return 'Created from the TypeScript starter.';
    case 'import':
      return `Imported from ${origin.url}.`;
    case 'push':
      return `Created by a push of ${origin.ref}.`;
    default:
      return assertNever(origin);
  }
}

function activityInsert(
  db: D1Database,
  record: RepositoryRecord,
  at: string,
  kind: RepositoryActivity['kind'],
  text: string,
): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO repository_activity (repo_id, owner_id, at, kind, text) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(record.id, record.owner.id, at, kind, text);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * The repository's Actions rows: workflow index, run list, secrets (encrypted, but no reason to
 * keep), variables, job tokens, and its place in org secrets' and variables' repository lists.
 */
function actionsDeletes(db: D1Database, repoId: string): D1PreparedStatement[] {
  return [
    'actions_workflows',
    'actions_runs',
    'actions_secrets',
    'actions_variables',
    'actions_job_tokens',
    'actions_org_entry_repos',
  ].map((table) => db.prepare(`DELETE FROM ${table} WHERE repo_id = ?`).bind(repoId));
}

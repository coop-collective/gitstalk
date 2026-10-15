/**
 * Collaborators in D1 (`migrations/0003_collaborators.sql`): members and their roles, pending
 * invitations, the credentials that acted on a repository, and its access audit log. Storage
 * only: who may change what is decided by `mayUseEngine` in the RPC (`collaborators-rpc.ts`).
 */
import type { IdentityEnv } from '@gitstalk/shared-identity/identity-env';
import type { OrgStanding } from '@gitstalk/shared-identity/orgs';
import { orgStanding } from '@gitstalk/shared-identity/orgs';
import { randomId } from '@gitstalk/shared-identity/secrets';
import type {
  Collaborator,
  Invitation,
  RepoRole,
  RepositoryAuditAction,
  RepositoryAuditEvent,
  RepositorySession,
  SessionVia,
} from '@gitstalk/shared-race/collaborators';
import { RepoRole as RepoRoleSchema } from '@gitstalk/shared-race/collaborators';
import { z } from 'zod';

/** Invitations wait two weeks for an answer. */
export const INVITATION_DAYS = 14;
const DAY_MS = 24 * 3600 * 1000;
/** Reads are stamped at most once a minute per credential. */
const READ_STAMP_MS = 60_000;
const LIST_LIMIT = 50;

export type Person = { readonly id: string; readonly handle: string };

/** One audit line, written in the same batch as the change it describes. */
export type AuditEntry = {
  readonly repoId: string;
  readonly actor: Person;
  readonly action: RepositoryAuditAction;
  readonly target?: Person;
  readonly detail?: string;
};

/** A credential's use of a repository, for "People on the repo". */
export type SessionUse = {
  readonly repoId: string;
  readonly user: Person;
  readonly via: SessionVia;
  /** The token id, key id or client: with `via`, the row's key. */
  readonly credentialId: string;
  /** Empty when the name is looked up when listing (tokens and keys keep their own names). */
  readonly label: string;
  readonly action: 'read' | 'push';
};

export type CollaboratorStore = {
  roleOf(repoId: string, userId: string): Promise<RepoRole | null>;
  /** A person's role in the org that owns a repository, with its base permission (IDENTITY_DB). */
  orgStanding(orgId: string, userId: string): Promise<OrgStanding | null>;
  members(repoId: string): Promise<readonly Collaborator[]>;
  setRole(
    repoId: string,
    member: { readonly user: Person; readonly role: RepoRole; readonly by: Person },
    audit: AuditEntry,
  ): Promise<Collaborator>;
  removeMember(repoId: string, userId: string, audit: AuditEntry): Promise<boolean>;
  invite(
    input: {
      readonly repo: { readonly id: string; readonly ownerHandle: string; readonly name: string };
      readonly invitee: Person;
      readonly role: RepoRole;
      readonly by: Person;
    },
    audit: AuditEntry,
  ): Promise<Invitation>;
  invitation(id: string): Promise<Invitation | null>;
  invitationsFor(userId: string): Promise<readonly Invitation[]>;
  pendingFor(repoId: string): Promise<readonly Invitation[]>;
  /** Removes an invitation (declined, cancelled); false when it was not there. */
  dropInvitation(id: string, audit: AuditEntry): Promise<boolean>;
  /** Makes the invitee a member with the invited role, and removes the invitation. */
  acceptInvitation(invitation: Invitation, audit: AuditEntry): Promise<void>;
  /** Repository ids where this person is a member, newest membership first. */
  memberships(userId: string): Promise<readonly { repoId: string; role: RepoRole }[]>;
  recordUse(use: SessionUse): Promise<void>;
  sessions(repoId: string): Promise<readonly StoredSession[]>;
  audit(repoId: string): Promise<readonly RepositoryAuditEvent[]>;
  /** The statement that writes an audit line, for batching with other registry changes. */
  auditStatement(entry: AuditEntry): D1PreparedStatement;
};

/** A session row before its label is filled in from the credential's own name. */
export type StoredSession = RepositorySession & {
  readonly credential_id: string;
};

const MemberRow = z.object({
  user_id: z.string(),
  user_handle: z.string(),
  role: RepoRoleSchema,
  created_at: z.string(),
});

const InvitationRow = z.object({
  id: z.string(),
  repo_id: z.string(),
  owner_handle: z.string(),
  repo_name: z.string(),
  invitee_id: z.string(),
  invitee_handle: z.string(),
  role: RepoRoleSchema,
  invited_by_handle: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
});

const SessionRow = z.object({
  credential_key: z.string(),
  user_handle: z.string(),
  via: z.enum(['personal-token', 'agent-session', 'ssh-key', 'deploy-token', 'mcp']),
  label: z.string(),
  last_read_at: z.string().nullable(),
  last_push_at: z.string().nullable(),
  pushes: z.number(),
});

const AuditRow = z.object({
  at: z.string(),
  actor_handle: z.string(),
  action: z.enum([
    'collaborator.invite',
    'collaborator.invite_cancel',
    'collaborator.accept',
    'collaborator.decline',
    'collaborator.role',
    'collaborator.remove',
    'collaborator.leave',
    'repository.visibility',
    'repository.transfer',
    'repository.create',
    // Actions secrets (src/actions/actions-rpc.ts writes these to the same log).
    'actions-secret-set',
    'actions-secret-deleted',
    'actions-variable-set',
    'actions-variable-deleted',
  ]),
  target_handle: z.string().nullable(),
  detail: z.string(),
});

const INVITATION_SELECT = `SELECT i.id, i.repo_id, r.owner_handle, r.name AS repo_name, i.invitee_id,
    i.invitee_handle, i.role, i.invited_by_handle, i.created_at, i.expires_at
  FROM repository_invitations i JOIN repositories r ON r.id = i.repo_id`;

/**
 * Collaborators in FORGE; org standing (for org-owned repositories) from the identity
 * database, where orgs and their members live.
 */
export function d1Collaborators(
  db: D1Database,
  now: () => number,
  identity: IdentityEnv,
): CollaboratorStore {
  const auditStatement = (entry: AuditEntry): D1PreparedStatement =>
    db
      .prepare(
        `INSERT INTO repository_audit (repo_id, at, actor_id, actor_handle, action, target_id,
           target_handle, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        entry.repoId,
        iso(now()),
        entry.actor.id,
        entry.actor.handle,
        entry.action,
        entry.target?.id ?? null,
        entry.target?.handle ?? null,
        entry.detail ?? '',
      );
  const invitations = async (where: string, value: string): Promise<Invitation[]> => {
    const { results } = await db
      .prepare(
        `${INVITATION_SELECT} WHERE ${where} AND i.expires_at > ? ORDER BY i.created_at DESC`,
      )
      .bind(value, iso(now()))
      .all();
    return results.map((row) => InvitationRow.parse(row));
  };
  return {
    auditStatement,
    orgStanding: (orgId, userId) => orgStanding(identity, orgId, userId),
    async roleOf(repoId, userId) {
      const row = await db
        .prepare('SELECT role FROM repository_members WHERE repo_id = ? AND user_id = ?')
        .bind(repoId, userId)
        .first();
      return row === null ? null : RepoRoleSchema.parse(Reflect.get(row, 'role'));
    },
    async members(repoId) {
      const { results } = await db
        .prepare(
          `SELECT user_id, user_handle, role, created_at FROM repository_members
            WHERE repo_id = ? ORDER BY user_handle`,
        )
        .bind(repoId)
        .all();
      return results.map((row) => collaboratorOf(MemberRow.parse(row)));
    },
    async setRole(repoId, member, audit) {
      const at = iso(now());
      await db.batch([
        db
          .prepare(
            `INSERT INTO repository_members (repo_id, user_id, user_handle, role, added_by_id,
               created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (repo_id, user_id) DO UPDATE SET role = excluded.role,
               user_handle = excluded.user_handle, updated_at = excluded.updated_at`,
          )
          .bind(repoId, member.user.id, member.user.handle, member.role, member.by.id, at, at),
        auditStatement(audit),
      ]);
      const row = await db
        .prepare(
          `SELECT user_id, user_handle, role, created_at FROM repository_members
            WHERE repo_id = ? AND user_id = ?`,
        )
        .bind(repoId, member.user.id)
        .first();
      return collaboratorOf(MemberRow.parse(row));
    },
    async removeMember(repoId, userId, audit) {
      const [removed] = await db.batch([
        db
          .prepare('DELETE FROM repository_members WHERE repo_id = ? AND user_id = ?')
          .bind(repoId, userId),
        auditStatement(audit),
      ]);
      return (removed?.meta.changes ?? 0) > 0;
    },
    async invite(input, audit) {
      const created = now();
      const invitation: Invitation = {
        id: randomId('inv'),
        repo_id: input.repo.id,
        owner_handle: input.repo.ownerHandle,
        repo_name: input.repo.name,
        invitee_id: input.invitee.id,
        invitee_handle: input.invitee.handle,
        role: input.role,
        invited_by_handle: input.by.handle,
        created_at: iso(created),
        expires_at: iso(created + INVITATION_DAYS * DAY_MS),
      };
      await db.batch([
        // A new invitation replaces an older one for the same person (a new role, a new clock).
        db
          .prepare('DELETE FROM repository_invitations WHERE repo_id = ? AND invitee_id = ?')
          .bind(invitation.repo_id, invitation.invitee_id),
        db
          .prepare(
            `INSERT INTO repository_invitations (id, repo_id, invitee_id, invitee_handle, role,
               invited_by_id, invited_by_handle, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            invitation.id,
            invitation.repo_id,
            invitation.invitee_id,
            invitation.invitee_handle,
            invitation.role,
            input.by.id,
            input.by.handle,
            invitation.created_at,
            invitation.expires_at,
          ),
        auditStatement(audit),
      ]);
      return invitation;
    },
    async invitation(id) {
      const found = await invitations('i.id = ?', id);
      return found[0] ?? null;
    },
    invitationsFor: (userId) => invitations('i.invitee_id = ?', userId),
    pendingFor: (repoId) => invitations('i.repo_id = ?', repoId),
    async dropInvitation(id, audit) {
      const [dropped] = await db.batch([
        db.prepare('DELETE FROM repository_invitations WHERE id = ?').bind(id),
        auditStatement(audit),
      ]);
      return (dropped?.meta.changes ?? 0) > 0;
    },
    async acceptInvitation(invitation, audit) {
      const at = iso(now());
      await db.batch([
        db
          .prepare(
            `INSERT INTO repository_members (repo_id, user_id, user_handle, role, added_by_id,
               created_at, updated_at)
             SELECT repo_id, invitee_id, invitee_handle, role, invited_by_id, ?, ?
               FROM repository_invitations WHERE id = ?
             ON CONFLICT (repo_id, user_id) DO UPDATE SET role = excluded.role,
               updated_at = excluded.updated_at`,
          )
          .bind(at, at, invitation.id),
        db.prepare('DELETE FROM repository_invitations WHERE id = ?').bind(invitation.id),
        auditStatement(audit),
      ]);
    },
    async memberships(userId) {
      const { results } = await db
        .prepare(
          `SELECT repo_id, role FROM repository_members WHERE user_id = ?
            ORDER BY created_at DESC LIMIT 200`,
        )
        .bind(userId)
        .all();
      return results.map((row) =>
        z
          .object({ repo_id: z.string(), role: RepoRoleSchema })
          .transform((parsed) => ({
            repoId: parsed.repo_id,
            role: parsed.role,
          }))
          .parse(row),
      );
    },
    async recordUse(use) {
      const at = iso(now());
      const stale = iso(now() - READ_STAMP_MS);
      const isPush = use.action === 'push';
      await db
        .prepare(
          `INSERT INTO repository_sessions (repo_id, credential_key, user_id, user_handle, via,
             label, last_read_at, last_push_at, pushes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (repo_id, credential_key) DO UPDATE SET
             label = CASE WHEN excluded.label = '' THEN label ELSE excluded.label END,
             last_read_at = COALESCE(excluded.last_read_at, last_read_at),
             last_push_at = COALESCE(excluded.last_push_at, last_push_at),
             pushes = pushes + excluded.pushes
           WHERE excluded.pushes > 0 OR last_read_at IS NULL OR last_read_at < ?`,
        )
        .bind(
          use.repoId,
          `${use.via}:${use.credentialId}`,
          use.user.id,
          use.user.handle,
          use.via,
          use.label,
          isPush ? null : at,
          isPush ? at : null,
          isPush ? 1 : 0,
          stale,
        )
        .run();
    },
    async sessions(repoId) {
      const { results } = await db
        .prepare(
          `SELECT credential_key, user_handle, via, label, last_read_at, last_push_at, pushes
             FROM repository_sessions WHERE repo_id = ?
            ORDER BY MAX(COALESCE(last_read_at, ''), COALESCE(last_push_at, '')) DESC LIMIT ?`,
        )
        .bind(repoId, LIST_LIMIT)
        .all();
      return results.map((row) => {
        const parsed = SessionRow.parse(row);
        return {
          credential_id: parsed.credential_key.slice(parsed.via.length + 1),
          handle: parsed.user_handle,
          via: parsed.via,
          label: parsed.label,
          last_read_at: parsed.last_read_at,
          last_push_at: parsed.last_push_at,
          pushes: parsed.pushes,
        };
      });
    },
    async audit(repoId) {
      const { results } = await db
        .prepare(
          `SELECT at, actor_handle, action, target_handle, detail FROM repository_audit
            WHERE repo_id = ? ORDER BY seq DESC LIMIT ?`,
        )
        .bind(repoId, LIST_LIMIT)
        .all();
      return results.map((row) => AuditRow.parse(row));
    },
  };
}

function collaboratorOf(row: z.infer<typeof MemberRow>): Collaborator {
  return { user_id: row.user_id, handle: row.user_handle, role: row.role, since: row.created_at };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

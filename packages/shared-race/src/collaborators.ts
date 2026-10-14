/**
 * Collaborators and visibility (`docs/claude-opus/22-collaborators.md`): who may do what with a
 * repository besides its owner, the invitations that make them collaborators, and the RPC
 * the web app and the MCP Worker call. The rule itself lives in the gateway (`mayUseEngine`);
 * these are the shapes on the wire.
 */
import { z } from 'zod';

import type { RepoOwner, RepositoryRecord, Viewer } from './repos';
import type { RpcResult } from './rpc';

/**
 * A collaborator's role, weakest first:
 * - `read`: clone, fetch and view;
 * - `write`: also push beans;
 * - `maintain`: also answer decision cards and manage deploy tokens.
 * The owner can do everything, settings and deletion included; ownership is not a role
 * anyone is invited to.
 */
export const REPO_ROLES = ['read', 'write', 'maintain'] as const;
export const RepoRole = z.enum(REPO_ROLES);
export type RepoRole = z.infer<typeof RepoRole>;

/** What a person is on a repository: a collaborator role, or its owner. */
export type ViewerRole = RepoRole | 'owner';

/**
 * Everything access is asked about, each needing a least role:
 * read → `read`, write → `write`, decide, deploy-tokens and actions → `maintain`, administer →
 * owner. `actions` is dispatching and cancelling workflow runs and managing Actions secrets.
 */
export type RepositoryAction =
  | 'read'
  | 'write'
  | 'decide'
  | 'deploy-tokens'
  | 'actions'
  | 'administer';

/** A repository as one viewer sees it: the record and the viewer's role (null: none). */
export type RepositoryForViewer = RepositoryRecord & { readonly viewer_role: ViewerRole | null };

export type Collaborator = {
  readonly user_id: string;
  readonly handle: string;
  readonly role: ViewerRole;
  /** ISO 8601: when they joined (the owner: when the repository was created). */
  readonly since: string;
};

export type Invitation = {
  readonly id: string;
  readonly repo_id: string;
  readonly owner_handle: string;
  readonly repo_name: string;
  readonly invitee_id: string;
  readonly invitee_handle: string;
  readonly role: RepoRole;
  readonly invited_by_handle: string;
  /** ISO 8601. */
  readonly created_at: string;
  readonly expires_at: string;
};

/** How someone reached the repository: the kind of credential, and what it is called. */
export type SessionVia = 'personal-token' | 'agent-session' | 'ssh-key' | 'deploy-token' | 'mcp';

/** A credential that acted on the repository, and the person it acted for. */
export type RepositorySession = {
  readonly handle: string;
  readonly via: SessionVia;
  /** "Claude Code", "laptop", "CI push": the token's, key's or client's name. */
  readonly label: string;
  /** ISO 8601, or null when it never did that. */
  readonly last_read_at: string | null;
  readonly last_push_at: string | null;
  readonly pushes: number;
};

/** One line of a repository's audit log: invitations, roles, removals, visibility. */
export type RepositoryAuditEvent = {
  readonly at: string;
  readonly actor_handle: string;
  readonly action: RepositoryAuditAction;
  readonly target_handle: string | null;
  readonly detail: string;
};

export type RepositoryAuditAction =
  | 'collaborator.invite'
  | 'collaborator.invite_cancel'
  | 'collaborator.accept'
  | 'collaborator.decline'
  | 'collaborator.role'
  | 'collaborator.remove'
  | 'collaborator.leave'
  | 'repository.visibility'
  | 'repository.transfer'
  | 'actions-secret-set'
  | 'actions-secret-deleted'
  | 'actions-variable-set'
  | 'actions-variable-deleted'
  | 'bean.approve';

/** Who is on a repository, as a member sees it; the owner also sees invitations and the log. */
export type RepositoryPeople = {
  readonly viewer_role: ViewerRole;
  /** The owner first, then collaborators by handle. */
  readonly collaborators: readonly Collaborator[];
  /** Pending, for the owner only (empty for others). */
  readonly invitations: readonly Invitation[];
  /** Newest first, at most 50. */
  readonly sessions: readonly RepositorySession[];
  /** For the owner only, newest first, at most 50. */
  readonly audit: readonly RepositoryAuditEvent[];
};

export const InviteInput = z.object({
  handle: z
    .string()
    .trim()
    .toLowerCase()
    .transform((handle) => handle.replace(/^@/, ''))
    .pipe(z.string().min(1, 'Name someone by their handle.').max(39)),
  role: RepoRole,
});
export type InviteInput = z.input<typeof InviteInput>;

/** An agent (MCP session or personal token) asking about a repository for its person. */
export type AgentPrincipal = {
  readonly user: RepoOwner;
  /** The session's account scopes: `read`, `collaborate`, `write`, `secrets`. */
  readonly scopes: readonly string[];
  /** The client the person approved ("Claude Code"), for the repository's sessions list. */
  readonly label: string;
  /**
   * The agent session, as the approval rules' self-approval check compares it: `oauth:<client
   * id>` for an OAuth session, `token` for a personal token used as the bearer. Absent from
   * callers before it; a bean it commits then reads as `mcp` (unknown session).
   */
  readonly session?: string;
};

/**
 * The collaborators RPC on the gateway's default entrypoint. The web app authenticates the
 * person (`requireUser`) and the MCP Worker its session before calling; the gateway decides
 * every access itself through `mayUseEngine`. Repositories the asker may not see answer
 * `not_found`, exactly as missing ones do.
 */
export type CollaboratorsRpc = {
  repositoryPeople(repoId: string, viewer: Viewer): Promise<RpcResult<RepositoryPeople>>;
  inviteCollaborator(
    actor: RepoOwner,
    repoId: string,
    input: InviteInput,
  ): Promise<RpcResult<Invitation>>;
  cancelInvitation(
    actor: RepoOwner,
    repoId: string,
    invitationId: string,
  ): Promise<RpcResult<{ readonly cancelled: true }>>;
  setCollaboratorRole(
    actor: RepoOwner,
    repoId: string,
    userId: string,
    role: RepoRole,
  ): Promise<RpcResult<Collaborator>>;
  /** Removes a collaborator (the owner), or the actor themself (leaving). */
  removeCollaborator(
    actor: RepoOwner,
    repoId: string,
    userId: string,
  ): Promise<RpcResult<{ readonly removed: true }>>;
  /** Invitations waiting for this person, newest first. */
  myInvitations(userId: string): Promise<RpcResult<readonly Invitation[]>>;
  answerInvitation(
    user: RepoOwner,
    invitationId: string,
    answer: 'accept' | 'decline',
  ): Promise<RpcResult<{ readonly owner_handle: string; readonly repo_name: string }>>;
  /** Repositories this person collaborates on (not their own), newest first. */
  sharedRepositories(userId: string): Promise<RpcResult<readonly RepositoryForViewer[]>>;
  /**
   * Whether `viewer` may do `action` with the engine `engineId`: `{ repository: null }` for
   * an engine that is no repository (a race), the repository's name when allowed, and
   * `not_found` / `forbidden` otherwise. The web's run routes and decisions ask this.
   */
  engineAccess(
    engineId: string,
    viewer: Viewer,
    action: RepositoryAction,
  ): Promise<RpcResult<{ readonly repository: RepositoryForViewer | null }>>;
  /** The same question for an agent session, by name; records the session's use. */
  agentRepositoryAccess(
    agent: AgentPrincipal,
    ownerHandle: string,
    name: string,
    action: RepositoryAction,
  ): Promise<RpcResult<RepositoryForViewer>>;
};

/**
 * The collaborators RPC (`CollaboratorsRpc`): invitations, roles, removals and leaving, the
 * people on a repository, and the access questions the web's run routes and MCP ask. Every
 * permission here is `mayUseEngine`'s, through `access.ts`: the owner administers, members
 * read, people who may not see a repository get the same 404 as for a missing one.
 */
import type {
  AgentPrincipal,
  CollaboratorsRpc,
  Collaborator,
  RepoRole,
  RepositoryAction,
  RepositoryForViewer,
  RepositoryPeople,
} from '@gitstalk/shared-race/collaborators';
import { InviteInput, RepoRole as RepoRoleSchema } from '@gitstalk/shared-race/collaborators';
import type { RepoOwner, RepositoryRecord, Viewer } from '@gitstalk/shared-race/repos';
import type { RpcError, RpcResult } from '@gitstalk/shared-race/rpc';

import { agentRepositoryPrincipal } from '../agent/agent-access';
import type { Logger } from '../log';
import { accessResult, viewerPrincipal } from './access';
import type { CollaboratorStore, Person, StoredSession } from './collaborators';
import type { PeopleDirectory } from './people';
import type { Registry } from './registry';

export type CollaboratorsDeps = {
  readonly registry: Registry;
  readonly collaborators: CollaboratorStore;
  readonly people: PeopleDirectory;
  readonly log: Logger;
};

export function collaboratorsRpc(deps: CollaboratorsDeps): CollaboratorsRpc {
  return {
    repositoryPeople: (repoId, viewer) => peopleOf(deps, repoId, viewer),
    inviteCollaborator: (actor, repoId, input) => invite(deps, { actor, repoId, input }),
    async cancelInvitation(actor, repoId, invitationId) {
      const repo = await administered(deps, actor, repoId);
      if (!repo.ok) return repo;
      const invitation = await deps.collaborators.invitation(invitationId);
      if (invitation === null || invitation.repo_id !== repoId)
        return failure(404, 'not_found', 'no such invitation');
      await deps.collaborators.dropInvitation(invitationId, {
        repoId,
        actor,
        action: 'collaborator.invite_cancel',
        target: { id: invitation.invitee_id, handle: invitation.invitee_handle },
      });
      return { ok: true, value: { cancelled: true } };
    },
    setCollaboratorRole: (actor, repoId, userId, role) =>
      changeRole(deps, { actor, repoId, userId, role }),
    removeCollaborator: (actor, repoId, userId) => remove(deps, { actor, repoId, userId }),
    async myInvitations(userId) {
      return { ok: true, value: await deps.collaborators.invitationsFor(userId) };
    },
    answerInvitation: (user, invitationId, answer) =>
      answerInvitation(deps, { user, invitationId, answer }),
    async sharedRepositories(userId) {
      const memberships = await deps.collaborators.memberships(userId);
      const records = await deps.registry.byIds(memberships.map((member) => member.repoId));
      const roles = new Map(memberships.map((member) => [member.repoId, member.role]));
      const shared = records
        .map((record): RepositoryForViewer => withRole(record, roles.get(record.id) ?? null))
        .toSorted((a, b) => b.created_at.localeCompare(a.created_at));
      return { ok: true, value: shared };
    },
    async engineAccess(engineId, viewer, action) {
      const record = await deps.registry.byEngine(engineId);
      if (record === null) return { ok: true, value: { repository: null } };
      const decided = await accessResult(deps.collaborators, record, {
        principal: viewerPrincipal(viewer),
        action,
        what: engineId,
      });
      return decided.ok ? { ok: true, value: { repository: decided.value } } : decided;
    },
    agentRepositoryAccess: (agent, ownerHandle, name, action) =>
      agentAccess(deps, { agent, ownerHandle, name, action }),
  };
}

async function peopleOf(
  deps: CollaboratorsDeps,
  repoId: string,
  viewer: Viewer,
): Promise<RpcResult<RepositoryPeople>> {
  const read = await accessResult(deps.collaborators, await deps.registry.byId(repoId), {
    principal: viewerPrincipal(viewer),
    action: 'read',
    what: repoId,
  });
  if (!read.ok) return read;
  const role = read.value.viewer_role;
  if (role === null)
    return failure(403, 'forbidden', 'only people on this repository see who else is');
  const isOwner = role === 'owner';
  const [members, invitations, stored, audit] = await Promise.all([
    deps.collaborators.members(repoId),
    isOwner ? deps.collaborators.pendingFor(repoId) : Promise.resolve([]),
    deps.collaborators.sessions(repoId),
    isOwner ? deps.collaborators.audit(repoId) : Promise.resolve([]),
  ]);
  const owner: Collaborator = {
    user_id: read.value.owner.id,
    handle: read.value.owner.handle,
    role: 'owner',
    since: read.value.created_at,
  };
  return {
    ok: true,
    value: {
      viewer_role: role,
      collaborators: [owner, ...members],
      invitations,
      sessions: await named(deps.people, stored),
      audit,
    },
  };
}

/** Sessions with the names their tokens and keys carry now (an MCP client's is stored). */
async function named(
  people: PeopleDirectory,
  stored: readonly StoredSession[],
): Promise<RepositoryPeople['sessions']> {
  const names = await people.credentialNames(
    stored.filter((s) => s.label === '').map((s) => ({ via: s.via, id: s.credential_id })),
  );
  return stored.map(({ credential_id: id, ...session }) => ({
    ...session,
    label: session.label === '' ? (names.get(`${session.via}:${id}`) ?? 'removed') : session.label,
  }));
}

async function invite(
  deps: CollaboratorsDeps,
  input: { readonly actor: RepoOwner; readonly repoId: string; readonly input: InviteInput },
): Promise<RpcResult<Awaited<ReturnType<CollaboratorStore['invite']>>>> {
  const parsed = InviteInput.safeParse(input.input);
  if (!parsed.success)
    return failure(400, 'invalid_request', parsed.error.issues[0]?.message ?? 'check the form');
  const repo = await administered(deps, input.actor, input.repoId);
  if (!repo.ok) return repo;
  const invitee = await deps.people.byHandle(parsed.data.handle);
  if (invitee === null)
    return failure(404, 'unknown_handle', `nobody on Gitstalk is called @${parsed.data.handle}`);
  if (invitee.id === repo.value.owner.id)
    return failure(400, 'invalid_request', 'the owner already has every role');
  const current = await deps.collaborators.roleOf(input.repoId, invitee.id);
  if (current !== null)
    return failure(
      409,
      'already_member',
      `@${invitee.handle} already has the ${current} role; change it in the list`,
    );
  const invitation = await deps.collaborators.invite(
    {
      repo: { id: repo.value.id, ownerHandle: repo.value.owner.handle, name: repo.value.name },
      invitee,
      role: parsed.data.role,
      by: input.actor,
    },
    {
      repoId: input.repoId,
      actor: input.actor,
      action: 'collaborator.invite',
      target: invitee,
      detail: parsed.data.role,
    },
  );
  deps.log.info('collaborator invited', { repo: input.repoId, role: parsed.data.role });
  return { ok: true, value: invitation };
}

async function changeRole(
  deps: CollaboratorsDeps,
  input: {
    readonly actor: RepoOwner;
    readonly repoId: string;
    readonly userId: string;
    readonly role: RepoRole;
  },
): Promise<RpcResult<Collaborator>> {
  const role = RepoRoleSchema.safeParse(input.role);
  if (!role.success) return failure(400, 'invalid_request', 'pick read, write or maintain');
  const repo = await administered(deps, input.actor, input.repoId);
  if (!repo.ok) return repo;
  const member = await memberOf(deps, input.repoId, input.userId);
  if (member === null) return failure(404, 'not_found', 'not a collaborator on this repository');
  const updated = await deps.collaborators.setRole(
    input.repoId,
    { user: { id: member.user_id, handle: member.handle }, role: role.data, by: input.actor },
    {
      repoId: input.repoId,
      actor: input.actor,
      action: 'collaborator.role',
      target: { id: member.user_id, handle: member.handle },
      detail: `${member.role} → ${role.data}`,
    },
  );
  deps.log.info('collaborator role changed', { repo: input.repoId, role: role.data });
  return { ok: true, value: updated };
}

/** The owner removes anyone; a collaborator removes themself (leaves). */
async function remove(
  deps: CollaboratorsDeps,
  input: { readonly actor: RepoOwner; readonly repoId: string; readonly userId: string },
): Promise<RpcResult<{ readonly removed: true }>> {
  const isLeaving = input.actor.id === input.userId;
  const repo = isLeaving
    ? await readable(deps, input.actor, input.repoId)
    : await administered(deps, input.actor, input.repoId);
  if (!repo.ok) return repo;
  if (isLeaving && repo.value.viewer_role === 'owner')
    return failure(400, 'invalid_request', 'the owner cannot leave; delete the repository instead');
  const member = await memberOf(deps, input.repoId, input.userId);
  if (member === null) return failure(404, 'not_found', 'not a collaborator on this repository');
  await deps.collaborators.removeMember(input.repoId, input.userId, {
    repoId: input.repoId,
    actor: input.actor,
    action: isLeaving ? 'collaborator.leave' : 'collaborator.remove',
    target: { id: member.user_id, handle: member.handle },
    detail: member.role,
  });
  deps.log.info(isLeaving ? 'collaborator left' : 'collaborator removed', {
    repo: input.repoId,
  });
  return { ok: true, value: { removed: true } };
}

async function answerInvitation(
  deps: CollaboratorsDeps,
  input: {
    readonly user: RepoOwner;
    readonly invitationId: string;
    readonly answer: 'accept' | 'decline';
  },
): Promise<RpcResult<{ readonly owner_handle: string; readonly repo_name: string }>> {
  const invitation = await deps.collaborators.invitation(input.invitationId);
  // Someone else's invitation is as missing as an expired one.
  if (invitation === null || invitation.invitee_id !== input.user.id)
    return failure(404, 'not_found', 'that invitation is gone (answered, cancelled or expired)');
  const audit = {
    repoId: invitation.repo_id,
    actor: input.user,
    target: input.user,
    detail: invitation.role,
  };
  if (input.answer === 'accept')
    await deps.collaborators.acceptInvitation(invitation, {
      ...audit,
      action: 'collaborator.accept',
    });
  else
    await deps.collaborators.dropInvitation(invitation.id, {
      ...audit,
      action: 'collaborator.decline',
    });
  deps.log.info('invitation answered', { repo: invitation.repo_id, answer: input.answer });
  return {
    ok: true,
    value: { owner_handle: invitation.owner_handle, repo_name: invitation.repo_name },
  };
}

async function agentAccess(
  deps: CollaboratorsDeps,
  input: {
    readonly agent: AgentPrincipal;
    readonly ownerHandle: string;
    readonly name: string;
    readonly action: RepositoryAction;
  },
): Promise<RpcResult<RepositoryForViewer>> {
  const { agent } = input;
  // The same principal the MCP repository tools use, so `whoami` with a repo answers as they do.
  const principal = agentRepositoryPrincipal(agent);
  const record = await deps.registry.resolve(input.ownerHandle, input.name);
  const decided = await accessResult(deps.collaborators, record, {
    principal,
    action: input.action,
    what: `${input.ownerHandle}/${input.name}`,
  });
  if (decided.ok)
    await deps.collaborators.recordUse({
      repoId: decided.value.id,
      user: agent.user,
      via: 'mcp',
      credentialId: `${agent.user.id}/${agent.label}`,
      label: agent.label,
      // Last seen; pushes are counted where they happen (git).
      action: 'read',
    });
  return decided;
}

function administered(
  deps: CollaboratorsDeps,
  actor: Person,
  repoId: string,
): Promise<RpcResult<RepositoryForViewer>> {
  return askAbout(deps, { actor, repoId, action: 'administer' });
}

function readable(
  deps: CollaboratorsDeps,
  actor: Person,
  repoId: string,
): Promise<RpcResult<RepositoryForViewer>> {
  return askAbout(deps, { actor, repoId, action: 'read' });
}

async function askAbout(
  deps: CollaboratorsDeps,
  input: { readonly actor: Person; readonly repoId: string; readonly action: RepositoryAction },
): Promise<RpcResult<RepositoryForViewer>> {
  return accessResult(deps.collaborators, await deps.registry.byId(input.repoId), {
    principal: { kind: 'person', user: input.actor },
    action: input.action,
    what: input.repoId,
  });
}

async function memberOf(
  deps: CollaboratorsDeps,
  repoId: string,
  userId: string,
): Promise<Collaborator | null> {
  const members = await deps.collaborators.members(repoId);
  return members.find((member) => member.user_id === userId) ?? null;
}

function withRole(record: RepositoryRecord, role: RepoRole | null): RepositoryForViewer {
  return Object.assign({}, record, { viewer_role: role });
}

function failure(status: number, code: string, message: string): { ok: false; error: RpcError } {
  return { ok: false, error: { code, status, message } };
}

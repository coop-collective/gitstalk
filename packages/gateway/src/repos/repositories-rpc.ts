/**
 * The registry RPC (`RepositoriesRpc`): create (through `repository-creation.ts`, the one
 * creation path), list, read, update, delete, archive and transfer repositories.
 */
import { recordOrgAudit } from '@gitstalk/shared-identity/org-audit';
import type { RepositoryOwnerRef } from '@gitstalk/shared-identity/orgs';
import { mayInOrg, orgRole, orgsOf, ownerByHandle, ownerOf } from '@gitstalk/shared-identity/orgs';
import { findUserById } from '@gitstalk/shared-identity/users';
import type { RepoCreateRpc } from '@gitstalk/shared-race/repo-create';
import type { RpcError, RpcResult } from '@gitstalk/shared-race/rpc';
import type { RepositoriesRpc, RepositoryRecord } from '@gitstalk/shared-race/repos';
import { UpdateRepositoryInput } from '@gitstalk/shared-race/repos';

import { orgRepositoryRole } from '../auth/git-credential';
import { GatewayError } from '../errors';
import { accessResult, archivedError, decideAccess, viewerPrincipal } from './access';
import type { RepositoriesDeps } from './repositories-deps';
import { INTERNAL_NEEDS_ORG, createRepository, createRepositoryAs } from './repository-creation';

/** `repo_create` and `POST /api/repos` (`RepoCreateRpc`), on the gateway's default entrypoint. */
export function repoCreateRpc(deps: RepositoriesDeps): RepoCreateRpc {
  return {
    createRepositoryAs: (principal, request, via) =>
      guarded(() => createRepositoryAs(deps, principal, request, via)),
  };
}

export function repositoriesRpc(deps: RepositoriesDeps): RepositoriesRpc {
  return {
    createRepository: (owner, input) => guarded(() => createRepository(deps, owner, input)),
    listRepositories: (ownerId, viewer, listing) =>
      guarded(async () => {
        const records = await deps.registry.byOwner(
          ownerId,
          listing === 'archived' ? 'archived' : 'active',
        );
        const principal = viewerPrincipal(viewer);
        const readable = await Promise.all(
          records.map(async (record) => {
            const decision = await decideAccess(deps.collaborators, record, {
              principal,
              action: 'read',
            });
            return decision.verdict === 'allowed' ? record : null;
          }),
        );
        return ok(readable.filter((record) => record !== null));
      }),
    getRepository: (ownerHandle, name, viewer) =>
      guarded(async () =>
        accessResult(deps.collaborators, await deps.registry.resolve(ownerHandle, name), {
          principal: viewerPrincipal(viewer),
          action: 'read',
          what: `${ownerHandle}/${name}`,
        }),
      ),
    updateRepository: (actorId, repoId, patch) =>
      guarded(async () => {
        const parsed = UpdateRepositoryInput.safeParse(patch);
        if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'invalid change');
        const socialKey = parsed.data.social_image_key;
        // A repository's social image is its own upload, never another repository's object.
        if (typeof socialKey === 'string' && !socialKey.startsWith(`repos/${repoId}/social/`))
          return invalid('that social image belongs to another repository');
        const owned = await administered(deps, actorId, repoId);
        if (!owned.ok) return owned;
        if (owned.value.archived_at !== null)
          return { ok: false, error: archivedError(owned.value, 'administer') };
        if (parsed.data.visibility === 'internal' && owned.value.owner_kind !== 'org')
          return invalid(INTERNAL_NEEDS_ORG);
        const updated = await deps.registry.update(repoId, parsed.data, deps.now());
        if (updated === null) return missing(repoId);
        if (updated === 'taken') return taken(owned.value.owner.handle, parsed.data.name ?? '');
        if (updated.visibility !== owned.value.visibility)
          await deps.collaborators
            .auditStatement({
              repoId,
              actor: owned.value.owner,
              action: 'repository.visibility',
              detail: `${owned.value.visibility} → ${updated.visibility}`,
            })
            .run();
        return ok(updated);
      }),
    deleteRepository: (actorId, repoId) =>
      guarded(async () => {
        const owned = await administered(deps, actorId, repoId);
        if (!owned.ok) return owned;
        await deps.registry.remove(repoId);
        // The engine stops before its repo goes, so nothing it does meets a missing repo.
        await deps.engine.close(owned.value.engine_id);
        await deps.storage.delete(owned.value.artifacts_repo);
        await deps.cleanup(owned.value);
        deps.log.info('repository deleted', { repo: repoId });
        return ok({ deleted: true as const });
      }),
    archiveRepository: (actorId, repoId, to) =>
      guarded(async () => {
        if (to !== 'archived' && to !== 'active')
          return invalid('archive to "archived" or "active"');
        const owned = await administered(deps, actorId, repoId);
        if (!owned.ok) return owned;
        const changed = await deps.registry.setListing(repoId, to, deps.now());
        if (changed === null) return missing(repoId);
        deps.log.info(to === 'archived' ? 'repository archived' : 'repository unarchived', {
          repo: repoId,
        });
        return ok(changed);
      }),
    transferRepository: (actorId, repoId, toHandle) =>
      guarded(() => transfer(deps, { actorId, repoId, toHandle })),
    repositoryActivity: (ownerId, limit) =>
      guarded(async () => {
        // Org repositories the person reads through their org role join their activity.
        const orgs = await orgsOf(deps.identity, ownerId);
        const readable = orgs.filter(
          ({ org, role }) =>
            orgRepositoryRole({ role, basePermission: org.basePermission }) !== null,
        );
        const orgIds = readable.map(({ org }) => org.id);
        // Every member reads the org's internal repositories, whatever the base permission.
        const memberOrgIds = orgs.map(({ org }) => org.id);
        return ok(await deps.registry.activity(ownerId, limit, orgIds, memberOrgIds));
      }),
    repositoryFiles: (repoId, viewer) =>
      guarded(async () => {
        const record = await accessResult(deps.collaborators, await deps.registry.byId(repoId), {
          principal: viewerPrincipal(viewer),
          action: 'read',
          what: repoId,
        });
        if (!record.ok) return record;
        const { artifacts_repo: artifactsRepo, default_branch: branch } = record.value;
        return ok(await deps.storage.files(artifactsRepo, branch));
      }),
  };
}

/**
 * Moves a repository the actor administers to their own namespace or to an org where they
 * are an owner or admin; audited on the repository and on each org involved.
 */
async function transfer(
  deps: RepositoriesDeps,
  input: { readonly actorId: string; readonly repoId: string; readonly toHandle: string },
): Promise<RpcResult<RepositoryRecord>> {
  const owned = await administered(deps, input.actorId, input.repoId);
  if (!owned.ok) return owned;
  const [target, actor] = await Promise.all([
    ownerByHandle(deps.identity, input.toHandle),
    findUserById(deps.identity, input.actorId),
  ]);
  if (target === null || actor === null)
    return failure({
      code: 'not_found',
      status: 404,
      message: `nobody is called ${input.toHandle}`,
    });
  const from = ownerOf(owned.value);
  if (target.id === from.id) return invalid(`${target.handle} already owns it`);
  const mayReceive =
    target.kind === 'user'
      ? target.id === actor.id
      : mayInOrg(await orgRole(deps.identity, target.id, actor.id), 'transfer-in');
  if (!mayReceive)
    return failure({
      code: 'forbidden',
      status: 403,
      message:
        'move a repository to yourself or to an organization where you are an owner or admin',
    });
  const moved = await deps.registry.transfer(input.repoId, target, deps.now());
  if (moved === null) return missing(input.repoId);
  if (moved === 'taken') return taken(target.handle, owned.value.name);
  await auditTransfer(deps, { actor, from, to: target, name: moved.name, repoId: moved.id });
  deps.log.info('repository transferred', { repo: moved.id, to: target.kind });
  return ok(moved);
}

async function auditTransfer(
  deps: RepositoriesDeps,
  move: {
    readonly actor: { readonly id: string; readonly handle: string };
    readonly from: RepositoryOwnerRef;
    readonly to: RepositoryOwnerRef;
    readonly name: string;
    readonly repoId: string;
  },
): Promise<void> {
  const actor = { id: move.actor.id, handle: move.actor.handle };
  const now = deps.now();
  const writes: Promise<unknown>[] = [
    deps.collaborators
      .auditStatement({
        repoId: move.repoId,
        actor,
        action: 'repository.transfer',
        detail: `${move.from.handle} → ${move.to.handle}`,
      })
      .run(),
  ];
  if (move.to.kind === 'org')
    writes.push(
      recordOrgAudit(
        deps.identity,
        {
          orgId: move.to.id,
          actor,
          action: 'repository.transfer_in',
          detail: `${move.from.handle}/${move.name}`,
        },
        now,
      ),
    );
  if (move.from.kind === 'org')
    writes.push(
      recordOrgAudit(
        deps.identity,
        {
          orgId: move.from.id,
          actor,
          action: 'repository.transfer_out',
          detail: `→ ${move.to.handle}/${move.name}`,
        },
        now,
      ),
    );
  await Promise.all(writes);
}

/** The repository, when the actor may administer it (its owner); 404 or 403 otherwise. */
async function administered(
  deps: RepositoriesDeps,
  actorId: string,
  repoId: string,
): Promise<RpcResult<RepositoryRecord>> {
  return accessResult(deps.collaborators, await deps.registry.byId(repoId), {
    principal: viewerPrincipal(actorId),
    action: 'administer',
    what: repoId,
  });
}

/** Runs a call; gateway errors (Artifacts failures included) become error values. */
async function guarded<T>(use: () => Promise<RpcResult<T>>): Promise<RpcResult<T>> {
  try {
    return await use();
  } catch (error: unknown) {
    if (error instanceof GatewayError)
      return failure({ code: error.code, status: error.status, message: error.message });
    throw error;
  }
}

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value };
}

function failure(error: RpcError): { ok: false; error: RpcError } {
  return { ok: false, error };
}

function invalid(message: string): { ok: false; error: RpcError } {
  return failure({ code: 'invalid_request', status: 400, message });
}

function missing(what: string): { ok: false; error: RpcError } {
  return failure({ code: 'not_found', status: 404, message: `repository ${what} not found` });
}

function taken(handle: string, name: string): { ok: false; error: RpcError } {
  return failure({
    code: 'name_taken',
    status: 409,
    message: `${handle} already has a repository named ${name}`,
  });
}

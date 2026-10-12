/**
 * `ActionsEntriesRpc` (on the gateway's `Actions` entrypoint): repository variables, the
 * repository's view of its own and inherited secrets and variables, and the org's secrets and
 * variables. Repository calls are checked by `mayUseEngine` (a role to read, `actions`, that is
 * maintain, to change); org calls by the org role (members read, owners and admins manage).
 * No answer carries a secret value.
 */
import { SecretName } from '@gitstalk/shared-race/actions';
import type {
  ActionsEntriesRpc,
  EffectiveSecret,
  EffectiveVariable,
  EntrySource,
  OrgActionsSettings,
  RepositoryAccessPolicy,
} from '@gitstalk/shared-race/actions-secrets';
import {
  VariableName,
  PutOrgSecretInputSchema,
  PutOrgVariableInputSchema,
  PutVariableInputSchema,
} from '@gitstalk/shared-race/actions-secrets';
import type { Viewer } from '@gitstalk/shared-race/repos';
import type { RpcError, RpcResult } from '@gitstalk/shared-race/rpc';

import { readConfig } from '../config';
import { createLogger } from '../log';
import { accessResult, viewerPrincipal } from '../repos/access';
import { d1Collaborators } from '../repos/collaborators';
import { d1Registry } from '../repos/registry';
import { auditOrg, auditRepository, handleOf, orgAuditLog } from './actions-audit';
import { auditDetail, noRole } from './actions-rpc';
import type { Sourced } from './entry-policy';
import type { Org, OrgRole } from './org-directory';
import { managesOrgEntries } from './org-directory';
import type { EntryStores } from './repo-entries';
import { entryStoresOf, repoSecretEntries, repoVariableEntries } from './repo-entries';
import { SecretsNotConfiguredError } from './secrets';

export function actionsEntriesRpc(
  env: Env,
  stores: EntryStores = entryStoresOf(env),
  options: { readonly via?: string } = {},
): ActionsEntriesRpc {
  const db = env.FORGE;
  const log = createLogger(readConfig(env).logLevel, { component: 'actions-entries' });
  const registry = d1Registry(db);
  const repoAccess = async (viewer: Viewer, repoId: string, action: 'read' | 'actions') =>
    accessResult(
      d1Collaborators(db, () => Date.now(), env),
      await registry.byId(repoId),
      {
        principal: viewerPrincipal(viewer),
        action,
        what: repoId,
      },
    );
  const guarded = async <T>(work: () => Promise<RpcResult<T>>): Promise<RpcResult<T>> => {
    try {
      return await work();
    } catch (error: unknown) {
      if (error instanceof SecretsNotConfiguredError)
        return failed({ code: 'not_configured', status: 503, message: error.message });
      log.error('actions entries rpc failed', { error });
      return failed({ code: 'internal', status: 500, message: 'internal error' });
    }
  };
  const by = async (viewer: Viewer) => ({
    actor: await handleOf(env, viewer),
    at: new Date().toISOString(),
  });

  return {
    repoActionsEntries: (viewer, repoId) =>
      guarded(async () => {
        const allowed = await repoAccess(viewer, repoId, 'read');
        if (!allowed.ok) return allowed;
        const role = allowed.value.viewer_role;
        if (role === null) return failed(noRole());
        const repo = allowed.value;
        const [secrets, variables] = await Promise.all([
          repoSecretEntries(stores, repo),
          repoVariableEntries(stores, repo),
        ]);
        const orgHandle = secrets.owner.kind === 'org' ? secrets.owner.handle : null;
        return ok({
          canManage: role === 'owner' || role === 'maintain',
          orgHandle,
          secrets: secrets.entries.map((entry) => effectiveSecretOf(entry, orgHandle)),
          variables: variables.entries.map((entry) => effectiveVariableOf(entry, orgHandle)),
        });
      }),
    putVariable: (viewer, repoId, input) =>
      guarded(async () => {
        const allowed = await repoAccess(viewer, repoId, 'actions');
        if (!allowed.ok) return allowed;
        const parsed = PutVariableInputSchema.safeParse(input);
        if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'invalid variable');
        const stamp = await by(viewer);
        const saved = await stores.variables.putRepo(repoId, parsed.data, stamp);
        await auditRepository(db, {
          repo: allowed.value,
          viewer,
          actor: stamp.actor,
          action: 'actions-variable-set',
          detail: auditDetail(saved.name, options.via),
        });
        return ok(saved);
      }),
    deleteVariable: (viewer, repoId, name) =>
      guarded(async () => {
        const allowed = await repoAccess(viewer, repoId, 'actions');
        if (!allowed.ok) return allowed;
        const deleted = await stores.variables.deleteRepo(repoId, name);
        if (deleted)
          await auditRepository(db, {
            repo: allowed.value,
            viewer,
            actor: await handleOf(env, viewer),
            action: 'actions-variable-deleted',
            detail: auditDetail(name.toUpperCase(), options.via),
          });
        return ok({ deleted });
      }),
    orgActionsSettings: (viewer, orgHandle) =>
      guarded(async () => {
        const member = await orgMember(stores, viewer, orgHandle);
        if (!member.ok) return member;
        const { org, role } = member.value;
        const canManage = managesOrgEntries(role);
        const [secrets, variables, repositories, audit] = await Promise.all([
          stores.orgSecrets.list(org.id),
          stores.variables.listOrg(org.id),
          registry.byOwner(org.id),
          canManage ? orgAuditLog(db, org.id) : Promise.resolve([]),
        ]);
        const settings: OrgActionsSettings = {
          org,
          canManage,
          secrets,
          variables,
          repositories: repositories.map((repo) => ({
            id: repo.id,
            name: repo.name,
            visibility: repo.visibility,
          })),
          audit,
        };
        return ok(settings);
      }),
    putOrgSecret: (viewer, orgHandle, input) =>
      guarded(async () => {
        const manager = await orgManager(stores, viewer, orgHandle);
        if (!manager.ok) return manager;
        const parsed = PutOrgSecretInputSchema.safeParse(input);
        if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'invalid secret');
        const { org } = manager.value;
        const stamp = await by(viewer);
        const saved = await stores.orgSecrets.put(org.id, parsed.data, stamp);
        if (saved === null)
          return invalid(`no org secret ${parsed.data.name}: give a value to create it`);
        await auditOrg(db, {
          orgId: org.id,
          viewer,
          actor: stamp.actor,
          action: 'org-secret-set',
          detail: viaDetail(
            orgAuditDetail(saved.name, saved.access, saved.prelandAllowed),
            options,
          ),
        });
        return ok(saved);
      }),
    deleteOrgSecret: (viewer, orgHandle, name) =>
      guarded(async () => {
        const manager = await orgManager(stores, viewer, orgHandle);
        if (!manager.ok) return manager;
        const { org } = manager.value;
        const deleted = await stores.orgSecrets.delete(org.id, name);
        if (deleted)
          await auditOrg(db, {
            orgId: org.id,
            viewer,
            actor: await handleOf(env, viewer),
            action: 'org-secret-deleted',
            detail: viaDetail(name.toUpperCase(), options),
          });
        return ok({ deleted });
      }),
    putOrgVariable: (viewer, orgHandle, input) =>
      guarded(async () => {
        const manager = await orgManager(stores, viewer, orgHandle);
        if (!manager.ok) return manager;
        const parsed = PutOrgVariableInputSchema.safeParse(input);
        if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'invalid variable');
        const { org } = manager.value;
        const stamp = await by(viewer);
        const saved = await stores.variables.putOrg(org.id, parsed.data, stamp);
        await auditOrg(db, {
          orgId: org.id,
          viewer,
          actor: stamp.actor,
          action: 'org-variable-set',
          detail: viaDetail(orgAuditDetail(saved.name, saved.access, null), options),
        });
        return ok(saved);
      }),
    deleteOrgVariable: (viewer, orgHandle, name) =>
      guarded(async () => {
        const manager = await orgManager(stores, viewer, orgHandle);
        if (!manager.ok) return manager;
        const { org } = manager.value;
        const deleted = await stores.variables.deleteOrg(org.id, name);
        if (deleted)
          await auditOrg(db, {
            orgId: org.id,
            viewer,
            actor: await handleOf(env, viewer),
            action: 'org-variable-deleted',
            detail: viaDetail(name.toUpperCase(), options),
          });
        return ok({ deleted });
      }),
  };
}

type Membership = { readonly org: Org; readonly role: OrgRole };

/** The org and the viewer's role in it; people outside the org get `not_found`. */
async function orgMember(
  stores: EntryStores,
  viewer: Viewer,
  orgHandle: string,
): Promise<RpcResult<Membership>> {
  const org = await stores.orgs.orgByHandle(orgHandle);
  const role = org === null || viewer === null ? null : await stores.orgs.orgRole(org.id, viewer);
  if (org === null || role === null)
    return failed({
      code: 'not_found',
      status: 404,
      message: `organization ${orgHandle} not found`,
    });
  return ok({ org, role });
}

/** As `orgMember`, refusing members who are not owners or admins. */
async function orgManager(
  stores: EntryStores,
  viewer: Viewer,
  orgHandle: string,
): Promise<RpcResult<Membership>> {
  const member = await orgMember(stores, viewer, orgHandle);
  if (!member.ok || managesOrgEntries(member.value.role)) return member;
  return failed({
    code: 'forbidden',
    status: 403,
    message: `org owners and admins manage secrets and variables; you are a ${member.value.role}`,
  });
}

function sourceOf(entry: Sourced<unknown>, orgHandle: string | null): EntrySource {
  return entry.from === 'organization' && orgHandle !== null
    ? { kind: 'organization', orgHandle }
    : { kind: 'repository' };
}

function effectiveSecretOf(
  entry: Sourced<{
    readonly prelandAllowed: boolean;
    readonly updatedAt: string;
    readonly updatedBy: string;
  }>,
  orgHandle: string | null,
): EffectiveSecret {
  return {
    name: SecretName.parse(entry.name),
    prelandAllowed: entry.prelandAllowed,
    updatedAt: entry.updatedAt,
    updatedBy: entry.updatedBy,
    source: sourceOf(entry, orgHandle),
    overridden: entry.overridden,
  };
}

function effectiveVariableOf(
  entry: Sourced<{
    readonly value: string;
    readonly updatedAt: string;
    readonly updatedBy: string;
  }>,
  orgHandle: string | null,
): EffectiveVariable {
  return {
    name: VariableName.parse(entry.name),
    value: entry.value,
    updatedAt: entry.updatedAt,
    updatedBy: entry.updatedBy,
    source: sourceOf(entry, orgHandle),
    overridden: entry.overridden,
  };
}

function viaDetail(detail: string, options: { readonly via?: string }): string {
  return auditDetail(detail, options.via);
}

/** `DEPLOY_KEY · selected: 2 repositories · pre-land` (never a value). */
function orgAuditDetail(
  name: string,
  access: RepositoryAccessPolicy,
  prelandAllowed: boolean | null,
): string {
  const reach =
    access.kind === 'selected'
      ? `selected: ${access.repoIds.length} ${access.repoIds.length === 1 ? 'repository' : 'repositories'}`
      : `${access.kind} repositories`;
  return [name, reach, prelandAllowed === true ? 'available to pre-land checks' : null]
    .filter((part) => part !== null)
    .join(' · ');
}

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value };
}

function failed<T>(error: RpcError): RpcResult<T> {
  return { ok: false, error };
}

function invalid<T>(message: string): RpcResult<T> {
  return failed({ code: 'invalid_request', status: 400, message });
}

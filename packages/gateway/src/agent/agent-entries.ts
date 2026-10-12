/**
 * Actions secrets and variables for an MCP session: the repository's own and its org's, as
 * Settings → Secrets and variables shows them (any role reads secret names and variable values;
 * maintainers and the owner change the repository's, org owners and admins the org's). The
 * session also needs the `secrets` scope to change anything. A secret's value goes one way: it
 * is sealed by the same store the web uses and never returned. A new org entry reaches only
 * this repository (`selected`); an existing one keeps its reach and pre-land toggle.
 */
import type {
  AgentActionsEntries,
  AgentEntryDeleted,
  AgentSecret,
  AgentVariable,
  AgentEntrySaved,
  EntryLevel,
} from '@gitstalk/shared-race/agent-actions';
import {
  AgentEntryRef,
  AgentPutSecretInput,
  AgentPutVariableInput,
} from '@gitstalk/shared-race/agent-actions';
import type {
  EffectiveSecret,
  EffectiveVariable,
  RepositoryAccessPolicy,
} from '@gitstalk/shared-race/actions-secrets';
import type { RpcResult } from '@gitstalk/shared-race/rpc';

import type { ActionsTarget } from './actions-target';
import { failure } from './agent-access';

export async function listEntries(target: ActionsTarget): Promise<RpcResult<AgentActionsEntries>> {
  const listed = await target.entries.repoActionsEntries(target.viewer, target.record.id);
  if (!listed.ok) return listed;
  const { canManage, orgHandle } = listed.value;
  return ok({
    repo: target.repo,
    can_manage: canManage,
    org: orgHandle,
    secrets: listed.value.secrets.map(secretView),
    variables: listed.value.variables.map(variableView),
  });
}

export async function putSecret(
  target: ActionsTarget,
  raw: unknown,
): Promise<RpcResult<AgentEntrySaved>> {
  const input = AgentPutSecretInput.safeParse(raw);
  if (!input.success) return invalid(input.error.issues[0]?.message ?? 'invalid secret');
  const { name, value } = input.data;
  const level = input.data.level ?? 'repository';
  const current = await target.entries.repoActionsEntries(target.viewer, target.record.id);
  if (!current.ok) return current;
  const own = sameName(current.value.secrets, name, level);
  if (level === 'repository') {
    const saved = await target.actions.putSecret(target.viewer, target.record.id, {
      name,
      value,
      prelandAllowed: own?.prelandAllowed ?? false,
    });
    return saved.ok ? ok(savedView(target, { ...saved.value, level, org: null })) : saved;
  }
  const org = orgOf(current.value.orgHandle);
  if (!org.ok) return org;
  const reach = await orgReach(target, { org: org.value, name, kind: 'secret' });
  if (!reach.ok) return reach;
  const saved = await target.entries.putOrgSecret(target.viewer, org.value, {
    name,
    value,
    access: reach.value.access,
    prelandAllowed: reach.value.prelandAllowed,
  });
  return saved.ok ? ok(savedView(target, { ...saved.value, level, org: org.value })) : saved;
}

export async function putVariable(
  target: ActionsTarget,
  raw: unknown,
): Promise<RpcResult<AgentEntrySaved>> {
  const input = AgentPutVariableInput.safeParse(raw);
  if (!input.success) return invalid(input.error.issues[0]?.message ?? 'invalid variable');
  const { name, value } = input.data;
  const level = input.data.level ?? 'repository';
  if (level === 'repository') {
    const saved = await target.entries.putVariable(target.viewer, target.record.id, {
      name,
      value,
    });
    return saved.ok ? ok(savedView(target, { ...saved.value, level, org: null })) : saved;
  }
  const org = await orgOfRepository(target);
  if (!org.ok) return org;
  const reach = await orgReach(target, { org: org.value, name, kind: 'variable' });
  if (!reach.ok) return reach;
  const saved = await target.entries.putOrgVariable(target.viewer, org.value, {
    name,
    value,
    access: reach.value.access,
  });
  return saved.ok ? ok(savedView(target, { ...saved.value, level, org: org.value })) : saved;
}

export async function deleteEntry(
  target: ActionsTarget,
  input: { readonly raw: unknown; readonly kind: 'secret' | 'variable' },
): Promise<RpcResult<AgentEntryDeleted>> {
  const ref = AgentEntryRef.safeParse(input.raw);
  if (!ref.success) return invalid(ref.error.issues[0]?.message ?? `invalid ${input.kind}`);
  const name = ref.data.name.toUpperCase();
  const level = ref.data.level ?? 'repository';
  const deleted = await deleteAt(target, { name, level, kind: input.kind });
  return deleted.ok ? ok({ repo: target.repo, name, level, deleted: deleted.value }) : deleted;
}

async function deleteAt(
  target: ActionsTarget,
  input: {
    readonly name: string;
    readonly level: EntryLevel;
    readonly kind: 'secret' | 'variable';
  },
): Promise<RpcResult<boolean>> {
  const { viewer, record, actions, entries } = target;
  if (input.level === 'repository') {
    const deleted =
      input.kind === 'secret'
        ? await actions.deleteSecret(viewer, record.id, input.name)
        : await entries.deleteVariable(viewer, record.id, input.name);
    return deleted.ok ? ok(deleted.value.deleted) : deleted;
  }
  const org = await orgOfRepository(target);
  if (!org.ok) return org;
  const deleted =
    input.kind === 'secret'
      ? await entries.deleteOrgSecret(viewer, org.value, input.name)
      : await entries.deleteOrgVariable(viewer, org.value, input.name);
  return deleted.ok ? ok(deleted.value.deleted) : deleted;
}

/** An existing org entry's reach (kept), or this repository alone for a new one. */
async function orgReach(
  target: ActionsTarget,
  input: { readonly org: string; readonly name: string; readonly kind: 'secret' | 'variable' },
): Promise<
  RpcResult<{ readonly access: RepositoryAccessPolicy; readonly prelandAllowed: boolean }>
> {
  const settings = await target.entries.orgActionsSettings(target.viewer, input.org);
  if (!settings.ok) return settings;
  const name = input.name.toUpperCase();
  const existing =
    input.kind === 'secret'
      ? settings.value.secrets.find((secret) => secret.name === name)
      : settings.value.variables.find((variable) => variable.name === name);
  if (existing === undefined)
    return ok({ access: { kind: 'selected', repoIds: [target.record.id] }, prelandAllowed: false });
  return ok({
    access: existing.access,
    prelandAllowed: 'prelandAllowed' in existing ? existing.prelandAllowed : false,
  });
}

async function orgOfRepository(target: ActionsTarget): Promise<RpcResult<string>> {
  const current = await target.entries.repoActionsEntries(target.viewer, target.record.id);
  return current.ok ? orgOf(current.value.orgHandle) : current;
}

function orgOf(handle: string | null): RpcResult<string> {
  return handle === null
    ? invalid('this repository belongs to a person, not an organization: use level repository')
    : ok(handle);
}

function sameName<E extends EffectiveSecret | EffectiveVariable>(
  entries: readonly E[],
  name: string,
  level: EntryLevel,
): E | undefined {
  const wanted = name.toUpperCase();
  return entries.find((entry) => entry.name === wanted && levelOf(entry.source.kind) === level);
}

function secretView(secret: EffectiveSecret): AgentSecret {
  return { ...entryBase(secret), preland_allowed: secret.prelandAllowed };
}

function variableView(variable: EffectiveVariable): AgentVariable {
  return { ...entryBase(variable), value: variable.value };
}

function entryBase(entry: EffectiveSecret | EffectiveVariable) {
  return {
    name: entry.name,
    level: levelOf(entry.source.kind),
    org: entry.source.kind === 'organization' ? entry.source.orgHandle : null,
    updated_at: entry.updatedAt,
    updated_by: entry.updatedBy,
    overridden: entry.overridden,
  };
}

function levelOf(source: 'repository' | 'organization'): EntryLevel {
  return source;
}

function savedView(
  target: ActionsTarget,
  saved: {
    readonly name: string;
    readonly level: EntryLevel;
    readonly org: string | null;
    readonly updatedAt: string;
    readonly updatedBy: string;
  },
): AgentEntrySaved {
  return {
    repo: target.repo,
    name: saved.name,
    level: saved.level,
    org: saved.org,
    updated_at: saved.updatedAt,
    updated_by: saved.updatedBy,
  };
}

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value };
}

function invalid<T>(message: string): RpcResult<T> {
  return failure('invalid_request', 400, message);
}

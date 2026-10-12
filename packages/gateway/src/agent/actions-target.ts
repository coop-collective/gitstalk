/**
 * The repository an MCP session's Actions call is about, opened the way the web opens it: the
 * session's scope first (`read`, `write` to run, `secrets` to change secrets and variables),
 * then the repository by the git rule (`openRepository`: read role, 404 when hidden), then the
 * person's own Actions RPC (`actionsRpc`, `actionsEntriesRpc`), which checks the maintain role
 * for changes exactly as it does for the web. Changes are audited as the person, via the client.
 */
import type { ActionsRpc } from '@gitstalk/shared-race/actions';
import type { ActionsEntriesRpc } from '@gitstalk/shared-race/actions-secrets';
import type { AgentPrincipal, SessionScope } from '@gitstalk/shared-race/agent-repos';
import type { RepositoryRecord } from '@gitstalk/shared-race/repos';
import type { RpcResult } from '@gitstalk/shared-race/rpc';

import type { RepositoryForViewer } from '@gitstalk/shared-race/collaborators';

import { actionsRpc } from '../actions/actions-rpc';
import { actionsEntriesRpc } from '../actions/entries-rpc';
import type { Deps } from '../deps';
import { GatewayError } from '../errors';
import { accessResult, viewerPrincipal } from '../repos/access';
import type { Opened } from './agent-access';
import { failure, openRepository, scopeMessage } from './agent-access';

export type ActionsTarget = {
  readonly env: Env;
  readonly deps: Deps;
  readonly opened: Opened;
  readonly record: RepositoryRecord;
  /** `owner/name`. */
  readonly repo: string;
  /** The person, as the Actions RPC names its viewer. */
  readonly viewer: string;
  readonly actions: ActionsRpc;
  readonly entries: ActionsEntriesRpc;
};

/** What a call needs from the session: reading, or a scope for a change (and what it is). */
export type ActionsNeed =
  | { readonly kind: 'read' }
  | {
      readonly kind: 'act';
      readonly scopes: readonly Exclude<SessionScope, 'read'>[];
      readonly what: string;
    };

export const READ_ACTIONS: ActionsNeed = { kind: 'read' };
export const RUN_WORKFLOWS: ActionsNeed = {
  kind: 'act',
  scopes: ['write'],
  what: 'Running, re-running or cancelling workflows',
};
export const MANAGE_ENTRIES: ActionsNeed = {
  kind: 'act',
  scopes: ['secrets'],
  what: 'Changing Actions secrets and variables',
};

/** Opens the repository for `need`, then runs `use`; gateway errors become values. */
export async function withTarget<T>(
  input: {
    readonly env: Env;
    readonly deps: Deps;
    readonly principal: AgentPrincipal;
    readonly repo: string;
    readonly need: ActionsNeed;
  },
  use: (target: ActionsTarget) => Promise<RpcResult<T>>,
): Promise<RpcResult<T>> {
  try {
    const target = await openTarget(input);
    return target.ok ? await use(target.value) : target;
  } catch (error: unknown) {
    if (error instanceof GatewayError) return failure(error.code, error.status, error.message);
    throw error;
  }
}

async function openTarget(input: {
  readonly env: Env;
  readonly deps: Deps;
  readonly principal: AgentPrincipal;
  readonly repo: string;
  readonly need: ActionsNeed;
}): Promise<RpcResult<ActionsTarget>> {
  const { env, deps, principal, need } = input;
  if (need.kind === 'act' && !need.scopes.some((scope) => principal.scopes.includes(scope)))
    return failure('insufficient_scope', 403, scopeMessage(need));
  const opened = await openRepository(deps, {
    principal,
    repo: input.repo,
    need: { kind: 'read' },
  });
  if (!opened.ok) return opened;
  const record = await deps.registry.byEngine(opened.value.engineId);
  const repo = opened.value.repository.repo;
  if (record === null) return failure('not_found', 404, `repository ${repo} not found`);
  const via = { via: principal.label };
  return {
    ok: true,
    value: {
      env,
      deps,
      opened: opened.value,
      record,
      repo,
      viewer: principal.user.id,
      actions: actionsRpc(env, via),
      entries: actionsEntriesRpc(env, undefined, via),
    },
  };
}

/** Whether the person may run workflows and manage Actions here (maintain), as the web asks. */
export function mayManageActions(target: ActionsTarget): Promise<RpcResult<RepositoryForViewer>> {
  return accessResult(target.deps.collaborators, target.record, {
    principal: viewerPrincipal(target.viewer),
    action: 'actions',
    what: target.repo,
  });
}

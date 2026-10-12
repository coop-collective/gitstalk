/**
 * Which repository an agent session may work on, by the rule git and the web use: the
 * session is its person's credential (role capped by the session's scopes) and `mayUseEngine`
 * decides, through the registry's access facts (`../repos/access.ts`). Reading needs the read
 * role; opening beans and claiming tasks need the write role and the `write` scope. A
 * repository the person may not see answers 404, as git does. Deploy tokens never reach here
 * (MCP sessions are people, verified by the MCP Worker).
 */
import type {
  AgentPrincipal,
  AgentRepository,
  SessionScope,
} from '@gitstalk/shared-race/agent-repos';
import { RepoSlug } from '@gitstalk/shared-race/agent-repos';
import type { RepositoryAction, ViewerRole } from '@gitstalk/shared-race/collaborators';
import { RunId } from '@gitstalk/shared-race/ids';
import type { RepositoryRecord } from '@gitstalk/shared-race/repos';
import type { RpcError, RpcResult } from '@gitstalk/shared-race/rpc';
import { parseScopes } from '@gitstalk/shared-identity/scopes';

import type { RepositoryPrincipal } from '../auth/git-credential';
import { gitScopes } from '../auth/git-credential';
import type { Deps } from '../deps';
import { accessResult, decideAccess } from '../repos/access';
import type { RunDO } from '../run/run-do';

/** A repository the session may use, with its engine. */
export type Opened = {
  readonly repository: AgentRepository;
  readonly engineId: RunId;
  readonly engine: DurableObjectStub<RunDO>;
};

/** What a call needs: reading, or work that changes something (with the scope it takes). */
export type Need =
  | { readonly kind: 'read' }
  | { readonly kind: 'act'; readonly scopes: readonly SessionScope[]; readonly what: string };

/** Opens `owner/name` for the principal, or says why not (400, 403, 404). */
export async function openRepository(
  deps: Deps,
  input: { readonly principal: AgentPrincipal; readonly repo: string; readonly need: Need },
): Promise<RpcResult<Opened>> {
  const { principal, need } = input;
  if (!principal.scopes.includes('read'))
    return failure('forbidden', 403, 'this session has no read scope');
  if (need.kind === 'act' && !need.scopes.some((scope) => principal.scopes.includes(scope)))
    return failure('insufficient_scope', 403, scopeMessage(need));
  const slug = RepoSlug.safeParse(input.repo);
  if (!slug.success) return failure('invalid_request', 400, 'name the repository as owner/name');
  const [owner = '', name = ''] = slug.data.split('/');
  const action: RepositoryAction = need.kind === 'read' ? 'read' : 'write';
  const record = await deps.registry.resolve(owner, name);
  const decided = await accessResult(deps.collaborators, record, {
    principal: agentRepositoryPrincipal(principal),
    action,
    what: slug.data,
  });
  if (!decided.ok) return decided;
  const engineId = RunId.safeParse(decided.value.engine_id);
  const missing = failure('not_found', 404, `repository ${slug.data} not found`);
  if (!engineId.success) return missing;
  const engine = deps.run(engineId.data);
  if ((await engine.repoEngine()) === null) return missing;
  await recordUse(deps, decided.value, principal);
  const access = action === 'write' ? 'write' : await accessOf(deps, decided.value, principal);
  return {
    ok: true,
    value: {
      repository: describe(decided.value, { access, role: decided.value.viewer_role }),
      engineId: engineId.data,
      engine,
    },
  };
}

/** The repositories the person owns or collaborates on, as the session may use them. */
export async function personRepositories(
  deps: Deps,
  principal: AgentPrincipal,
): Promise<RpcResult<readonly AgentRepository[]>> {
  if (!principal.scopes.includes('read'))
    return failure('forbidden', 403, 'this session has no read scope');
  const [owned, memberships] = await Promise.all([
    deps.registry.byOwner(principal.user.id),
    deps.collaborators.memberships(principal.user.id),
  ]);
  const shared = await deps.registry.byIds(memberships.map((member) => member.repoId));
  const described = await Promise.all(
    [...owned, ...shared].map(async (record) => {
      const read = await decideAccess(deps.collaborators, record, {
        principal: agentRepositoryPrincipal(principal),
        action: 'read',
      });
      if (read.verdict !== 'allowed') return [];
      const access = await accessOf(deps, record, principal);
      return [describe(record, { access, role: read.role })];
    }),
  );
  return { ok: true, value: described.flat() };
}

export function failure(
  code: string,
  status: number,
  message: string,
): { ok: false; error: RpcError } {
  return { ok: false, error: { code, status, message } };
}

/**
 * The session as `mayUseEngine` sees it: its person's credential, capped by its scopes. The
 * one place an MCP session becomes a principal: the repository tools here and the
 * `agentRepositoryAccess` RPC (`repository_access`) both use it, so they answer as git does.
 */
export function agentRepositoryPrincipal(principal: AgentPrincipal): RepositoryPrincipal {
  return {
    kind: 'credential',
    credential: {
      user: { id: principal.user.id, handle: principal.user.handle },
      scopes: gitScopes(parseScopes(principal.scopes)),
      engine: null,
      runPrincipal: null,
      session: { via: 'mcp', id: `${principal.user.id}/${principal.label}` },
    },
  };
}

/** `write` when this session may push beans here (role and scope), else `read`. */
async function accessOf(
  deps: Deps,
  record: RepositoryRecord,
  principal: AgentPrincipal,
): Promise<'write' | 'read'> {
  const write = await decideAccess(deps.collaborators, record, {
    principal: agentRepositoryPrincipal(principal),
    action: 'write',
  });
  return write.verdict === 'allowed' ? 'write' : 'read';
}

/** The repository's sessions list shows this agent, as the collaborators RPC records it. */
async function recordUse(
  deps: Deps,
  record: RepositoryRecord,
  principal: AgentPrincipal,
): Promise<void> {
  await deps.collaborators.recordUse({
    repoId: record.id,
    user: principal.user,
    via: 'mcp',
    credentialId: `${principal.user.id}/${principal.label}`,
    label: principal.label,
    action: 'read',
  });
}

function describe(
  record: RepositoryRecord,
  input: { readonly access: 'write' | 'read'; readonly role: ViewerRole | null },
): AgentRepository {
  const repo = `${record.owner.handle}/${record.name}`;
  return {
    repo,
    description: record.description,
    visibility: record.visibility,
    role: input.role,
    access: input.access,
    engine_id: record.engine_id,
    git_path: `/git/${repo}.git`,
  };
}

export function scopeMessage(need: Extract<Need, { kind: 'act' }>): string {
  const scopes = need.scopes.join(' or ');
  return `${need.what} needs the ${scopes} scope; reconnect the agent and tick ${scopes} on the consent page`;
}

/** Contributor capabilities are verified again at the gateway before every mutation. */
import { z } from 'zod';

import {
  BeanContextInput,
  BeanDiscoverInput,
  BeanInboxAckInput,
  BeanInboxReadInput,
  BeanSummariesInput,
  BeanThreadPostInput,
  BeanUpdateInput,
  ContributorTokenClaims,
} from '@gitstalk/shared-race/collaboration';
import { BeanCommitInput } from '@gitstalk/shared-race/bean-commit';
import { RunId } from '@gitstalk/shared-race/ids';
import type {
  CollaborationRpc,
  McpTokenClaims,
  RpcError,
  RpcResult,
} from '@gitstalk/shared-race/rpc';

import { verifyToken } from '../auth/tokens';
import type { Deps } from '../deps';

export function collaborationRpc(deps: Deps): CollaborationRpc {
  return {
    verifyMcpToken: (token) => verifyMcpToken(deps, token),
    beanContext: async (run, input) => {
      const id = RunId.safeParse(run);
      const parsed = BeanContextInput.safeParse(input);
      if (!id.success || !parsed.success) return invalid('invalid run or bean context request');
      return deps.run(id.data).beanContext(parsed.data);
    },
    beanDiscover: async (run, input) => {
      const id = RunId.safeParse(run);
      const parsed = BeanDiscoverInput.safeParse(input);
      if (!id.success || !parsed.success) return invalid('invalid run or discovery request');
      return deps.run(id.data).beanDiscover(parsed.data);
    },
    beanPeerSummaries: async (run, beans) => {
      const id = RunId.safeParse(run);
      const parsed = BeanSummariesInput.safeParse(beans);
      if (!id.success || !parsed.success) return invalid('invalid run or bean summaries request');
      return deps.run(id.data).beanPeerSummaries(parsed.data);
    },
    beanUpdate: (token, input) =>
      forContributor(deps, token, async (claims) => {
        const parsed = BeanUpdateInput.safeParse(input);
        if (!parsed.success) return invalid(z.prettifyError(parsed.error));
        return deps.run(claims.run).beanUpdate(claims, parsed.data);
      }),
    beanCommit: (token, input) =>
      forContributor(deps, token, async (claims) => {
        const parsed = BeanCommitInput.safeParse(input);
        if (!parsed.success) return invalid(z.prettifyError(parsed.error));
        return deps.run(claims.run).beanCommit(claims, parsed.data);
      }),
    beanThreadPost: (token, input) =>
      forContributor(deps, token, async (claims) => {
        const parsed = BeanThreadPostInput.safeParse(input);
        if (!parsed.success) return invalid(z.prettifyError(parsed.error));
        return deps.run(claims.run).beanThreadPost(claims, parsed.data);
      }),
    beanInboxRead: (token, input) =>
      forContributor(deps, token, async (claims) => {
        const parsed = BeanInboxReadInput.safeParse(input);
        if (!parsed.success) return invalid(z.prettifyError(parsed.error));
        return deps.run(claims.run).beanInboxRead(claims, parsed.data);
      }),
    beanInboxAck: (token, input) =>
      forContributor(deps, token, async (claims) => {
        const parsed = BeanInboxAckInput.safeParse(input);
        if (!parsed.success) return invalid(z.prettifyError(parsed.error));
        return deps.run(claims.run).beanInboxAck(claims, parsed.data);
      }),
  };
}

async function verifyMcpToken(deps: Deps, token: string): Promise<RpcResult<McpTokenClaims>> {
  const check = await verifyToken(deps.tokenSecret, token, deps.now());
  if (!check.ok) return refuse(401, `run token ${check.failure.replace('_', ' ')}`);
  const { run, sub, scope, bean, exp } = check.claims;
  const expires_at = new Date(exp * 1000).toISOString();
  if (scope === 'view') return { ok: true, value: { scope, run, sub, expires_at } };
  if (scope !== 'contributor') return refuse(403, 'use a view or contributor token for MCP');
  const claims = ContributorTokenClaims.safeParse({ scope, run, bean, actor: sub, expires_at });
  return claims.success
    ? { ok: true, value: claims.data }
    : refuse(401, 'invalid contributor capability');
}

async function forContributor<T>(
  deps: Deps,
  token: string,
  use: (claims: ContributorTokenClaims) => Promise<RpcResult<T>>,
): Promise<RpcResult<T>> {
  const check = await verifyMcpToken(deps, token);
  if (!check.ok) return check;
  if (check.value.scope !== 'contributor') return refuse(403, 'a contributor token is required');
  return use(check.value);
}

function refuse(
  status: 401 | 403,
  message: string,
): { readonly ok: false; readonly error: RpcError } {
  return {
    ok: false,
    error: { code: status === 401 ? 'unauthorized' : 'forbidden', status, message },
  };
}

function invalid(message: string): { readonly ok: false; readonly error: RpcError } {
  return { ok: false, error: { code: 'invalid_request', status: 400, message } };
}

/**
 * The GATEWAY binding's repository RPC for agent sessions (`AgentReposRpc`), narrowed from
 * the plain binding, plus the few answers this Worker reads fields of (validated here; the
 * rest goes to the model as the gateway wrote it).
 */
import { z } from 'zod';

import type { AgentActionsRpc } from '@gitstalk/shared-race/agent-actions';
import type { AgentReposRpc } from '@gitstalk/shared-race/agent-repos';
import type { RpcResult } from '@gitstalk/shared-race/rpc';

import { ForgeError } from '@gitstalk/shared-ask/forge/forge-errors';

import { ToolError } from '../mcp/tool-result';

const AGENT_METHODS = [
  'agentRepositories',
  'agentRepository',
  'agentPushedBeans',
  'agentBean',
  'agentWaitBean',
  'agentOpenBean',
  'agentBacklog',
  'agentClaimTask',
  'agentReleaseTask',
] as const satisfies readonly (keyof AgentReposRpc)[];

const ACTIONS_METHODS = [
  'agentWorkflows',
  'agentRuns',
  'agentRun',
  'agentJobLog',
  'agentDispatch',
  'agentRerun',
  'agentCancel',
  'agentWaitRun',
  'agentActionsEntries',
  'agentPutSecret',
  'agentDeleteSecret',
  'agentPutVariable',
  'agentDeleteVariable',
  'agentAutomation',
  'agentRunAutomation',
] as const satisfies readonly (keyof AgentActionsRpc)[];

/** The binding as `AgentActionsRpc`, or undefined when the gateway predates it. */
export function asAgentActions(binding: object): AgentActionsRpc | undefined {
  return isAgentActions(binding) ? binding : undefined;
}

function isAgentActions(binding: object): binding is AgentActionsRpc {
  return ACTIONS_METHODS.every((method) => typeof Reflect.get(binding, method) === 'function');
}

/** The binding as `AgentReposRpc`, or undefined when it does not answer to it. */
export function asAgentRepos(binding: object): AgentReposRpc | undefined {
  return isAgentRepos(binding) ? binding : undefined;
}

function isAgentRepos(binding: object): binding is AgentReposRpc {
  return AGENT_METHODS.every((method) => typeof Reflect.get(binding, method) === 'function');
}

/** A repository the session may use, as this Worker reads it. */
export const RepositoryAnswer = z.object({
  repo: z.string(),
  access: z.enum(['write', 'read']),
  engine_id: z.string(),
  git_path: z.string(),
});
export type RepositoryAnswer = z.infer<typeof RepositoryAnswer>;

/**
 * An RPC answer for the model: the value, or a `ToolError` with the gateway's message (404
 * for repositories the person may not use, 403 for scopes, 409 for names and claims taken).
 */
export function valueOf<T>(result: RpcResult<T>): T {
  if (result.ok) return result.value;
  throw new ToolError(result.error.message);
}

/** Validates an answer this Worker reads fields of. */
export function parsed<S extends z.ZodType>(result: RpcResult<unknown>, schema: S): z.infer<S> {
  const value = schema.safeParse(valueOf(result));
  if (!value.success)
    throw new ForgeError(
      `unexpected gateway answer: ${z.prettifyError(value.error)}`,
      'bad_response',
    );
  return value.data;
}

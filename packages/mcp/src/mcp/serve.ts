/**
 * Serves one MCP request over Streamable HTTP (the Agents SDK's stateless handler) for a
 * caller already authenticated: a run token's viewer or contributor, or an OAuth session.
 */
import { createMcpHandler } from 'agents/mcp/server';

import { classifierFrom } from '@gitstalk/shared-ask/ask/classifier-from-env';
import { gatewaySource } from '@gitstalk/shared-ask/forge/gateway-source';
import { memoSource } from '@gitstalk/shared-ask/forge/memo-source';
import { pickerFrom } from '@gitstalk/shared-ask/pick/picker-from-env';
import type { AgentActionsRpc } from '@gitstalk/shared-race/agent-actions';
import type { AgentReposRpc } from '@gitstalk/shared-race/agent-repos';
import type { RunId } from '@gitstalk/shared-race/ids';
import { RunId as RunIdSchema } from '@gitstalk/shared-race/ids';
import type { GatewayRpc } from '@gitstalk/shared-race/rpc';

import type { ContributorSession } from '../auth/bearer';
import type { Logger } from '../log';
import { RepositoryAnswer, parsed } from '../repos/agent-gateway';
import type { AgentSessionContext, ToolContext, ToolScope } from '../tools/tool-context';
import { toolContext } from '../tools/tool-context';
import { createServer } from './server';
import { ToolError } from './tool-result';

export const MCP_ROUTE = '/mcp';

export type McpCaller = {
  /** The caller's own run: a run token's, or the run a session reads by default (if any). */
  readonly run: RunId | null;
  /** Who, for logs: a slot, an actor, or a user id. */
  readonly sub: string;
  readonly contributor?: ContributorSession;
  readonly session?: AgentSessionContext;
};

export function serveMcp(
  request: Request,
  input: {
    readonly env: Env;
    readonly ctx: ExecutionContext;
    readonly gateway: GatewayRpc;
    readonly agents?: AgentReposRpc;
    readonly actions?: AgentActionsRpc;
    readonly log: Logger;
    readonly caller: McpCaller;
  },
): Promise<Response> {
  const { env, log, caller } = input;
  const scope = toolScope(input);
  const handler = createMcpHandler(() => createServer(scope), {
    route: MCP_ROUTE,
    onerror: (error) => log.error('mcp handler error', { run: caller.run, sub: caller.sub, error }),
  });
  return handler(request, env, input.ctx);
}

/** The caller's run and, for sessions, the repositories named per call. */
function toolScope(input: Parameters<typeof serveMcp>[1]): ToolScope {
  const { env, caller, agents } = input;
  const contexts = new Map<RunId, ToolContext>();
  const contextFor = (run: RunId): ToolContext => {
    const known = contexts.get(run);
    if (known !== undefined) return known;
    const created = newContext(input, run);
    contexts.set(run, created);
    return created;
  };
  const own = caller.run === null ? null : contextFor(caller.run);
  const { session } = caller;
  return {
    own,
    async context(repo) {
      if (repo === undefined) {
        if (own !== null) return own;
        throw new ToolError('name a repository as repo: "owner/name" (repo_list shows yours)');
      }
      if (session === undefined || agents === undefined)
        throw new ToolError('this token reads one run; repo is for signed-in agent sessions');
      const repository = parsed(
        await agents.agentRepository(session.principal, repo),
        RepositoryAnswer,
      );
      const engine = RunIdSchema.safeParse(repository.engine_id);
      if (!engine.success) throw new ToolError(`${repo} has no engine yet`);
      return contextFor(engine.data);
    },
    ...(session === undefined ? {} : { session }),
    ...(agents === undefined ? {} : { agents }),
    ...(input.actions === undefined || session === undefined ? {} : { actions: input.actions }),
    gateway: input.gateway,
    gitOrigin: env.GIT_ORIGIN,
    webUrl: env.WEB_URL,
  };
}

function newContext(input: Parameters<typeof serveMcp>[1], run: RunId): ToolContext {
  const { env, gateway, log, caller } = input;
  return toolContext({
    run,
    gateway,
    log,
    ...(caller.contributor === undefined ? {} : { contributor: caller.contributor }),
    ...(caller.session === undefined ? {} : { session: caller.session }),
    // Per request: repeated reads within one MCP call are shared, never across calls.
    source: memoSource(gatewaySource(gateway)),
    classifier: classifierFrom({
      name: env.ASK_CLASSIFIER,
      model: env.ASK_AI_MODEL,
      ai: Reflect.get(env, 'AI'),
    }),
    picker: pickerFrom({
      name: env.PICKER,
      ai: Reflect.get(env, 'AI'),
      gateway: env.DECISION_GATEWAY,
      onError: (decision, error) =>
        log.warn('decision model pick fell back to the rule', { run, decision, error }),
    }),
    webUrl: env.WEB_URL,
  });
}

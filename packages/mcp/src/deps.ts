/**
 * What the app needs from the outside world, so tests can hand it a fake gateway: the
 * GATEWAY binding narrowed to the gateway's RPC, and a logger.
 */
import type { AgentActionsRpc } from '@gitstalk/shared-race/agent-actions';
import type { AgentReposRpc } from '@gitstalk/shared-race/agent-repos';
import type { GatewayRpc } from '@gitstalk/shared-race/rpc';

import { asGatewayBinding } from '@gitstalk/shared-ask/forge/gateway-rpc';

import type { Logger } from './log';
import { createLogger, isLogLevel } from './log';
import { asAgentActions, asAgentRepos } from './repos/agent-gateway';

export type Deps = {
  /** The gateway's RPC, or undefined when the binding does not expose it. */
  readonly gateway: GatewayRpc | undefined;
  /** The gateway's repository RPC for agent sessions, or undefined when it lacks it. */
  readonly agents?: AgentReposRpc | undefined;
  /** The gateway's Actions RPC for agent sessions, or undefined when it lacks it. */
  readonly actions?: AgentActionsRpc | undefined;
  readonly log: Logger;
};

/** Production dependencies, read from the Worker's bindings. */
export function depsFromEnv(env: Env): Deps {
  return {
    gateway: asGatewayBinding(env.GATEWAY),
    agents: asAgentRepos(env.GATEWAY),
    actions: asAgentActions(env.GATEWAY),
    log: createLogger(isLogLevel(env.LOG_LEVEL) ? env.LOG_LEVEL : 'info', {
      worker: 'gitstalk-mcp',
    }),
  };
}

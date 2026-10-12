/**
 * `AgentActionsRpc` (`@gitstalk/shared-race/agent-actions`): what the MCP Worker's Actions,
 * secrets and automation tools ask the gateway. Each call opens the repository for its need
 * (./actions-target.ts: scope, then the git rule) and then serves it through the person's own
 * Actions RPC, so the role checks are the web's.
 */
import type { AgentActionsRpc } from '@gitstalk/shared-race/agent-actions';
import type { AgentPrincipal } from '@gitstalk/shared-race/agent-repos';
import type { RpcResult } from '@gitstalk/shared-race/rpc';

import type { Deps } from '../deps';
import type { ActionsNeed, ActionsTarget } from './actions-target';
import { MANAGE_ENTRIES, READ_ACTIONS, RUN_WORKFLOWS, withTarget } from './actions-target';
import { getAutomation, runAutomation } from './agent-automation';
import { deleteEntry, listEntries, putSecret, putVariable } from './agent-entries';
import { waitForRuns } from './agent-run-wait';
import { cancel, dispatch, getRun, jobLog, listRuns, listWorkflows, rerun } from './agent-runs';

export function agentActionsRpc(env: Env, deps: Deps): AgentActionsRpc {
  const on =
    (need: ActionsNeed) =>
    <T>(
      principal: AgentPrincipal,
      repo: string,
      use: (target: ActionsTarget) => Promise<RpcResult<T>>,
    ): Promise<RpcResult<T>> =>
      withTarget({ env, deps, principal, repo, need }, use);
  const read = on(READ_ACTIONS);
  const run = on(RUN_WORKFLOWS);
  const manage = on(MANAGE_ENTRIES);
  return {
    agentWorkflows: (principal, repo) => read(principal, repo, listWorkflows),
    agentRuns: (principal, repo, filter) => read(principal, repo, (t) => listRuns(t, filter)),
    agentRun: (principal, repo, id) => read(principal, repo, (t) => getRun(t, id)),
    agentJobLog: (principal, repo, input) => read(principal, repo, (t) => jobLog(t, input)),
    agentDispatch: (principal, repo, input) => run(principal, repo, (t) => dispatch(t, input)),
    agentRerun: (principal, repo, id) => run(principal, repo, (t) => rerun(t, id)),
    agentCancel: (principal, repo, id) => run(principal, repo, (t) => cancel(t, id)),
    agentWaitRun: (principal, repo, input) => read(principal, repo, (t) => waitForRuns(t, input)),
    agentActionsEntries: (principal, repo) => read(principal, repo, listEntries),
    agentPutSecret: (principal, repo, input) => manage(principal, repo, (t) => putSecret(t, input)),
    agentDeleteSecret: (principal, repo, input) =>
      manage(principal, repo, (t) => deleteEntry(t, { raw: input, kind: 'secret' })),
    agentPutVariable: (principal, repo, input) =>
      manage(principal, repo, (t) => putVariable(t, input)),
    agentDeleteVariable: (principal, repo, input) =>
      manage(principal, repo, (t) => deleteEntry(t, { raw: input, kind: 'variable' })),
    agentAutomation: (principal, repo, ref) => read(principal, repo, (t) => getAutomation(t, ref)),
    agentRunAutomation: (principal, repo, ref) =>
      run(principal, repo, (t) => runAutomation(t, ref)),
  };
}

/**
 * One automation for an MCP session (doc 25 §7): its file on the stalk, what the index made of
 * it and its newest runs; and running it now, as a manual run (every automation takes
 * `workflow_dispatch`; one run at a time). Running needs the maintain role, checked by the
 * same RPC the web uses, and the session's `write` scope.
 */
import type { AgentAutomation, AgentAutomationStarted } from '@gitstalk/shared-race/agent-actions';
import type { WorkflowSummary } from '@gitstalk/shared-race/actions';
import { isAutomationPath } from '@gitstalk/shared-race/actions';
import type { RpcResult } from '@gitstalk/shared-race/rpc';

import type { ActionsTarget } from './actions-target';
import { failure } from './agent-access';
import { findWorkflow, runSummaryView, triggerText } from './agent-run-views';

/** Runs `automation_get` shows. */
const AUTOMATION_RUNS = 10;

export async function getAutomation(
  target: ActionsTarget,
  ref: string,
): Promise<RpcResult<AgentAutomation>> {
  const found = await findAutomation(target, ref);
  if (!found.ok) return found;
  const automation = found.value;
  const [file, runs] = await Promise.all([
    target.opened.engine.repoFile('stalk', automation.path),
    target.actions.listRuns(target.viewer, target.record.id, {
      workflowPath: automation.path,
      limit: AUTOMATION_RUNS,
    }),
  ]);
  if (!runs.ok) return runs;
  const info = automation.automation;
  return ok({
    repo: target.repo,
    path: automation.path,
    name: automation.name,
    state: automation.state,
    problems: automation.problems.map((problem) =>
      problem.line === null ? problem.message : `line ${problem.line}: ${problem.message}`,
    ),
    triggers: automation.triggers.map(triggerText),
    events: automation.triggers.flatMap((trigger) =>
      trigger.kind === 'beanstalk' ? [trigger.event] : [],
    ),
    harness: info?.harness ?? null,
    model: info?.model ?? null,
    acts_as: info?.actor ?? null,
    memory_ref: info?.memoryRef ?? null,
    file: file.ok ? file.value.content : null,
    runs: runs.value.runs.map(runSummaryView),
  });
}

export async function runAutomation(
  target: ActionsTarget,
  ref: string,
): Promise<RpcResult<AgentAutomationStarted>> {
  const found = await findAutomation(target, ref);
  if (!found.ok) return found;
  const automation = found.value;
  if (automation.state !== 'active')
    return failure('invalid_state', 409, `${automation.path} has problems; fix its file first`);
  const started = await target.actions.dispatchWorkflow(target.viewer, target.record.id, {
    workflowPath: automation.path,
    ref: 'stalk',
    inputs: {},
  });
  return started.ok
    ? ok({ repo: target.repo, automation: automation.path, run: runSummaryView(started.value) })
    : started;
}

async function findAutomation(
  target: ActionsTarget,
  ref: string,
): Promise<RpcResult<WorkflowSummary>> {
  const listed = await target.actions.listWorkflows(target.viewer, target.record.id);
  if (!listed.ok) return listed;
  const automations = listed.value.filter((workflow) => isAutomationPath(workflow.path));
  const found = findWorkflow(automations, ref);
  if (found !== undefined) return ok(found);
  const known = automations.map((automation) => automation.path).join(', ');
  return failure(
    'not_found',
    404,
    `${target.repo} has no automation ${ref} on the stalk${known === '' ? '' : ` (it has ${known})`}`,
  );
}

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value };
}

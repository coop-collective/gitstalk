/**
 * The approval gate's host inside an engine's RunDO: the policy read from the stalk through
 * the Artifacts binding, the bean's principal and revision from its push (or its agent slot in
 * a race), approvals and receipts in the object's SQLite, and Clef over the AI binding.
 */
import type { ModelRunner } from '@gitstalk/shared-ask/pick/decision-model';
import { decisionModelFrom } from '@gitstalk/shared-ask/pick/decision-model';
import { POLICY_PATHS } from '@gitstalk/shared-race/policy-file';
import { readFirstPresent } from '@gitstalk/shared-race/config-dir';
import type { ConfigFile } from '@gitstalk/shared-race/config-dir';

import type { ArtifactsPort } from '../adapters/artifacts';
import type { EngineState } from '../engine/state';
import {
  readCheckLines,
  readLandingTree,
  saveCheckLines,
  saveLandingTree,
} from '../checks/check-store';
import { UpstreamError } from '../errors';
import { readPushBean } from '../push/push-bean';
import type { ApprovalJobHost } from '../run/run-jobs';
import { readApproval, readRoute, saveRoute } from './approval-store';
import { intentCheckedBeans, landedSinceFork } from './landed-since-fork';

/** A triage must come back within this, or the rule answers. */
const CLEF_BUDGET_MS = 2500;

export type ApprovalHostDeps = {
  readonly sql: SqlStorage;
  readonly artifacts: ArtifactsPort;
  /** The engine's Artifacts repo. */
  readonly repo: string;
  /** `continuous`: principals and revisions come from pushes; `race`: from agent slots. */
  readonly engine: 'race' | 'continuous';
  /** The engine's state, for the beans that landed after a bean forked. */
  readonly state: () => EngineState;
  readonly ai: ModelRunner | null;
  readonly aiGateway: string | null;
  readonly now: () => number;
};

export function approvalJobHost(deps: ApprovalHostDeps): ApprovalJobHost {
  const { sql, artifacts, repo } = deps;
  const pushed = (task: string) => (deps.engine === 'continuous' ? readPushBean(sql, task) : null);
  return {
    saveLandingTree: (tree) => saveLandingTree(sql, tree, deps.now()),
    landingTree: (sha) => readLandingTree(sql, sha),
    note: (sha, lines) =>
      saveCheckLines(sql, sha, [...lines, ...readCheckLines(sql, sha)], deps.now()),
    gate: {
      readPolicy: () => readStalkPolicy(artifacts, repo),
      changedFiles: (range) => artifacts.changedFiles(repo, range),
      principal: (task, instance) => {
        if (deps.engine === 'race')
          return instance.kind === 'sandbox' ? `agent:${instance.slot}` : 'agent:unknown';
        const bean = pushed(task);
        return bean === null ? '@unknown' : `@${bean.actor}`;
      },
      origin: (task) => (pushed(task)?.protectedAccess.allowed === true ? 'decider' : 'agent'),
      revision: (task) => pushed(task)?.head ?? null,
      intent: (task) => pushed(task)?.intent ?? null,
      landedSinceFork: (task) =>
        deps.engine === 'continuous' ? landedSinceFork(deps.state(), task) : [],
      intentChecked: async (task) => {
        const head = pushed(task)?.head;
        return head === undefined
          ? new Set()
          : intentCheckedBeans(await artifacts.commitMessage(repo, head));
      },
      approval: (task, revision) => readApproval(sql, task, revision),
      previous: (task) => readRoute(sql, task),
      save: (entry) => saveRoute(sql, entry),
      model: decisionModelFrom({
        name: 'clef',
        ai: deps.ai,
        gateway: deps.aiGateway ?? '',
        budgetMs: CLEF_BUDGET_MS,
      }),
      now: deps.now,
    },
  };
}

/** The branch the policy is read from: the stalk, never the bean being judged. */
export const POLICY_BRANCH = 'stalk';

/**
 * The policy file at a branch (the stalk) or a commit, and the commit it was read at. A branch
 * that cannot be read is a retryable failure, never "no policy": a failed read must not open
 * the gate.
 */
export async function readStalkPolicy(
  artifacts: ArtifactsPort,
  repo: string,
  at: string = POLICY_BRANCH,
): Promise<{ file: ConfigFile | null; sha: string }> {
  const head = /^[0-9a-f]{40}$/u.test(at) ? at : await artifacts.branchHead(repo, branchName(at));
  if (head === null) throw new UpstreamError(`${at} of ${repo} is not readable yet`, true);
  const file = await readFirstPresent(POLICY_PATHS, (path) => artifacts.readFile(repo, head, path));
  return { file, sha: head };
}

function branchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/** The Workers AI binding when the Worker has one (tests and local runs may not). */
export function optionalAi(env: object): ModelRunner | null {
  const ai: unknown = Reflect.get(env, 'AI');
  if (typeof ai !== 'object' || ai === null) return null;
  const run: unknown = Reflect.get(ai, 'run');
  if (typeof run !== 'function') return null;
  return {
    run: async (model, input, options): Promise<unknown> => {
      const answer: unknown = await Reflect.apply(run, ai, [model, input, options]);
      return answer;
    },
  };
}

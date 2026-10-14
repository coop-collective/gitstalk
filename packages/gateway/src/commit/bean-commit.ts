/**
 * `bean_commit` (doc 33, after claude-18 §5): a writer without a checkout (a revert bot, a
 * small conflict fix, a doc automation, the planner) writes files to its own bean branch,
 * through the one server-side commit flow (`server-commit.ts`). Two callers:
 *
 * - a race run's contributor token: `refs/heads/beans/<bean>` of the token's own bean;
 * - a person's agent session on a repository: `refs/heads/bean/<name>`, then submitted to the
 *   engine exactly as a `git push` of that branch is (`afterPush`).
 *
 * `expected_head` is compare-and-swap; an `idempotency_key` replays the first result for the
 * same input, as `bean_update` does.
 */
import type { BeanCommitInput, BeanCommitResult } from '@gitstalk/shared-race/bean-commit';
import type { ContributorTokenClaims } from '@gitstalk/shared-race/collaboration';
import type { Sha } from '@gitstalk/shared-race/ids';
import type { RpcResult } from '@gitstalk/shared-race/rpc';

import { taskBranch } from '../engine/tasks';
import { pushedBeanRef } from '../push/bean-refs';
import type { CommitDeps, ServerCommit } from './server-commit';
import { commitChanges } from './server-commit';

/** A person's agent session committing to its bean of a repository. */
export type SessionCommit = {
  readonly actor: string;
  /** The MCP client, for the audit trailer. */
  readonly client: string;
  readonly input: BeanCommitInput;
};

/** Commits `input.changes` to the contributor's own bean branch of a race run. */
export function commitToBean(
  deps: CommitDeps,
  claims: ContributorTokenClaims,
  input: BeanCommitInput,
): Promise<RpcResult<BeanCommitResult>> {
  if (input.bean !== claims.bean)
    return Promise.resolve({
      ok: false,
      error: {
        code: 'forbidden',
        status: 403,
        message: 'contributors may commit only to their own bean',
      },
    });
  return commitChanges(deps, {
    ...beanCommitOf(input, claims.actor, taskBranch(claims.bean)),
    author: authorOf(claims.actor, `contributors.${deps.emailHost}`),
    trailers: [`Task: ${claims.bean}`, `Actor: ${claims.actor}`, 'Via: bean_commit'],
  });
}

/**
 * Commits a session's `input.changes` to `bean/<name>`; `hooks` are the engine's refusal of
 * the bean and its submit of the pushed head.
 */
export function commitToRepoBean(
  deps: CommitDeps,
  session: SessionCommit,
  hooks: Pick<ServerCommit, 'refusal' | 'afterPush'>,
): Promise<RpcResult<BeanCommitResult>> {
  const { actor, input } = session;
  return commitChanges(deps, {
    ...beanCommitOf(input, actor, pushedBeanRef(input.bean).slice('refs/heads/'.length)),
    author: authorOf(actor, `users.${deps.emailHost}`),
    trailers: [`Bean: ${input.bean}`, `Actor: @${actor}`, `Via: bean_commit (${session.client})`],
    ...hooks,
  });
}

/** An actor as a git identity: its name, and an address under `domain`. */
export function authorOf(actor: string, domain: string): { name: string; email: string } {
  const name = actor.replaceAll(/[<>\n\r\0]/g, '').trim() || 'contributor';
  const local = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return { name, email: `${local || 'contributor'}@${domain}` };
}

/** `bean_commit`'s input as the core's request: its branch, compare-and-swap and key. */
function beanCommitOf(
  input: BeanCommitInput,
  actor: string,
  branch: string,
): Omit<ServerCommit, 'author' | 'trailers'> {
  const expectedHead: Sha | null = input.expected_head;
  return {
    onto: { kind: 'branch', bean: input.bean, branch, expectedHead },
    changes: input.changes,
    message: input.message,
    actor,
    idempotency: {
      scope: input.bean,
      key: input.idempotency_key,
      attempt: { method: 'bean_commit', input },
    },
  };
}

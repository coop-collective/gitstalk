/**
 * The one server-side commit flow (doc 33): every writer that saves files without a clone
 * comes through here, `bean_commit` (a race contributor or a person's agent session) and the
 * web editors (the automation builder, Settings → Approval rules). Artifacts has no commit
 * call, so the gateway builds the objects itself (`tree-edit.ts`) and pushes them through
 * receive-pack with a token it minted; the caller never holds one. In order:
 *
 * 1. the changes and the message pass the shared schema (safe paths, each once, the caps);
 * 2. a reused idempotency key replays the first result, one key at a time (`key-queue.ts`);
 * 3. the commit is built from the changed paths' trees only;
 * 4. the branch moves by compare-and-swap: `bean_commit`'s `expected_head`, or "must not
 *    exist" for an editor's new bean; a branch elsewhere answers a `conflict` value with its
 *    head, never an overwrite;
 * 5. the push's report-status is read, and a pushed head is handed on (`afterPush`, the
 *    repository engine's submit, exactly as a `git push` of the branch is).
 *
 * Never a line: every branch here is a bean's.
 */
import type { BeanCommitChange, BeanCommitResult } from '@gitstalk/shared-race/bean-commit';
import { CommitChanges, CommitMessage } from '@gitstalk/shared-race/bean-commit';
import { Sha } from '@gitstalk/shared-race/ids';
import type { TaskId } from '@gitstalk/shared-race/ids';
import type { RpcError, RpcResult } from '@gitstalk/shared-race/rpc';
import { z } from 'zod';

import { assertNever } from '../engine/errors';
import { UpstreamError } from '../errors';
import type { GitObject } from '../git/pack-writer';
import type { RemoteTarget } from '../git/remote-client';
import { ZERO_SHA, listRefs, pushRefs } from '../git/remote-client';
import type { Logger } from '../log';
import type { CommitPayload } from './commit-idempotency';
import { recordCommit, replayedCommit } from './commit-idempotency';
import type { KeyQueue } from './key-queue';
import type { BuiltCommit, TreeEditProblem, TreeReader } from './tree-edit';
import { buildTreeCommit } from './tree-edit';

/** The line a new bean branch starts from when `bean_commit` names no head. */
const SPROUT_REF = 'refs/heads/sprout';
/** Hex digits of the commit id an editor's bean name carries. */
const SHORT = 6;

export type CommitDeps = {
  readonly sql: SqlStorage;
  /** Runs `use` with a reader of the repo's objects (released afterwards). */
  read<T>(use: (reader: TreeReader) => Promise<T>): Promise<T>;
  /** The repo's remote and a write token the gateway minted for it. */
  target(): Promise<RemoteTarget>;
  /** Runs one idempotency key's tries one at a time. */
  readonly queue: KeyQueue;
  readonly now: () => number;
  /** The forge's web host, for commit emails (`contributors.<host>`, `users.<host>`). */
  readonly emailHost: string;
  readonly log: Logger;
};

/** Where the commit goes, and the compare-and-swap that moves it there. */
export type CommitOnto =
  /** `bean_commit`: the bean's branch at `expectedHead` (null: a new branch from the sprout). */
  | {
      readonly kind: 'branch';
      readonly bean: TaskId;
      /** `beans/<task>` (a race run) or `bean/<name>` (a repository). */
      readonly branch: string;
      readonly expectedHead: Sha | null;
    }
  /** An editor's save: a new bean on `base`, named from its commit; it must not exist yet. */
  | {
      readonly kind: 'new_bean';
      readonly base: Sha;
      readonly beanOf: (short: string) => TaskId;
      readonly branchOf: (bean: TaskId) => string;
    };

/** One commit: what changes, whose it is, where it goes and what happens once it is there. */
export type ServerCommit = {
  readonly onto: CommitOnto;
  readonly changes: readonly BeanCommitChange[];
  readonly message: string;
  /** Who it is: the idempotency key's owner. */
  readonly actor: string;
  readonly author: { readonly name: string; readonly email: string };
  /** Audit trailer lines appended to the message (`Key: value`). */
  readonly trailers: readonly string[];
  /** The key, its scope (a bean, or `save:@<handle>`) and what it was used for. */
  readonly idempotency: {
    readonly scope: string;
    readonly key: string;
    readonly attempt: CommitPayload;
  };
  /** Why the bean may not take a commit now (checked once its name is known), or null. */
  readonly refusal?: (bean: TaskId) => string | null;
  /** Hands the pushed head on (a repository engine's submit); a reason when it was refused. */
  readonly afterPush?: (bean: TaskId, head: Sha) => Promise<string | null>;
};

type Failure = { readonly ok: false; readonly error: RpcError };
type Placed = { readonly bean: TaskId; readonly branch: string; readonly expected: Sha | null };

/** Commits `request.changes` where `request.onto` says, or says why not. */
export async function commitChanges(
  deps: CommitDeps,
  request: ServerCommit,
): Promise<RpcResult<BeanCommitResult>> {
  const problem = contentProblem(request);
  if (problem !== null) return failed('invalid_request', 400, problem);
  const { scope, key } = request.idempotency;
  return deps.queue(`${scope}\n${key}`, () => commitOnceForKey(deps, request));
}

/** The message with gitstalk's audit trailers: which bean, which actor, how it was made. */
export function messageWithTrailers(message: string, trailers: readonly string[]): string {
  return `${message.trim()}\n\n${trailers.join('\n')}\n`;
}

/** Why the changes or the message cannot be a commit, in the schema's words; or null. */
function contentProblem(request: ServerCommit): string | null {
  const parsed = z
    .object({ changes: CommitChanges, message: CommitMessage })
    .safeParse({ changes: request.changes, message: request.message });
  return parsed.success ? null : z.prettifyError(parsed.error);
}

async function commitOnceForKey(
  deps: CommitDeps,
  request: ServerCommit,
): Promise<RpcResult<BeanCommitResult>> {
  const { scope, key, attempt } = request.idempotency;
  const identity = { bean: scope, actor: request.actor, key };
  const replay = await replayedCommit(deps.sql, identity, attempt);
  if (replay.kind === 'mismatch')
    return failed('conflict', 409, 'idempotency key was used with different input');
  if (replay.kind === 'replay') return { ok: true, value: replay.result };
  if (request.onto.kind === 'branch') {
    const refusal = request.refusal?.(request.onto.bean) ?? null;
    if (refusal !== null) return failed('conflict', 409, refusal);
  }
  try {
    const result = await commitOnce(deps, request);
    if (result.ok && result.value.kind === 'committed')
      await recordCommit(deps.sql, identity, { attempt, result: result.value });
    return result;
  } catch (error: unknown) {
    if (!(error instanceof UpstreamError)) throw error;
    deps.log.warn('server commit failed upstream', { actor: request.actor, error });
    return failed('upstream_failed', 502, `the repo could not take the commit: ${error.message}`);
  }
}

async function commitOnce(
  deps: CommitDeps,
  request: ServerCommit,
): Promise<RpcResult<BeanCommitResult>> {
  const { onto } = request;
  const target = await deps.target();
  const refs = await listRefs(target);
  const base = baseOf(onto, refs);
  if (base.kind !== 'base') return base.answer;
  const built = await deps.read((reader) =>
    buildTreeCommit(reader, {
      base: base.sha,
      changes: request.changes.map((change) => ({
        path: change.path,
        content: 'content' in change ? change.content : null,
      })),
      author: { ...request.author, atMs: deps.now() },
      message: messageWithTrailers(request.message, request.trailers),
    }),
  );
  if (!built.ok) return failed('invalid_request', 422, problemText(built.problem));
  const placed = placeOf(onto, built.value);
  const taken = newBeanRefusal(request, placed, refs);
  if (taken !== null) return taken;
  return pushAndHandOn(deps, request, {
    placed,
    target,
    built: built.value,
    parent: Sha.parse(base.sha),
  });
}

type Base =
  | { readonly kind: 'base'; readonly sha: string }
  | { readonly kind: 'answer'; readonly answer: RpcResult<BeanCommitResult> };

/** The commit the change is built on, after `bean_commit`'s compare-and-swap. */
function baseOf(onto: CommitOnto, refs: ReadonlyMap<string, string>): Base {
  switch (onto.kind) {
    case 'new_bean':
      return { kind: 'base', sha: onto.base };
    case 'branch': {
      const current = refs.get(`refs/heads/${onto.branch}`) ?? null;
      if (current !== onto.expectedHead)
        return { kind: 'answer', answer: conflictWith(onto, onto.expectedHead, current) };
      const sha = onto.expectedHead ?? refs.get(SPROUT_REF) ?? null;
      if (sha === null)
        return {
          kind: 'answer',
          answer: failed('invalid_state', 409, 'there is no sprout to start a bean from'),
        };
      return { kind: 'base', sha };
    }
    default:
      return assertNever(onto);
  }
}

/** The bean and branch the built commit goes to, and the head the push expects there. */
function placeOf(onto: CommitOnto, built: BuiltCommit): Placed {
  switch (onto.kind) {
    case 'branch':
      return { bean: onto.bean, branch: onto.branch, expected: onto.expectedHead };
    case 'new_bean': {
      const bean = onto.beanOf(built.commit.slice(0, SHORT));
      return { bean, branch: onto.branchOf(bean), expected: null };
    }
    default:
      return assertNever(onto);
  }
}

/** A new bean is refused by the engine, or exists already (its compare-and-swap); else null. */
function newBeanRefusal(
  request: ServerCommit,
  placed: Placed,
  refs: ReadonlyMap<string, string>,
): RpcResult<BeanCommitResult> | null {
  if (request.onto.kind !== 'new_bean') return null;
  const refusal = request.refusal?.(placed.bean) ?? null;
  if (refusal !== null) return failed('conflict', 409, refusal);
  const current = refs.get(`refs/heads/${placed.branch}`) ?? null;
  return current === null ? null : conflictWith(placed, null, current);
}

async function pushAndHandOn(
  deps: CommitDeps,
  request: ServerCommit,
  push: {
    readonly placed: Placed;
    readonly target: RemoteTarget;
    readonly built: BuiltCommit;
    readonly parent: Sha;
  },
): Promise<RpcResult<BeanCommitResult>> {
  const { placed, built } = push;
  const head = Sha.parse(built.commit);
  const ref = `refs/heads/${placed.branch}`;
  const refused = await pushHead(push.target, { ref, expected: placed.expected, head }, built);
  if (refused?.kind === 'moved') return conflictWith(placed, placed.expected, refused.head);
  if (refused?.kind === 'refused') return refused.failure;
  deps.log.info('server commit pushed', { bean: placed.bean, branch: placed.branch, head });
  const handOn =
    request.afterPush === undefined ? null : await request.afterPush(placed.bean, head);
  if (handOn !== null)
    return failed('invalid_state', 409, `${head} is on ${placed.branch}, but ${handOn}`);
  return {
    ok: true,
    value: {
      kind: 'committed',
      bean: placed.bean,
      branch: placed.branch,
      commit: head,
      parent: push.parent,
      tree: Sha.parse(built.tree),
      files: request.changes.length,
      objects: built.objects.length,
      trees_read: built.treesRead,
    },
  };
}

type PushRefusal =
  | { readonly kind: 'moved'; readonly head: string | null }
  | { readonly kind: 'refused'; readonly failure: Failure };

/** Pushes `head` over `expected`, reading report-status: null when the ref moved to it. */
async function pushHead(
  target: RemoteTarget,
  update: { readonly ref: string; readonly expected: Sha | null; readonly head: Sha },
  built: { readonly objects: readonly GitObject[] },
): Promise<PushRefusal | null> {
  const { ref, expected, head } = update;
  const command = { ref, oldSha: expected ?? ZERO_SHA, newSha: head };
  const report = await pushRefs(target, [command], built.objects);
  if (report.unpackOk && report.refs.some((status) => status.ref === ref && status.ok)) return null;
  // A refused update is most often a lost race: say where the branch is now.
  const now = (await listRefs(target)).get(ref) ?? null;
  if (now !== expected) return { kind: 'moved', head: now };
  const refused = report.refs.find((status) => status.ref === ref && !status.ok);
  const reason = report.unpackOk ? (refused?.reason ?? 'no status for the ref') : 'unpack failed';
  return {
    kind: 'refused',
    failure: failed('upstream_failed', 502, `the repo refused the commit: ${reason}`),
  };
}

function conflictWith(
  where: { readonly bean: TaskId; readonly branch: string },
  expected: Sha | null,
  current: string | null,
): RpcResult<BeanCommitResult> {
  return {
    ok: true,
    value: {
      kind: 'conflict',
      bean: where.bean,
      branch: where.branch,
      expected_head: expected,
      current_head: current === null ? null : Sha.parse(current),
    },
  };
}

function problemText(problem: TreeEditProblem): string {
  switch (problem.kind) {
    case 'base_missing':
      return `the base commit ${problem.base} is not in the repo`;
    case 'not_a_directory':
      return `${problem.path} is a file in the base, so nothing can go under it`;
    case 'is_a_directory':
      return `${problem.path} is a directory in the base; change the files inside it`;
    case 'missing_file':
      return `${problem.path} does not exist in the base, so it cannot be deleted`;
    case 'no_change':
      return 'the changes leave every file as it is; nothing to commit';
    default:
      return assertNever(problem);
  }
}

function failed(code: string, status: number, message: string): Failure {
  return { ok: false, error: { code, status, message } };
}

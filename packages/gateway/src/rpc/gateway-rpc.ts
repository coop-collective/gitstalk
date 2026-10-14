/**
 * The RPC surface for the web app (`GatewayRpc` in `@gitstalk/shared-race/rpc`), behind the
 * gateway's default entrypoint. Arguments are validated here; expected failures come back
 * as `{ ok: false, error }`, as the HTTP API would answer them.
 */
import { z } from 'zod';

import { RunId } from '@gitstalk/shared-race/ids';
import type {
  GatewayRpc,
  RepoRef,
  RpcError,
  RpcResult,
  ViewToken,
  ViewTokenClaims,
} from '@gitstalk/shared-race/rpc';
import { REPO_REF_PATTERN } from '@gitstalk/shared-race/rpc';
import { isSafeRepoPath } from '@gitstalk/shared-race/task';

import { approveBeanRpc } from '../approval/approve-rpc';
import { issueToken, verifyToken } from '../auth/tokens';
import type { Deps } from '../deps';
import { GatewayError, UpstreamError } from '../errors';
import type { RunResult } from '../run/run-do';
import { MAX_LISTED_RUNS, RUN_INDEX_NAME } from '../run/run-index';
import { collaborationRpc } from './collaboration-rpc';

/** View tokens minted for the web app's live socket live an hour. */
const VIEW_TOKEN_TTL_SECONDS = 3600;
/** Paths a call may name. */
const MAX_PATHS = 100;
/** Events per `runEvents` page. */
const MAX_EVENTS_PAGE = 5000;
/** Characters of an actor's name (the log records `human:<actor>`). */
const MAX_ACTOR = 64;

const Ref = z.string().regex(REPO_REF_PATTERN, 'sprout, stalk, beans/<task> or a commit sha');
const Path = z.string().max(512).refine(isSafeRepoPath, 'a relative path inside the repo');
const Paths = z.array(Path).max(MAX_PATHS);

/** The surface, with the methods that are optional for callers of older gateways present. */
export type GatewayRpcSurface = GatewayRpc &
  Required<Pick<GatewayRpc, 'policyGet' | 'beanRoute' | 'approveBean'>>;

export function gatewayRpc(env: Env, deps: Deps): GatewayRpcSurface {
  return {
    ...collaborationRpc(deps),
    async listRuns(limit = 50) {
      const index = env.RUN_INDEX.getByName(RUN_INDEX_NAME);
      return index.list(Math.min(limit, MAX_LISTED_RUNS));
    },
    runView: (run) => forRun(run, async (id) => fromRun(await deps.run(id).view())),
    runEvents: (run, after, limit) =>
      forRun(run, async (id) => {
        const page = fromRun(
          await deps.run(id).events(Math.max(0, Math.trunc(after)), clampPage(limit)),
        );
        if (!page.ok) return page;
        const { bodies, last, done } = page.value;
        return ok({ events: [...bodies], next_after: last, done });
      }),
    decide: (run, card, winner, actor, text) => {
      const who = actorName(actor);
      if (who === '') return Promise.resolve(invalid('name the actor who decided'));
      return forRun(run, async (id) =>
        fromRun(
          await deps.run(id).decide(card, {
            winner,
            actor: who,
            text: text === undefined ? null : text.slice(0, 2000),
          }),
        ),
      );
    },
    viewToken: (run) => forRun(run, (id) => viewToken(deps, id)),
    // Repo reads run in the run's Durable Object, through its read index of git objects.
    repoTree: (run, ref, path = '', recursive = false) =>
      explore(run, { ref, paths: path === '' ? [] : [path] }, async (id) =>
        fromRun(await deps.run(id).repoTree(ref, path, recursive)),
      ),
    repoFile: (run, ref, path) =>
      explore(run, { ref, paths: [path] }, async (id) =>
        fromRun(await deps.run(id).repoFile(ref, path)),
      ),
    repoDiff: (run, fromRef, toRef, paths) =>
      explore(run, { ref: fromRef, refs: [toRef], paths: paths ?? [] }, async (id) =>
        fromRun(await deps.run(id).repoDiff(fromRef, toRef, paths ?? null)),
      ),
    repoLog: (run, ref, paths, limit) =>
      explore(run, { ref, paths: paths ?? [] }, async (id) =>
        fromRun(await deps.run(id).repoLog(ref, paths, limit)),
      ),
    repoGrep: (run, ref, pattern, paths, regex) =>
      explore(run, { ref, paths: paths ?? [] }, async (id) =>
        fromRun(await deps.run(id).repoGrep(ref, pattern, paths ?? null, regex === true)),
      ),
    beansByPath: (run, paths) =>
      checkedPaths(run, paths, async (id) => fromRun(await deps.run(id).beans(paths))),
    beanDetail: (run, bean) => forRun(run, async (id) => fromRun(await deps.run(id).bean(bean))),
    policyGet: (run, ref) => {
      if (ref !== undefined && !Ref.safeParse(ref).success)
        return Promise.resolve(invalid('ref must be sprout, stalk, beans/<task> or a commit sha'));
      return forRun(run, async (id) => fromRun(await deps.run(id).policy(ref ?? null)));
    },
    beanRoute: (run, bean) => forRun(run, async (id) => ok(await deps.run(id).beanRoute(bean))),
    approveBean: (run, bean, request) =>
      forRun(run, (id) => approveBeanRpc(env, deps, { run: id, bean, request })),
    decisions: (run, paths) =>
      checkedPaths(run, paths ?? [], async (id) =>
        fromRun(await deps.run(id).decisionRecords(paths ?? null)),
      ),
    testsFor: (run, paths) =>
      checkedPaths(run, paths, async (id) => fromRun(await deps.run(id).testsFor(paths))),
    // Streams answer from the run's stream object; the engine's RunDO is not asked.
    beanStreams: (run) => forRun(run, async (id) => ok(await deps.streams(id).beanStreams())),
    beanStream: (run, bean) =>
      forRun(run, async (id) => ok(await deps.streams(id).beanStream(bean))),
    verifyViewToken: (token) => verifyViewToken(deps, token),
  };
}

async function viewToken(deps: Deps, run: RunId): Promise<RpcResult<ViewToken>> {
  const exists = fromRun(await deps.run(run).agentCount());
  if (!exists.ok) return exists;
  const issued = await issueToken(
    deps.tokenSecret,
    { run, sub: 'web', scope: 'view' },
    { ttlSeconds: VIEW_TOKEN_TTL_SECONDS, nowMs: deps.now() },
  );
  return ok({
    token: issued.token,
    expires_at: issued.expiresAt,
    live_path: `/v1/runs/${run}/live`,
  });
}

/** The MCP server's check of a caller's bearer token: a view token, genuine and current. */
async function verifyViewToken(deps: Deps, token: string): Promise<RpcResult<ViewTokenClaims>> {
  const check = await verifyToken(deps.tokenSecret, token, deps.now());
  if (!check.ok) {
    const message = `run token ${check.failure.replace('_', ' ')}`;
    return { ok: false, error: { code: 'unauthorized', status: 401, message } };
  }
  const { run, sub, scope, exp } = check.claims;
  if (scope !== 'view') {
    const message = `a ${scope} token cannot read through this API; use a view token`;
    return { ok: false, error: { code: 'forbidden', status: 403, message } };
  }
  return ok({ run, sub, expires_at: new Date(exp * 1000).toISOString() });
}

/** Validates the run id, then runs `use`; thrown gateway errors become error values. */
async function forRun<T>(
  run: string,
  use: (id: RunId) => Promise<RpcResult<T>>,
): Promise<RpcResult<T>> {
  const id = RunId.safeParse(run);
  if (!id.success) return invalid(`not a run id: ${run}`);
  try {
    return await use(id.data);
  } catch (error: unknown) {
    return caught(error);
  }
}

function checkedPaths<T>(
  run: string,
  paths: readonly string[],
  use: (id: RunId) => Promise<RpcResult<T>>,
): Promise<RpcResult<T>> {
  const parsed = Paths.safeParse(paths);
  if (!parsed.success) return Promise.resolve(invalid(parsed.error.issues[0]?.message ?? 'paths'));
  return forRun(run, use);
}

/** A read of the run repo: refs and paths are checked first. */
function explore<T>(
  run: string,
  args: { ref: RepoRef; refs?: readonly RepoRef[]; paths: readonly string[] },
  read: (id: RunId) => Promise<RpcResult<T>>,
): Promise<RpcResult<T>> {
  const refs = [args.ref, ...(args.refs ?? [])];
  const badRef = refs.find((ref) => !Ref.safeParse(ref).success);
  if (badRef !== undefined) return Promise.resolve(invalid(`not a ref of the run repo: ${badRef}`));
  return checkedPaths(run, args.paths, read);
}

function fromRun<T>(result: RunResult<T>): RpcResult<T> {
  return result.ok ? result : { ok: false, error: { ...result.error } };
}

function caught(error: unknown): { ok: false; error: RpcError } {
  if (error instanceof GatewayError) {
    return { ok: false, error: { code: error.code, status: error.status, message: error.message } };
  }
  if (error instanceof UpstreamError) {
    return { ok: false, error: { code: 'upstream_failed', status: 502, message: error.message } };
  }
  throw error;
}

/** The actor as the log names it after `human:`; a leading `human:` is not doubled. */
function actorName(actor: string): string {
  return actor
    .trim()
    .replace(/^human:/, '')
    .trim()
    .slice(0, MAX_ACTOR);
}

function clampPage(limit: number): number {
  return Math.max(1, Math.min(MAX_EVENTS_PAGE, Math.trunc(limit)));
}

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value };
}

function invalid(message: string): { ok: false; error: RpcError } {
  return { ok: false, error: { code: 'invalid_request', status: 400, message } };
}

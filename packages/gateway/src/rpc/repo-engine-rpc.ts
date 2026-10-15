/**
 * The repository side's RPC for continuous engines (`RepoEngineRpc`): open a repository's
 * engine, mint a git credential for it until user tokens exist, and list its pushed beans.
 * Every other read (the view, events, beans, decisions, files) is the web app's existing RPC,
 * keyed by the engine id. Like the rest of the binding, it trusts its caller (the web Worker).
 */
import { z } from 'zod';

import type { BeanHold, RevisionApproval } from '@gitstalk/shared-race/bean-approval';
import { RunId } from '@gitstalk/shared-race/ids';
import type {
  GitToken,
  PushedBeanStatus,
  RepoEngineOpened,
  RepoEngineRpc,
  RpcResult,
} from '@gitstalk/shared-race/rpc';

import { issueToken } from '../auth/tokens';
import type { Deps } from '../deps';
import type { PushBean } from '../push/push-bean';
import { withoutRemotePrefix } from '../push/push-messages';
import { OpenRepoEngineInput, repoEngineId } from '../push/repo-engine';

const DEFAULT_TOKEN_SECONDS = 3600;
const MAX_TOKEN_SECONDS = 30 * 24 * 3600;
const GitUser = z.strictObject({
  id: z.string().min(1).max(100),
  handle: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/),
});

export function repoEngineRpc(deps: Deps): RepoEngineRpc {
  return {
    async openRepoEngine(raw) {
      const parsed = OpenRepoEngineInput.safeParse(raw);
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'invalid input');
      return openRepoEngine(deps, parsed.data);
    },
    async gitToken(engine, user, ttlSeconds = DEFAULT_TOKEN_SECONDS) {
      const run = RunId.safeParse(engine);
      const who = GitUser.safeParse(user);
      if (!run.success || !who.success) return invalid('an engine id and a user {id, handle}');
      if ((await deps.run(run.data).repoEngine()) === null) return notFound(engine);
      const ttl = Math.max(60, Math.min(MAX_TOKEN_SECONDS, Math.trunc(ttlSeconds)));
      const issued = await issueToken(
        deps.tokenSecret,
        { run: run.data, sub: who.data.handle, scope: 'git' },
        { ttlSeconds: ttl, nowMs: deps.now() },
      );
      const value: GitToken = { token: issued.token, expires_at: issued.expiresAt };
      return { ok: true, value };
    },
    async closeRepoEngine(engine, options) {
      const run = RunId.safeParse(engine);
      if (!run.success) return invalid('an engine id');
      const closed = await deps.run(run.data).closeRepoEngine({ deleteRepo: options.deleteRepo });
      return closed.ok
        ? { ok: true, value: { closed: true } }
        : { ok: false, error: { ...closed.error } };
    },
    async pushedBeans(engine) {
      const run = RunId.safeParse(engine);
      if (!run.success) return invalid('an engine id');
      const stub = deps.run(run.data);
      if ((await stub.repoEngine()) === null) return notFound(engine);
      const beans = await stub.pushedBeans();
      return { ok: true, value: beans.map(pushedBeanStatus) };
    },
  };
}

/**
 * Opens (or finds) the engine of a validated `openRepoEngine` input: by default the engine
 * derived from `<owner>/<repo>` (the admin route's engines, found from the git path), or
 * `engineId` when the caller keeps the id itself (the registry, `registryEngineId`).
 */
export async function openRepoEngine(
  deps: Deps,
  input: OpenRepoEngineInput,
  given?: RunId,
): Promise<RpcResult<RepoEngineOpened>> {
  const engineId = given ?? (await repoEngineId(input.owner.handle, input.repoName));
  const opened = await deps
    .run(engineId)
    .openRepoEngine({ ...input, engineId, createdAtMs: deps.now() });
  if (!opened.ok) return { ok: false, error: { ...opened.error } };
  const value: RepoEngineOpened = {
    engineId,
    created: opened.value.created,
    base_sha: opened.value.baseSha,
    git_path: `/git/${input.owner.handle}/${input.repoName}.git`,
  };
  return { ok: true, value };
}

/** A pushed bean in the RPC's shape. */
export function pushedBeanStatus(
  bean: PushBean & {
    readonly hold?: BeanHold | null;
    readonly approvals?: readonly RevisionApproval[];
  },
): PushedBeanStatus {
  return {
    bean: bean.bean,
    title: bean.title,
    task: bean.task,
    actor: bean.actor,
    head: bean.head,
    pushes: bean.pushes,
    phase: bean.phase,
    reason: bean.reason,
    landed_sha: bean.landedSha,
    verdict: (bean.verdict?.lines ?? []).map((line) => withoutRemotePrefix(line)),
    hold: bean.hold ?? null,
    approvals: bean.approvals ?? [],
  };
}

function invalid(message: string): RpcResult<never> {
  return { ok: false, error: { code: 'invalid_request', status: 400, message } };
}

function notFound(engine: string): RpcResult<never> {
  return {
    ok: false,
    error: { code: 'not_found', status: 404, message: `no repository engine ${engine}` },
  };
}

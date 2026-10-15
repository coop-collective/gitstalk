/**
 * `GET /api/runs/:run/beans/:bean/diff` without bindings: a bean's own diff (its landing, or
 * its newest head against the line) for whoever may read the run, with the browser headers of
 * docs/claude-opus/35-caching.md §4.5. The route binds it to the session, the gateway and the
 * edge object cache.
 *
 * - A public repository's diff is read through the edge object cache, keyed by its commit
 *   pair (immutable), and says which layer served it in `Server-Timing`. The browser keeps it
 *   only to revalidate (`private, no-cache`, the pair as a strong ETag): the URL names a bean,
 *   not a pair, and even a validated bean can be demoted, reset and requeued with a new pair.
 *   A matching `If-None-Match` is answered 304 before the diff is read.
 * - A private or internal repository's diff is read through the private KV namespace (never
 *   the isolate memory or the Cache API), after the access check, and says `kv-hit-private` or
 *   `kv-miss-private` in `Server-Timing`. The browser never keeps it (`no-store`): a kept copy
 *   would outlive the viewer's access.
 * - A benchmark race (platform admins only) is never kept.
 */
import type { RunId, TaskId } from '@gitstalk/shared-race/ids';

import { isForgeError } from '@gitstalk/shared-ask/forge/forge-errors';
import type { ForgeSource } from '@gitstalk/shared-ask/forge/forge-source';
import type { RepoDiff } from '@gitstalk/shared-ask/repo/repo-types';
import {
  NO_STORE,
  REVALIDATE,
  cacheControl,
  isNotModified,
  jsonAnswer,
  pairEtag,
  problem,
} from '../edge/http-cache';
import type { EdgeAnswer, EdgeObjectCache } from '../edge/object-cache';
import { publicOutcome } from '../edge/object-cache';
import type { PrivateObjectCache } from '../edge/private-object-cache';
import { privateOutcome } from '../edge/private-object-cache';
import type { ReadGrant } from '../edge/read-grant';
import { PrivateEngine } from '../edge/read-grant';
import { DIFF_CODEC } from '../edge/stored-objects';
import { log } from '../log';
import { PublicEngine } from '../repo-pages/event-cache';

/** What the run routes serve of an engine to the requester (`runAccess` in admin-gate.ts). */
export type RunAccess =
  | { readonly kind: 'refused' }
  /** A benchmark race, to a platform admin. */
  | { readonly kind: 'race' }
  /**
   * A repository's engine the requester may read: the access check's grant (its visibility
   * and cache epoch decide which cache and keys).
   */
  | { readonly kind: 'repository'; readonly repository: ReadGrant };

export type BeanDiffDeps = {
  readonly source: Pick<ForgeSource, 'beanDetail' | 'repoDiff'>;
  readonly objects: EdgeObjectCache;
  /** The private KV namespace, for a private or internal repository's diff. */
  readonly privateObjects: PrivateObjectCache;
  /** Milliseconds, for `Server-Timing` (default `Date.now`). */
  readonly now?: () => number;
};

export type BeanDiffRequest = {
  readonly request: Request;
  readonly run: RunId;
  readonly bean: TaskId;
  /** The requester's access to the run, checked on this request. */
  readonly access: RunAccess;
};

export async function answerBeanDiff(
  input: BeanDiffRequest,
  deps: BeanDiffDeps,
): Promise<Response> {
  const { request, run, bean, access } = input;
  if (access.kind === 'refused') return problem(404, 'no such run');
  try {
    const detail = await deps.source.beanDetail(run, bean);
    if (detail === undefined) return problem(404, `no bean ${bean} in this run`);
    const { diffBase: base, diffHead: head } = detail;
    if (base === null || head === null) return problem(404, 'this bean has no change yet');
    const read = () => deps.source.repoDiff(run, base, head);
    if (access.kind === 'race') return jsonAnswer(request, await read(), { rule: NO_STORE });
    const now = deps.now ?? Date.now;
    const started = now();
    const owned = PrivateEngine.of(access.repository, run);
    if (owned !== null) {
      const answer = await deps.privateObjects.read(
        owned,
        { kind: 'diff', base, head },
        DIFF_CODEC,
        read,
      );
      const timing = { outcome: privateOutcome(answer.layer), ms: now() - started };
      return jsonAnswer(request, answer.value, { rule: NO_STORE, timing });
    }
    const shared = PublicEngine.of(access.repository, run);
    if (shared === null) return jsonAnswer(request, await read(), { rule: NO_STORE });
    const etag = pairEtag(base, head);
    if (isNotModified(request, etag)) return notModified(etag);
    const answer: EdgeAnswer<RepoDiff> = await deps.objects.read(
      shared,
      { kind: 'diff', base, head },
      DIFF_CODEC,
      read,
    );
    const timing = { outcome: publicOutcome(answer.layer), ms: now() - started };
    return jsonAnswer(request, answer.value, { rule: REVALIDATE, etag, timing });
  } catch (error: unknown) {
    if (isForgeError(error, 'not_found')) return problem(404, error.message);
    log.error('bean diff failed', { run, bean, error });
    return problem(502, 'the gateway could not produce this diff');
  }
}

/** The browser's copy is still this pair: no diff is read. Only after the access check. */
function notModified(etag: string): Response {
  return new Response(null, {
    status: 304,
    headers: { 'cache-control': cacheControl(REVALIDATE), etag },
  });
}

/**
 * `GET /api/runs/:run/beans/:bean/diff` without bindings: a bean's own diff (its landing, or
 * its newest head against the line) for whoever may read the run, with the browser headers of
 * docs/claude-opus/35-caching.md §4.5. The route binds it to the session, the gateway and the
 * edge object cache.
 *
 * - A public repository's diff is read through the edge object cache, keyed by its commit
 *   pair (immutable), and says which layer served it in `Server-Timing`.
 * - A private or internal repository's diff is read from the gateway every time.
 * - A validated bean's pair is final: `immutable`. An open bean's moves: 30 s. Both carry the
 *   pair as a strong ETag, so the browser revalidates cheaply. A benchmark race (platform
 *   admins only) is never kept.
 */
import type { RunId, TaskId } from '@gitstalk/shared-race/ids';

import { isForgeError } from '@gitstalk/shared-ask/forge/forge-errors';
import type { BeanStatus, ForgeSource } from '@gitstalk/shared-ask/forge/forge-source';
import type { RepoDiff } from '@gitstalk/shared-ask/repo/repo-types';
import type { CacheRule } from '../edge/http-cache';
import { IMMUTABLE, NO_STORE, jsonAnswer, pairEtag, problem } from '../edge/http-cache';
import type { EdgeAnswer, EdgeObjectCache } from '../edge/object-cache';
import { DIFF_CODEC } from '../edge/stored-objects';
import { log } from '../log';
import type { Visibility } from '../query/policy';
import { PublicEngine } from '../repo-pages/event-cache';

/** What the run routes serve of an engine to the requester (`runAccess` in admin-gate.ts). */
export type RunAccess =
  | { readonly kind: 'refused' }
  /** A benchmark race, to a platform admin. */
  | { readonly kind: 'race' }
  | { readonly kind: 'repository'; readonly visibility: Visibility };

export type BeanDiffDeps = {
  readonly source: Pick<ForgeSource, 'beanDetail' | 'repoDiff'>;
  readonly objects: EdgeObjectCache;
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

/** An open bean's diff may be reused by the browser for this long. */
const OPEN_DIFF_SECONDS = 30;

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
    const etag = pairEtag(base, head);
    const rule = ruleFor(detail.status);
    const shared = PublicEngine.of(access, run);
    if (shared === null) return jsonAnswer(request, await read(), { rule, etag });
    const now = deps.now ?? Date.now;
    const started = now();
    const answer: EdgeAnswer<RepoDiff> = await deps.objects.read(
      shared,
      { kind: 'diff', base, head },
      DIFF_CODEC,
      read,
    );
    const timing = { layer: answer.layer, ms: now() - started };
    return jsonAnswer(request, answer.value, { rule, etag, timing });
  } catch (error: unknown) {
    if (isForgeError(error, 'not_found')) return problem(404, error.message);
    log.error('bean diff failed', { run, bean, error });
    return problem(502, 'the gateway could not produce this diff');
  }
}

/**
 * A validated bean's diff is its landing, for good. A bean that has only landed on the sprout
 * can still be reset and requeued (a new pair under the same URL), so it is not immutable yet.
 */
function ruleFor(status: BeanStatus): CacheRule {
  return status === 'green' ? IMMUTABLE : { kind: 'fresh-for', seconds: OPEN_DIFF_SECONDS };
}

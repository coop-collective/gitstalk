/**
 * The Changes tab's JSON routes, without bindings: `answerEvents` and `answerPushed` take the
 * viewer's view of the repository (`RepoAccess`) and answer like its pages: a 404 for anyone
 * who may not read it (the same for private and missing). Errors are `no-store`. No shared
 * proxy keeps either (docs/claude-opus/35-caching.md §4.5).
 *
 * - A public repository's answers are `private, no-cache`: this browser may keep them, only to
 *   revalidate. The events carry an ETag naming the engine and their last event, and a
 *   matching `If-None-Match` gets a 304, only ever after the access check.
 * - A private or internal repository's answers are never kept (`no-store`): a kept copy would
 *   outlive sign-out and revoked access.
 *
 * `?after=` reads only the tail of the log from the gateway (a public repository's log comes
 * from the isolate's append-only cache instead). The routes in `app/api/repos/[owner]/[repo]/`
 * bind them to the session and the GATEWAY (`viewer-repo-access.ts`).
 */
import type { CacheRule } from '../edge/http-cache';
import {
  NO_STORE,
  REVALIDATE,
  byVisibility,
  eventsEtag,
  jsonAnswer,
  problem,
} from '../edge/http-cache';
import { log } from '../log';
import type { Visibility } from '../query/policy';
import type { EngineReads } from '../repo-pages/engine-reads';
import type { EventsAnswer, PushedAnswer } from './change-feed';

/** The engine reads these routes make. */
export type ChangeReads = Pick<EngineReads, 'engine' | 'eventsAfter' | 'pushed'>;

/** What the viewer may read of the repository they asked for. */
export type RepoAccess =
  | { readonly kind: 'not-found' }
  /** `reads` is null when the record's engine id is unusable. */
  | {
      readonly kind: 'found';
      readonly visibility: Visibility;
      readonly reads: ChangeReads | null;
    };

/** `GET …/events[?after=<seq>]`: the engine's events, all of them or those after a seq. */
export async function answerEvents(request: Request, access: RepoAccess): Promise<Response> {
  const after = afterOf(request);
  if (after === null) return problem(400, 'after must be a non-negative integer');
  return answer(access, async (reads, visibility) => {
    const events = await reads.eventsAfter(after);
    const body: EventsAnswer = { events };
    const rule = ruleFor(visibility);
    if (rule.kind === 'no-store') return jsonAnswer(request, body, { rule });
    const etag = eventsEtag(reads.engine, after, events.at(-1));
    return jsonAnswer(request, body, { rule, etag });
  });
}

/** `GET …/pushed`: the beans people pushed, with their phase and verdict. */
export function answerPushed(request: Request, access: RepoAccess): Promise<Response> {
  return answer(access, async (reads, visibility) => {
    const body: PushedAnswer = { pushed: await reads.pushed() };
    return jsonAnswer(request, body, { rule: ruleFor(visibility) });
  });
}

function ruleFor(visibility: Visibility): CacheRule {
  return byVisibility(visibility, { public: REVALIDATE, restricted: NO_STORE });
}

async function answer(
  access: RepoAccess,
  read: (reads: ChangeReads, visibility: Visibility) => Promise<Response>,
): Promise<Response> {
  if (access.kind === 'not-found') return problem(404, 'no such repository');
  if (access.reads === null) return problem(503, 'the engine is not reachable');
  try {
    return await read(access.reads, access.visibility);
  } catch (error: unknown) {
    log.error('changes read failed', { engine: access.reads.engine, error });
    return problem(502, 'the gateway could not read the engine');
  }
}

/** `?after=` as a seq (0 when absent), or null when it is not a non-negative integer. */
function afterOf(request: Request): number | null {
  const raw = new URL(request.url).searchParams.get('after');
  if (raw === null || raw === '') return 0;
  const after = Number(raw);
  return Number.isInteger(after) && after >= 0 ? after : null;
}

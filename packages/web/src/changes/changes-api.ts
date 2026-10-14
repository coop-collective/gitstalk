/**
 * The Changes tab's JSON routes, without bindings: `answerEvents` and `answerPushed` take the
 * viewer's view of the repository (`RepoAccess`) and answer like its pages: a 404 for anyone
 * who may not read it (the same for private and missing). An answer is `private, no-cache`:
 * only this browser may keep it, and only to revalidate (the events carry an ETag naming
 * their last seq, and a matching `If-None-Match` gets a 304, only ever after the access
 * check). Errors are `no-store`. No shared proxy keeps either (docs/claude-opus/35-caching.md).
 * The routes in `app/api/repos/[owner]/[repo]/` bind them to the session and the GATEWAY
 * (`viewer-repo-access.ts`).
 */
import { REVALIDATE, jsonAnswer, problem, seqEtag } from '../edge/http-cache';
import { log } from '../log';
import type { EngineReads } from '../repo-pages/engine-reads';
import type { EventsAnswer, PushedAnswer } from './change-feed';
import { eventsAfter } from './change-feed';

/** The engine reads these routes make. */
export type ChangeReads = Pick<EngineReads, 'engine' | 'events' | 'pushed'>;

/** What the viewer may read of the repository they asked for. */
export type RepoAccess =
  | { readonly kind: 'not-found' }
  /** `reads` is null when the record's engine id is unusable. */
  | { readonly kind: 'found'; readonly reads: ChangeReads | null };

/** `GET …/events[?after=<seq>]`: the engine's events, all of them or those after a seq. */
export async function answerEvents(request: Request, access: RepoAccess): Promise<Response> {
  const after = afterOf(request);
  if (after === null) return problem(400, 'after must be a non-negative integer');
  return answer(access, async (reads) => {
    const events = await reads.events();
    const body: EventsAnswer = { events: eventsAfter(events, after) };
    const etag = seqEtag(events.at(-1)?.seq ?? 0);
    return jsonAnswer(request, body, { rule: REVALIDATE, etag });
  });
}

/** `GET …/pushed`: the beans people pushed, with their phase and verdict. */
export function answerPushed(request: Request, access: RepoAccess): Promise<Response> {
  return answer(access, async (reads) => {
    const body: PushedAnswer = { pushed: await reads.pushed() };
    return jsonAnswer(request, body, { rule: REVALIDATE });
  });
}

async function answer(
  access: RepoAccess,
  read: (reads: ChangeReads) => Promise<Response>,
): Promise<Response> {
  if (access.kind === 'not-found') return problem(404, 'no such repository');
  if (access.reads === null) return problem(503, 'the engine is not reachable');
  try {
    return await read(access.reads);
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

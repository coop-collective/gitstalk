/**
 * What a batch of new engine events makes stale on the page that received it
 * (docs/claude-opus/35-caching.md §4.4). Pure: the live feed hooks apply the answer.
 *
 * | Fresh events                                          | Answer                                  |
 * |-------------------------------------------------------|-----------------------------------------|
 * | a push, a verdict, a landing… (`movesPushedBeans`)    | invalidate the pushed beans             |
 * | a push or the landing of a bean on screen             | invalidate that bean's diff             |
 * | a line head moved past the one the page rendered      | refresh the page now (server data)      |
 * | validation activity, on a page that shows it          | refresh the page, debounced             |
 *
 * The events themselves are appended by the feed (`appendBySeq`), never refetched.
 */
import type { QueryKey } from '@tanstack/react-query';

import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';
import { changesBeanDiff, movesPushedBeans } from '../changes/change-feed';
import type { qk } from './keys';

/** One repository's keys for one viewer (`qk.repo(uid, owner, repo)`). */
export type RepoKeys = ReturnType<typeof qk.repo>;

export type Line = 'stalk' | 'sprout';

/** The commit each line was at when the page rendered; null for a line the page does not show. */
export type LineHeads = Readonly<Record<Line, string | null>>;

/** What the page receiving the events shows. */
export type FeedWatch = {
  /** Beans whose diff is on screen. */
  readonly beans?: readonly string[];
  /** The line heads the page rendered at (Code on a line, History). */
  readonly heads?: LineHeads;
  /** Whether the page shows validation activity (History): verdicts, decisions, requeues. */
  readonly activity?: boolean;
};

/** Whether the server-rendered page must be rendered again, and how soon. */
export type Refresh = 'none' | 'now' | 'debounced';

/** A refresh for activity that moves no head (History) waits this long, to batch a burst. */
export const ACTIVITY_REFRESH_MS = 2000;
/**
 * The longest a refresh after a head move waits: each viewer waits a random share of it, so
 * the viewers of a busy public repository do not all render it again in the same instant.
 */
export const HEAD_REFRESH_JITTER_MS = 1500;

/** How long a refresh waits before the page is rendered again. */
export function refreshDelay(refresh: Exclude<Refresh, 'none'>, random = Math.random): number {
  return refresh === 'now' ? Math.floor(random() * HEAD_REFRESH_JITTER_MS) : ACTIVITY_REFRESH_MS;
}

export type StaleKeys = {
  readonly invalidate: readonly QueryKey[];
  readonly refresh: Refresh;
};

/** Where a line's head went. */
export type HeadMove = { readonly line: Line; readonly sha: string };

/** The queries a batch of fresh events makes stale, and whether the page must be re-rendered. */
export function staleKeysFor(
  fresh: readonly RaceEvent[],
  keys: RepoKeys,
  watch: FeedWatch = {},
): StaleKeys {
  const invalidate: QueryKey[] = [];
  if (movesPushedBeans(fresh)) invalidate.push(keys.pushed());
  for (const bean of watch.beans ?? [])
    if (changesBeanDiff(fresh, bean)) invalidate.push(keys.bean(bean));
  return { invalidate, refresh: refreshFor(fresh, watch) };
}

/**
 * Each line's newest head in the events, oldest first: a landing on the sprout (`trunk`) or
 * straight onto the stalk (`main`, queue mode), a promotion or a demotion of the stalk (a red
 * audit takes it back), a revert (a new sprout commit) and a red reset of the sprout. These
 * are the gateway's line moves (`LINE_MOVE_TYPES`) but the start, which no page outlives.
 */
export function headMoves(events: readonly RaceEvent[]): readonly HeadMove[] {
  const newest = new Map<Line, string>();
  for (const event of events) {
    const move = headMoveOf(event);
    if (move !== null) newest.set(move.line, move.sha);
  }
  return [...newest].map(([line, sha]) => ({ line, sha }));
}

/** Events that change what History shows beside the commits, without moving a head. */
const ACTIVITY_KINDS: ReadonlySet<RaceEvent['type']> = new Set<RaceEvent['type']>([
  'ci.end',
  'final.check',
  'decision.made',
  'bean.requeued',
  'queue.eject',
]);

function refreshFor(fresh: readonly RaceEvent[], watch: FeedWatch): Refresh {
  const { heads } = watch;
  if (heads !== undefined && headMoves(fresh).some((move) => movedPast(heads, move))) return 'now';
  if (watch.activity === true && fresh.some((event) => ACTIVITY_KINDS.has(event.type)))
    return 'debounced';
  return 'none';
}

/** Whether the page shows `move.line` and rendered it at another commit. */
function movedPast(heads: LineHeads, move: HeadMove): boolean {
  const rendered = heads[move.line];
  return rendered !== null && rendered !== move.sha;
}

function headMoveOf(event: RaceEvent): HeadMove | null {
  if (event.type === 'land') return landingMove(event.target, event.sha);
  if (event.type === 'green.promote' || event.type === 'green.demote')
    return { line: 'stalk', sha: event.sha };
  if (event.type === 'revert' || event.type === 'sprout.reset')
    return { line: 'sprout', sha: event.sha };
  return null;
}

/** A landing on the sprout (`trunk`) or straight onto the stalk (`main`); others move neither. */
function landingMove(target: string, sha: string): HeadMove | null {
  if (target === 'trunk') return { line: 'sprout', sha };
  return target === 'main' ? { line: 'stalk', sha } : null;
}

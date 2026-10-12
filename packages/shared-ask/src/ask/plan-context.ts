/**
 * What every answer needs before it can be arranged: the ref, the tree, the race as of now,
 * the beans, decisions and the line's history in the question's range. Loaded in parallel.
 */
import type { RunId, Sha, TaskId } from '@gitstalk/shared-race/ids';

import type { BeanRecord, DecisionRecord, ForgeSource } from '../forge/forge-source';
import type { Picker } from '../pick/picker';
import type { RaceEvent } from '../race/race-events';
import type { RaceState } from '../race/race-state';
import { reduceRace } from '../race/reduce-race';
import type { RepoCommit, RepoTree } from '../repo/repo-types';
import type { Removals } from './chips';
import type { LineRef, ViewSpec } from './view-spec';

/** Events read per page while loading a run's log. */
const EVENTS_PAGE = 5000;

export type Selection = {
  readonly file: string | null;
  readonly bean: TaskId | null;
  /** `blame`: the file with each line attributed to the bean that last changed it. */
  readonly view: 'diff' | 'file' | 'blame' | null;
};

export type RangeWindow = {
  /** Race second the range starts at; null for the whole run. */
  readonly since: number | null;
  /** The line commit before the range (the diff base). */
  readonly fromSha: Sha;
  /** Line commits inside the range, newest first. */
  readonly commits: readonly RepoCommit[];
};

export type PlanContext = {
  readonly source: ForgeSource;
  readonly run: RunId;
  readonly spec: ViewSpec;
  readonly removals: Removals;
  readonly selection: Selection;
  readonly picker: Picker;
  readonly refName: LineRef;
  readonly tree: RepoTree;
  readonly treePaths: ReadonlySet<string>;
  readonly events: readonly RaceEvent[];
  readonly state: RaceState;
  readonly beans: readonly BeanRecord[];
  readonly beanById: ReadonlyMap<string, BeanRecord>;
  readonly decisions: readonly DecisionRecord[];
  /** Line commits up to the ref, newest first. */
  readonly log: readonly RepoCommit[];
  readonly range: RangeWindow;
  /** The race second the answer describes. */
  readonly now: number;
};

export async function loadPlanContext(input: {
  readonly source: ForgeSource;
  readonly run: RunId;
  readonly spec: ViewSpec;
  readonly removals: Removals;
  readonly selection: Selection;
  readonly picker: Picker;
}): Promise<PlanContext> {
  const { source, run, spec } = input;
  const refName = spec.range.ref;
  const [options, tree, events, beans, decisions, log] = await Promise.all([
    source.runOptions(run),
    source.repoTree(run, refName),
    allEvents(source, run),
    source.beansByPath(run, []),
    source.decisions(run),
    source.repoLog(run, refName),
  ]);
  const state = reduceRace(events, options);
  const now = state.endedAt ?? state.clock;
  return {
    ...input,
    refName,
    tree,
    treePaths: new Set(tree.files.map((file) => file.path)),
    events,
    state,
    beans,
    beanById: new Map(beans.map((bean) => [bean.id, bean])),
    decisions,
    log,
    range: rangeWindow({ log, minutes: spec.range.minutes, now, refSha: tree.sha }),
    now,
  };
}

/** Every event of a run, page by page. */
export async function allEvents(source: ForgeSource, run: RunId): Promise<readonly RaceEvent[]> {
  const events: RaceEvent[] = [];
  let after = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- pages follow a cursor, one after another
    const page = await source.runEvents(run, after, EVENTS_PAGE);
    events.push(...page.events);
    if (page.done || page.events.length === 0) return events;
    after = page.nextAfter;
  }
}

/** The events of a log after a cursor, and the cursor its last page ended on. */
export type EventsTail = {
  readonly events: readonly RaceEvent[];
  /** The last sequence number the gateway read (pass it as `after` to continue). */
  readonly last: number;
};

/**
 * A run's events after `after`, page by page: what a reader that already holds the start of
 * the log needs. It stops at a page that spans fewer sequence numbers than a full page holds,
 * so a live log (never `done`) costs one call, not a trailing empty one.
 */
export async function eventsAfter(
  source: Pick<ForgeSource, 'runEvents'>,
  run: RunId,
  after: number,
): Promise<EventsTail> {
  const events: RaceEvent[] = [];
  let cursor = after;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- pages follow a cursor, one after another
    const page = await source.runEvents(run, cursor, EVENTS_PAGE);
    events.push(...page.events);
    // A page holds at most one row per sequence number in (cursor, nextAfter], so a span
    // shorter than the page size means the log ended inside it.
    if (page.done || page.nextAfter - cursor < EVENTS_PAGE)
      return { events, last: Math.max(page.nextAfter, cursor) };
    cursor = page.nextAfter;
  }
}

function rangeWindow(input: {
  readonly log: readonly RepoCommit[];
  readonly minutes: number | null;
  readonly now: number;
  readonly refSha: Sha;
}): RangeWindow {
  const since = input.minutes === null ? null : input.now - input.minutes * 60;
  const commits =
    since === null
      ? input.log
      : input.log.filter((commit) => commit.t !== null && commit.t >= since);
  const oldest = commits.at(-1);
  return { since, fromSha: oldest?.parent ?? input.refSha, commits };
}

/** Files a list of commits changed. */
export function filesChanged(commits: readonly RepoCommit[]): ReadonlySet<string> {
  return new Set(commits.flatMap((commit) => commit.files.map((file) => file.path)));
}

/**
 * The beans a bean never saw: those that landed on the sprout after it forked, and those
 * pushed before it that are still being checked, which may land first
 * (`docs/claude-opus/32-approval-rules.md` §4.1). A triage shows Clef their intents beside the
 * bean's own, so two changes that merge cleanly and pass their tests but disagree (one moves
 * prices to dollars, the other adds shipping in cents) can go back to the author before they
 * land together. An author who read them says so with a commit trailer, which takes them out.
 */
import type { Sha } from '@gitstalk/shared-race/ids';

import type { TaskState } from '../engine/model';
import type { EngineState } from '../engine/state';
import type { BeanLinks } from './bean-links';
import type { V2State } from '../engine/v2/v2-state';
import { sproutIndex } from '../engine/v2/v2-sprout';

/** The newest landed beans a triage lists; older ones the bean's author has more likely met. */
export const LANDED_SINCE_FORK_LIMIT = 8;

/** The trailer an author adds once they checked their bean against the beans it names. */
export const INTENT_CHECKED_TRAILER = 'Intent-checked';

/**
 * A bean the judged bean never saw: its name, the files it changed and the commit range that
 * is its change (a landed bean's sprout commit and its parent; an in-flight bean's pushed
 * head and fork point).
 */
export type LandedBean = {
  readonly bean: string;
  readonly files: readonly string[];
  readonly sha: Sha;
  readonly parent: Sha;
  /** `landed`: on the sprout; `in-flight`: pushed earlier and still being checked. */
  readonly state: 'landed' | 'in-flight';
};

/** Task statuses of a bean whose push is being checked or waits to be (not sent back). */
const IN_FLIGHT: ReadonlySet<string> = new Set(['queued', 'testing', 'running']);

/** A landed bean with its intent and the files both beans changed. */
export type LandedIntent = LandedBean & {
  readonly intent: string | null;
  readonly sharedFiles: readonly string[];
};

/** A landed bean as Clef reads it: also its full commit message and how the two connect. */
export type LandedContext = LandedIntent & {
  /** Its latest push's whole commit message, when it says more than the intent. */
  readonly message: string | null;
  readonly links: BeanLinks;
};

/**
 * The live beans on the sprout after `task`'s fork point, newest first, at most
 * `LANDED_SINCE_FORK_LIMIT`. Empty when the engine is not a v2 sprout or the fork is unknown.
 */
export function landedSinceFork(state: EngineState, task: string): readonly LandedBean[] {
  const sprout = state.policy;
  const fork = forkOf(state, task);
  if (sprout?.kind !== 'beanstalk-v2' || fork === null) return [];
  return sprout.commits
    .slice(sproutIndex(sprout, fork) + 1)
    .flatMap((commit) =>
      isOtherLiveBean(commit, task) && commit.task !== null
        ? [
            {
              bean: commit.task,
              files: [...commit.files],
              sha: commit.sha,
              parent: commit.parent,
              state: 'landed' as const,
            },
          ]
        : [],
    )
    .toReversed()
    .slice(0, LANDED_SINCE_FORK_LIMIT);
}

/**
 * The beans pushed before `task` (an earlier first start) whose push is still in flight:
 * two beans checked at the same time never see each other landed, and the engine lands the
 * later one without a new check when their files differ, so the later push is judged against
 * the earlier one now. Oldest first, at most `LANDED_SINCE_FORK_LIMIT`. `filesOf` gives a
 * bean's pushed files.
 */
export function inFlightBefore(
  tasks: Readonly<Record<string, TaskState>>,
  task: string,
  filesOf: (bean: string) => readonly string[],
): readonly LandedBean[] {
  const mine = tasks[task]?.startedAt ?? null;
  if (mine === null) return [];
  return Object.values(tasks)
    .filter(
      (other) => other.id !== task && isInFlight(other) && isBefore(other, { at: mine, task }),
    )
    .toSorted((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    .slice(0, LANDED_SINCE_FORK_LIMIT)
    .flatMap((other) => {
      const parent = other.pushedBase ?? other.baseSha;
      if (other.headSha === null || parent === null) return [];
      return [
        {
          bean: other.id,
          files: filesOf(other.id),
          sha: other.headSha,
          parent,
          state: 'in-flight' as const,
        },
      ];
    });
}

/** The beans a commit message's `Intent-checked:` trailers name (comma or space separated). */
export function intentCheckedBeans(message: string | null): ReadonlySet<string> {
  if (message === null) return new Set();
  const trailer = new RegExp(`^${INTENT_CHECKED_TRAILER}:(.*)$`, 'gimu');
  const named = [...message.matchAll(trailer)].flatMap((match) =>
    (match[1] ?? '').split(/[\s,]+/u).filter((name) => name.length > 0),
  );
  return new Set(named.map((name) => name.replace(/^bean\//u, '')));
}

/** Each landed bean with its intent and the files it shares with the bean being judged. */
export function withIntents(
  landed: readonly LandedBean[],
  input: { readonly files: readonly string[]; readonly intent: (bean: string) => string | null },
): readonly LandedIntent[] {
  const mine = new Set(input.files);
  return landed.map((entry) => ({
    ...entry,
    intent: input.intent(entry.bean),
    sharedFiles: entry.files.filter((path) => mine.has(path)),
  }));
}

/** Where a task's change grew from: its pushed fork point, else its base (null: unknown). */
function forkOf(state: EngineState, task: string): Sha | null {
  const record = state.tasks[task];
  if (record === undefined) return null;
  return record.pushedBase ?? record.baseSha;
}

function isInFlight(task: TaskState): boolean {
  return IN_FLIGHT.has(task.status) && task.landedSha === null;
}

/** Started before `than` (ties broken by id, so of two beans exactly one is first). */
function isBefore(task: TaskState, than: { readonly at: number; readonly task: string }): boolean {
  if (task.startedAt === null) return false;
  return task.startedAt < than.at || (task.startedAt === than.at && task.id < than.task);
}

function isOtherLiveBean(commit: V2State['commits'][number], task: string): boolean {
  return commit.kind === 'task' && commit.task !== task && !commit.reverted;
}

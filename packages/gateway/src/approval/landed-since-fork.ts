/**
 * The beans a bean never saw: those that landed on the sprout after it forked
 * (`docs/claude-opus/32-approval-rules.md` §4.1). A triage shows Clef their intents beside the
 * bean's own, so two changes that merge cleanly and pass their tests but disagree (one moves
 * prices to dollars, the other adds shipping in cents) can go back to the author before they
 * land together. An author who read them says so with a commit trailer, which takes them out.
 */
import type { Sha } from '@gitstalk/shared-race/ids';

import type { EngineState } from '../engine/state';
import type { V2State } from '../engine/v2/v2-state';
import { sproutIndex } from '../engine/v2/v2-sprout';

/** The newest landed beans a triage lists; older ones the bean's author has more likely met. */
export const LANDED_SINCE_FORK_LIMIT = 8;

/** The trailer an author adds once they checked their bean against the beans it names. */
export const INTENT_CHECKED_TRAILER = 'Intent-checked';

/** A bean that landed after another forked: its name and the files it changed. */
export type LandedBean = { readonly bean: string; readonly files: readonly string[] };

/** A landed bean as Clef reads it: with its intent and the files both beans changed. */
export type LandedIntent = LandedBean & {
  readonly intent: string | null;
  readonly sharedFiles: readonly string[];
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
        ? [{ bean: commit.task, files: [...commit.files] }]
        : [],
    )
    .toReversed()
    .slice(0, LANDED_SINCE_FORK_LIMIT);
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

function isOtherLiveBean(commit: V2State['commits'][number], task: string): boolean {
  return commit.kind === 'task' && commit.task !== task && !commit.reverted;
}

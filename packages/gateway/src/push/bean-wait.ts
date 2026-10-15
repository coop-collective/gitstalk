/**
 * Waiting for verdicts without polling (`docs/claude-opus/18-git-native-flow.md` §4.1). A push
 * to `refs/wait/any` or `refs/wait/all` stores nothing: it holds until one (any) or every (all)
 * of the pusher's beans in flight has its verdict, and prints them. `-o bean=<name>` (repeated)
 * names the beans instead of "every bean my credential has in flight", and one name re-attaches
 * to that bean's check. The engine's Durable Object wakes the waiting push when a bean changes
 * (`BeanWatchers`); the push asks again only then.
 */
import type { BeanPhase, PushBean } from './push-bean';

/** Refs under this prefix are waits, never stored. */
export const WAIT_REF_PREFIX = 'refs/wait/';

export type WaitMode = 'any' | 'all';

/** Phases a bean is still being checked in. */
const CHECKING: ReadonlySet<BeanPhase> = new Set(['checking', 'waiting']);
/** Phases that wait for the author's next push (or, for a held red, a person's approval). */
const ACTIONABLE: ReadonlySet<BeanPhase> = new Set(['red', 'conflict']);

/** The mode a pushed ref under `refs/wait/` asks for; null for a malformed wait ref. */
export function waitModeOfRef(ref: string): WaitMode | null {
  const rest = ref.slice(WAIT_REF_PREFIX.length);
  return rest === 'any' || rest === 'all' ? rest : null;
}

/** One bean as a wait sees it. */
export type WatchedBean = {
  readonly bean: string;
  readonly phase: BeanPhase;
  readonly pushes: number;
  /** The current push's verdict lines, once it has one. */
  readonly verdict: readonly string[] | null;
  /** The phase that verdict gave (the bean may have moved on: landed, then green). */
  readonly verdictPhase: BeanPhase | null;
  /**
   * The approval rules hold it for a person (a red to git, `PushBean.held`): it waits for an
   * approval, not for its author's push.
   */
  readonly held: boolean;
  /** Lines numbered below this were written; a new line changes it. */
  readonly nextNote: number;
};

/** A wait's view of its beans, and a key that changes whenever one of them does. */
export type BeanWatch = {
  readonly key: string;
  readonly beans: readonly WatchedBean[];
  /** Named beans the engine has never seen pushed. */
  readonly unknown: readonly string[];
};

export type WatchInput = {
  /** Whose beans a wait without names covers: those `actor` pushed last. */
  readonly actor: string;
  /** Named beans; null: the actor's beans in flight (checking, red or conflict). */
  readonly beans: readonly string[] | null;
  /** The key the caller saw; the watch returns at once when it is out of date. Null: now. */
  readonly known: string | null;
  /** Longest the watch holds for a change. */
  readonly maxMs: number;
};

/** The watch of `input`'s beans, read from the pushed beans. */
export function beanWatch(
  input: Pick<WatchInput, 'actor' | 'beans'>,
  read: { one(bean: string): PushBean | null; all(): readonly PushBean[] },
): BeanWatch {
  const named = input.beans;
  const found =
    named === null
      ? read.all().filter((bean) => bean.actor === input.actor && isInFlight(bean.phase))
      : named.flatMap((name) => {
          const bean = read.one(name);
          return bean === null ? [] : [bean];
        });
  const beans = found.map(watched);
  const unknown = named === null ? [] : named.filter((name) => read.one(name) === null);
  const key = JSON.stringify(
    beans.map((bean) => [bean.bean, bean.pushes, bean.phase, bean.held, bean.nextNote]),
  );
  return { key, beans, unknown };
}

function watched(bean: PushBean): WatchedBean {
  const verdict = bean.verdict !== null && bean.verdict.push === bean.pushes ? bean.verdict : null;
  return {
    bean: bean.bean,
    phase: bean.phase,
    pushes: bean.pushes,
    verdict: verdict === null ? null : verdict.lines,
    verdictPhase: verdict === null ? null : verdict.phase,
    held: bean.held !== null && bean.phase === 'red',
    nextNote: bean.nextNote,
  };
}

export function isChecking(phase: BeanPhase): boolean {
  return CHECKING.has(phase);
}

export function isActionable(phase: BeanPhase): boolean {
  return ACTIONABLE.has(phase);
}

/** A bean that waits for its author's next push: red or in conflict, and not held. */
export function needsPush(bean: WatchedBean): boolean {
  return isActionable(bean.phase) && !bean.held;
}

function isInFlight(phase: BeanPhase): boolean {
  return isChecking(phase) || isActionable(phase);
}

/**
 * Whether a wait in `mode` is over: `any` when one of the beans it watches (those in check when
 * it started) has left the check, `all` when every one has.
 */
export function isWaitOver(
  mode: WaitMode,
  watching: ReadonlySet<string>,
  beans: readonly WatchedBean[],
): boolean {
  const settled = beans.filter((bean) => watching.has(bean.bean) && !isChecking(bean.phase));
  return mode === 'any'
    ? settled.length > 0 || watching.size === 0
    : settled.length >= watching.size;
}

type Watcher = { readonly beans: ReadonlySet<string>; readonly wake: () => void };

/**
 * The pushes waiting in one engine object for its beans to change. `notify` is called by every
 * save of a pushed bean; a watcher of that bean wakes at once. In memory only: a wait that
 * outlives the object (a deploy) is asked again by its push.
 */
export class BeanWatchers {
  readonly #watchers = new Set<Watcher>();

  /** Resolves when one of `beans` changes, or after `maxMs`. */
  async changeOf(beans: readonly string[], maxMs: number): Promise<void> {
    if (beans.length === 0 || maxMs <= 0) return;
    await new Promise<void>((resolve) => {
      const watcher: Watcher = {
        beans: new Set(beans),
        wake: () => {
          clearTimeout(timer);
          this.#watchers.delete(watcher);
          resolve();
        },
      };
      const timer = setTimeout(watcher.wake, maxMs);
      this.#watchers.add(watcher);
    });
  }

  /** A pushed bean changed: its watchers wake. */
  notify(bean: string): void {
    for (const watcher of this.#watchers) if (watcher.beans.has(bean)) watcher.wake();
  }
}

/**
 * The waiting halves of a push, streamed as `remote:` lines: `-o wait` on a bean push (its
 * progress and verdict) and a push to `refs/wait/any|all` (the first or every verdict of the
 * pusher's beans). Neither polls: each holds one `watchBeans` call on the engine object, which
 * returns when a watched bean changes; a keepalive line goes out every 15 s meanwhile, so git
 * and every proxy between see the push is alive.
 */
import type { RunDO } from '../run/run-do';
import type { BeanWatch, WaitMode, WatchInput, WatchedBean } from './bean-wait';
import { isActionable, isChecking, isWaitOver, needsPush } from './bean-wait';
import type { PushProgress } from './push-bean';
import { statusHint, waitCommand } from './push-messages';
import {
  arrivedLines,
  keepaliveLine,
  settledLines,
  waitEndLines,
  waitHeaderLines,
} from './wait-messages';

const KEEPALIVE_MS = 15_000;
/** A watch that fails (the engine object restarted) is asked again this many times. */
const WATCH_ATTEMPTS = 3;

type Engine = DurableObjectStub<RunDO>;
type Write = (lines: readonly string[]) => Promise<void>;

/** `-o wait` on a bean push: its progress lines, then its verdict or a timeout. */
export async function writePushVerdict(
  write: Write,
  wait: { engine: Engine; bean: string; push: number; seconds: number },
): Promise<void> {
  const watch = { engine: wait.engine, actor: '', beans: [wait.bean] };
  const deadlineMs = Date.now() + wait.seconds * 1000;
  const startMs = Date.now();
  let after = 0;
  for (;;) {
    // The key first: a change after it wakes the watch below even if the progress missed it.
    // oxlint-disable-next-line no-await-in-loop -- each round follows the last change
    const seen = await wait.engine.watchBeans({ ...watch, known: null, maxMs: 0 });
    // oxlint-disable-next-line no-await-in-loop -- read after the key
    const progress = await wait.engine.pushProgress(wait.bean, wait.push, after);
    if (progress === null) return;
    after = progress.lines.at(-1)?.n ?? after;
    // oxlint-disable-next-line no-await-in-loop -- lines go out as they come
    await write(orderedLines(progress));
    if (progress.verdict !== null) {
      // oxlint-disable-next-line no-await-in-loop -- the last lines
      await write(statusHint(wait.bean));
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- the wait for the next change
    const changed = await nextChange({ ...watch, known: seen.key, deadlineMs }, async () => {
      await write([`gitstalk: still checking (${Math.round((Date.now() - startMs) / 1000)} s)`]);
    });
    if (changed === null) {
      // oxlint-disable-next-line no-await-in-loop -- the timeout line
      await write(timeoutLines(wait.bean, progress.phase, Date.now() - startMs));
      return;
    }
  }
}

/** A push to `refs/wait/any|all`: waits for the first (any) or every (all) verdict. */
export async function writeBeanWait(
  write: Write,
  wait: {
    engine: Engine;
    actor: string;
    mode: WaitMode;
    beans: readonly string[] | null;
    seconds: number;
  },
): Promise<void> {
  const startMs = Date.now();
  const deadlineMs = startMs + wait.seconds * 1000;
  const first = await wait.engine.watchBeans({
    actor: wait.actor,
    beans: wait.beans,
    known: null,
    maxMs: 0,
  });
  await write(waitHeaderLines(wait.mode, first.beans, first.unknown));
  await write(first.beans.filter((bean) => isActionable(bean.phase)).flatMap(settledLines));
  const watching = new Set(first.beans.filter((bean) => isChecking(bean.phase)).map(name));
  // A held bean is printed but does not end an `any` wait: its author has nothing to push.
  if (watching.size === 0 || (wait.mode === 'any' && first.beans.some(needsPush))) {
    await write(waitEndLines(wait.mode, first.beans, null));
    return;
  }
  const watch = { engine: wait.engine, actor: wait.actor, beans: first.beans.map(name) };
  let current: BeanWatch = first;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one change at a time
    const next = await nextChange({ ...watch, known: current.key, deadlineMs }, async () => {
      await write([keepaliveLine(Date.now() - startMs, current.beans)]);
    });
    if (next === null) {
      // oxlint-disable-next-line no-await-in-loop -- the end
      await write(waitEndLines(wait.mode, current.beans, Date.now() - startMs));
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- verdicts go out as they come
    await write(arrivals(current.beans, next.beans, watching).flatMap(arrivedLines));
    current = next;
    if (isWaitOver(wait.mode, watching, current.beans)) {
      // oxlint-disable-next-line no-await-in-loop -- the end
      await write(waitEndLines(wait.mode, current.beans, null));
      return;
    }
  }
}

/** Watched beans that left the check between two watches. */
function arrivals(
  before: readonly WatchedBean[],
  after: readonly WatchedBean[],
  watching: ReadonlySet<string>,
): WatchedBean[] {
  const wasChecking = new Set(before.filter((bean) => isChecking(bean.phase)).map(name));
  return after.filter(
    (bean) => watching.has(bean.bean) && wasChecking.has(bean.bean) && !isChecking(bean.phase),
  );
}

/**
 * The beans' next change, or null at the deadline. One `watchBeans` call holds on the engine
 * (it returns at a change or after its own cap, then is asked again); `tick` runs every
 * keepalive interval meanwhile.
 */
async function nextChange(
  input: Omit<WatchInput, 'maxMs' | 'known'> & {
    engine: Engine;
    known: string;
    deadlineMs: number;
  },
  tick: () => Promise<void>,
): Promise<BeanWatch | null> {
  const { engine, deadlineMs, ...watch } = input;
  let failures = 0;
  for (;;) {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) return null;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one held call at a time
      const seen = await withKeepalive(engine.watchBeans({ ...watch, maxMs: remainingMs }), tick);
      if (seen.key !== watch.known) return seen;
    } catch (error: unknown) {
      failures += 1;
      if (failures >= WATCH_ATTEMPTS) throw error;
    }
  }
}

/** Awaits `pending`, running `tick` every keepalive interval until it settles. */
async function withKeepalive<T>(pending: Promise<T>, tick: () => Promise<void>): Promise<T> {
  const settled = pending.then((value) => ({ done: true as const, value }));
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a keepalive per interval
    const next = await Promise.race([settled, scheduler.wait(KEEPALIVE_MS).then(() => null)]);
    if (next !== null) return next.value;
    // oxlint-disable-next-line no-await-in-loop -- the keepalive line
    await tick();
  }
}

/** New lines in order: those before the verdict, the verdict, then those after it. */
function orderedLines(progress: PushProgress): string[] {
  const verdict = progress.verdict;
  if (verdict === null) return progress.lines.map((line) => line.text);
  const before = progress.lines.filter((line) => line.n <= verdict.after).map((line) => line.text);
  const later = progress.lines.filter((line) => line.n > verdict.after).map((line) => line.text);
  return [...before, ...verdict.lines, ...later];
}

function timeoutLines(bean: string, phase: string, waitedMs: number): string[] {
  return [
    `gitstalk: still ${phase} after ${Math.round(waitedMs / 1000)} s; the verdict will be on refs/beans/${bean}/status`,
    `gitstalk:   wait again (wakes at the verdict): ${waitCommand([bean])}`,
  ];
}

function name(bean: WatchedBean): string {
  return bean.bean;
}

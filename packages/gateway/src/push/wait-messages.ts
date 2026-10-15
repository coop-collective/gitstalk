/**
 * The `remote:` lines of a push to `refs/wait/any|all`: which beans it waits for, each verdict
 * as it arrives (the same lines `-o wait` prints), where every bean stands at the end, and what
 * to do next. A bean the approval rules hold is red to git, but these lines call it held and
 * never ask its author to fix or push it: a new push would need a new approval.
 */
import type { WaitMode, WatchedBean } from './bean-wait';
import { isChecking, needsPush } from './bean-wait';
import type { BeanPhase } from './push-bean';
import { REMOTE_PREFIX as P, waitCommand } from './push-messages';

/** Where a bean stands as a wait names it: its phase, or `held` for a hold's red. */
export type WaitStanding = BeanPhase | 'held';

export function waitHeaderLines(
  mode: WaitMode,
  beans: readonly WatchedBean[],
  unknown: readonly string[],
): string[] {
  const lines = unknown.map((name) => `${P} no pushed bean named ${name}; not waiting for it`);
  if (beans.length === 0)
    return [...lines, `${P} nothing to wait for: no bean of yours is in flight`];
  const what = mode === 'any' ? 'the first verdict' : 'every verdict';
  return [...lines, `${P} waiting for ${what} of ${standings(beans)}`];
}

/** A bean that already has its verdict when the wait starts: it waits for its author or a person. */
export function settledLines(bean: WatchedBean): string[] {
  const what = bean.held
    ? "is held for a person's approval"
    : `is ${bean.phase} and waits for your push`;
  return [`${P} ${bean.bean} ${what}:`, ...(bean.verdict ?? [])];
}

/** A verdict that arrived during the wait. */
export function arrivedLines(bean: WatchedBean): string[] {
  const phase = bean.held ? 'held' : (bean.verdictPhase ?? bean.phase);
  return [`${P} verdict for ${bean.bean}: ${phase}`, ...(bean.verdict ?? [])];
}

export function keepaliveLine(waitedMs: number, beans: readonly WatchedBean[]): string {
  const checking = beans.filter((bean) => isChecking(bean.phase)).map((bean) => bean.bean);
  return `${P} still waiting (${seconds(waitedMs)} s): ${checking.join(', ')} checking`;
}

/** Where the beans stand when the wait ends, and the next step. */
export function waitEndLines(
  mode: WaitMode,
  beans: readonly WatchedBean[],
  timedOutMs: number | null,
): string[] {
  if (beans.length === 0) return [];
  const checking = names(beans.filter((bean) => isChecking(bean.phase)));
  const toFix = names(beans.filter(needsPush));
  const held = names(beans.filter((bean) => bean.held));
  const lines = [`${P} your beans: ${standings(beans)}`];
  if (timedOutMs !== null)
    lines.push(
      `${P} no verdict after ${seconds(timedOutMs)} s; ${checking.join(', ')} still checking`,
    );
  if (toFix.length > 0)
    lines.push(
      `${P}   next: fix ${toFix.join(', ')} (rebase on origin/sprout, fix, git push -f to the bean)`,
    );
  if (held.length > 0)
    lines.push(
      `${P}   next: ask your person to approve ${held.join(', ')} on its page; do not push it again`,
    );
  if (checking.length > 0)
    lines.push(`${P}   then take your next task, or wait again: ${waitCommand(checking, mode)}`);
  return lines;
}

/** The bean's standing: `held` for a hold of the approval rules, else its phase. */
export function standingOf(bean: WatchedBean): WaitStanding {
  return bean.held ? 'held' : bean.phase;
}

function standings(beans: readonly WatchedBean[]): string {
  return beans.map((bean) => `${bean.bean} (${standingOf(bean)})`).join(', ');
}

function names(beans: readonly WatchedBean[]): string[] {
  return beans.map((bean) => bean.bean);
}

function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

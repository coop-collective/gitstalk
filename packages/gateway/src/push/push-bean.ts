/**
 * A pushed bean as a continuous engine's shell tracks it beside the engine state: who pushed
 * it and why, the commit to answer its next invocation with, the invocation waiting for the
 * author's next push (a red or a conflict), and the lines and verdict the pushes see as
 * `remote:` lines. The engine's events drive it (`foldEvent`); nothing here steps the engine.
 */
import { z } from 'zod';

import { Sha, TaskId } from '@gitstalk/shared-race/ids';

import { NO_PROTECTED_ACCESS, ProtectedAccess } from '../checks/protected-access';

/** Where a bean stands, as a push and its status ref say it. */
export const BeanPhase = z.enum([
  'checking',
  'landed',
  'green',
  'red',
  'conflict',
  'waiting',
  'parked',
  'dropped',
]);
export type BeanPhase = z.infer<typeof BeanPhase>;

/** Phases that end a push's wait: the author may act (or must not). */
const VERDICT_PHASES: ReadonlySet<BeanPhase> = new Set([
  'landed',
  'green',
  'red',
  'conflict',
  'parked',
  'dropped',
]);

/** Lines kept per bean for pushes that are waiting. */
const MAX_NOTES = 60;

const Note = z.object({ n: z.number().int(), push: z.number().int(), text: z.string() });

const Rework = z.object({
  reason: z.string(),
  failing: z.array(z.string()),
  culprits: z.array(z.string()),
  conflicts: z.array(z.string()),
});

/** Why the approval rules held the bean at its latest check (`preland.check.held`). */
export const CheckHold = z.object({
  classes: z.array(z.string()),
  class: z.string().nullable(),
  by: z.enum(['policy', 'clef', 'rules']),
});
export type CheckHold = z.infer<typeof CheckHold>;

export const PushBean = z.object({
  bean: TaskId,
  title: z.string(),
  intent: z.string(),
  task: z.string().nullable(),
  actor: z.string(),
  /** What the latest push may do to protected paths (beans stored before: nothing). */
  protectedAccess: ProtectedAccess.default(NO_PROTECTED_ACCESS),
  head: Sha,
  /** The files the latest push changes since it forked the sprout (beans stored before: none). */
  files: z.array(z.string()).default([]),
  /** Pushes accepted so far; a verdict belongs to the push it answers. */
  pushes: z.number().int().min(1),
  /** The rework invocation waiting for the author's next push. */
  awaiting: z
    .object({ inv: z.string(), slot: z.string(), kind: z.string(), prompt: z.string() })
    .nullable(),
  phase: BeanPhase,
  reason: z.string(),
  rework: Rework.nullable(),
  /**
   * Set when its latest check was a hold of the approval rules: its verdict then says it waits
   * for a person and that nothing needs fixing (beans stored before: none).
   */
  held: CheckHold.nullable().default(null),
  landedSha: z.string().nullable(),
  notes: z.array(Note),
  nextNote: z.number().int(),
  verdict: z
    .object({
      push: z.number().int(),
      phase: BeanPhase,
      lines: z.array(z.string()),
      /** The last note before the verdict: later notes print after it. */
      after: z.number().int().default(0),
    })
    .nullable(),
  /** The status tag last published: its object id, and the phase and head it carries. */
  status: z.object({ tag: Sha, phase: BeanPhase, head: Sha }).nullable(),
});
export type PushBean = z.infer<typeof PushBean>;

/** What a waiting push reads: lines after `after`, and the verdict once there is one. */
export type PushProgress = {
  readonly lines: readonly { readonly n: number; readonly text: string }[];
  readonly verdict: {
    readonly phase: BeanPhase;
    readonly lines: readonly string[];
    /** Lines numbered above this came after the verdict. */
    readonly after: number;
  } | null;
  readonly phase: BeanPhase;
};

/** A new bean, or the next push of a known one. */
export function receivedBean(input: {
  bean: TaskId;
  title: string;
  intent: string;
  task: string | null;
  actor: string;
  protectedAccess: ProtectedAccess;
  head: Sha;
  files: readonly string[];
  previous: PushBean | null;
}): PushBean {
  const { previous } = input;
  return {
    bean: input.bean,
    title: previous?.title ?? input.title,
    intent: previous?.intent ?? input.intent,
    task: input.task ?? previous?.task ?? null,
    actor: input.actor,
    protectedAccess: input.protectedAccess,
    head: input.head,
    files: [...input.files],
    pushes: (previous?.pushes ?? 0) + 1,
    awaiting: null,
    phase: 'checking',
    reason: 'the pre-land check is running on the merged tree',
    rework: null,
    held: null,
    landedSha: null,
    notes: previous?.notes ?? [],
    nextNote: previous?.nextNote ?? 1,
    verdict: null,
    status: previous?.status ?? null,
  };
}

/** Appends a line for the current push's watchers. */
export function withNote(bean: PushBean, text: string): PushBean {
  const note = { n: bean.nextNote, push: bean.pushes, text };
  return { ...bean, notes: [...bean.notes, note].slice(-MAX_NOTES), nextNote: bean.nextNote + 1 };
}

/** The phase the bean reached, and the verdict for the current push when it ends the wait. */
export function withPhase(
  bean: PushBean,
  change: { phase: BeanPhase; reason: string; lines?: readonly string[] },
): PushBean {
  const isVerdict = VERDICT_PHASES.has(change.phase) && bean.verdict === null;
  return {
    ...bean,
    phase: change.phase,
    reason: change.reason,
    verdict: isVerdict
      ? {
          push: bean.pushes,
          phase: change.phase,
          lines: [...(change.lines ?? [change.reason])],
          after: bean.nextNote - 1,
        }
      : bean.verdict,
  };
}

/** What a push waiting on this bean sees after line `after`. */
export function progressOf(bean: PushBean, push: number, after: number): PushProgress {
  const verdict = bean.verdict !== null && bean.verdict.push === push ? bean.verdict : null;
  return {
    lines: bean.notes
      .filter((note) => note.push === push && note.n > after)
      .map(({ n, text }) => ({ n, text })),
    verdict:
      verdict === null
        ? null
        : { phase: verdict.phase, lines: verdict.lines, after: verdict.after },
    phase: bean.phase,
  };
}

/** Records the rework the engine started, before its invocation arrives. */
export function withRework(bean: PushBean, rework: z.infer<typeof Rework>): PushBean {
  return { ...bean, rework };
}

/** Whether a new push may update the bean now, or why not. */
export function pushRefusal(bean: PushBean | null): string | null {
  if (bean === null || bean.awaiting !== null) return null;
  switch (bean.phase) {
    case 'landed':
    case 'green':
      return `bean ${bean.bean} already landed; push new work as a new bean (refs/heads/bean/<new-name>)`;
    case 'parked':
    case 'dropped':
      return `bean ${bean.bean} is ${bean.phase} (${bean.reason}); push the work again as a new bean`;
    case 'checking':
    case 'waiting':
    case 'red':
    case 'conflict':
      return `bean ${bean.bean} is being checked (push ${bean.pushes}, ${bean.head.slice(0, 7)}); its verdict comes first. Wait for it with git push -o bean=${bean.bean} origin HEAD:refs/wait/any (returns at the verdict), then push again if it is red or in conflict; a landed bean takes new work as a new bean`;
    default:
      return null;
  }
}

/** Storage: one JSON row per bean in the engine's SQLite, validated when read back. */
export function migratePushBeans(sql: SqlStorage): void {
  sql.exec('CREATE TABLE IF NOT EXISTS push_beans (bean TEXT PRIMARY KEY, body TEXT NOT NULL)');
}

export function readPushBean(sql: SqlStorage, bean: string): PushBean | null {
  const row = sql
    .exec<{ body: string }>('SELECT body FROM push_beans WHERE bean = ?', bean)
    .toArray()[0];
  if (row === undefined) return null;
  const parsed = PushBean.safeParse(JSON.parse(row.body));
  return parsed.success ? parsed.data : null;
}

export function savePushBean(sql: SqlStorage, bean: PushBean): void {
  sql.exec(
    'INSERT INTO push_beans (bean, body) VALUES (?, ?) ON CONFLICT(bean) DO UPDATE SET body = excluded.body',
    bean.bean,
    JSON.stringify(bean),
  );
}

export function listPushBeans(sql: SqlStorage): PushBean[] {
  return sql
    .exec<{ body: string }>('SELECT body FROM push_beans ORDER BY bean')
    .toArray()
    .flatMap((row) => {
      const parsed = PushBean.safeParse(JSON.parse(row.body));
      return parsed.success ? [parsed.data] : [];
    });
}

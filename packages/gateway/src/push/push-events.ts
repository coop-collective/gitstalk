/**
 * Folds the engine's events into the pushed beans they concern: each check, landing,
 * promotion, rework, park or drop becomes a line for the pushes watching that bean, a phase
 * for its status ref, and (when it ends the wait) the push's verdict.
 */
import { z } from 'zod';

import type { EmittedEvent } from '../engine/model';
import type { PushBean } from './push-bean';
import { CheckHold, withNote, withPhase, withRework } from './push-bean';
import type { VerdictContext } from './push-messages';
import { decisionLines, heldWhy, isGuardRed, landedLines, stoppedLines } from './push-messages';

/** What folding needs from the engine's shell. */
export type FoldContext = {
  readonly link: (bean: string) => string | null;
  /** The lines the check of a tree gave: its repository's checks, or why none ran. */
  readonly checkLines: (sha: string) => readonly string[];
};

const PrelandCheck = z.object({
  task: z.string(),
  sha: z.string().default(''),
  green: z.boolean(),
  failing_tests: z.array(z.string()).default([]),
  check_seconds: z.number().default(0),
  inherited: z.literal(true).optional(),
  held: CheckHold.optional(),
});
const MergeConflict = z.object({ task: z.string().nullable(), files: z.array(z.string()) });
const Land = z.object({ task: z.string().nullable().optional(), sha: z.string() });
const GreenPromote = z.object({ sha: z.string(), tasks: z.array(z.string()) });
const ReworkStart = z.object({
  task: z.string().nullable(),
  reason: z.string(),
  failing: z.array(z.string()).default([]),
  culprits: z.array(z.string()).default([]),
  conflicts: z.array(z.string()).default([]),
});
const Stopped = z.object({ task: z.string(), reason: z.string() });
const DecisionRequest = z.object({
  card: z.string(),
  task: z.string(),
  against: z.array(z.string()),
});

/** Applies `events` to `beans` (by bean id); returns the ids that changed. */
export function foldEvents(
  events: readonly EmittedEvent[],
  beans: Map<string, PushBean>,
  context: FoldContext,
): Set<string> {
  const changed = new Set<string>();
  for (const event of events) {
    for (const [id, update] of eventUpdates(event, beans, context)) {
      beans.set(id, update);
      changed.add(id);
    }
  }
  return changed;
}

type Updates = [string, PushBean][];
type Fold = {
  readonly beans: ReadonlyMap<string, PushBean>;
  readonly verdict: (bean: string) => VerdictContext;
  readonly checkLines: (sha: string) => readonly string[];
  /** The update of the bean `task` names, if it is a pushed bean. */
  readonly on: (task: string | null | undefined, update: (bean: PushBean) => PushBean) => Updates;
};

/** What each event type the flow follows does to the beans it names. */
const HANDLERS: Readonly<Partial<Record<string, (event: unknown, fold: Fold) => Updates>>> = {
  'preland.check': (event, { on, checkLines }) => {
    const check = PrelandCheck.safeParse(event);
    if (!check.success) return [];
    const lines = [...checkLines(check.data.sha), checkNote(check.data)];
    const held = check.data.held ?? null;
    return on(check.data.task, (bean) => lines.reduce(withNote, { ...bean, held }));
  },
  'merge.conflict': (event, { on }) => {
    const conflict = MergeConflict.safeParse(event);
    if (!conflict.success) return [];
    const files = conflict.data.files.join(', ');
    return on(conflict.data.task, (bean) =>
      withNote(bean, `gitstalk: merging onto the sprout conflicts in ${files}`),
    );
  },
  land: (event, { on, verdict }) => {
    const land = Land.safeParse(event);
    if (!land.success) return [];
    const { sha } = land.data;
    return on(land.data.task, (bean) =>
      withPhase(
        { ...bean, landedSha: sha },
        {
          phase: 'landed',
          reason: `on the sprout as ${sha.slice(0, 7)}`,
          lines: landedLines(verdict(bean.bean), sha),
        },
      ),
    );
  },
  'green.promote': (event, { on }) => {
    const promote = GreenPromote.safeParse(event);
    if (!promote.success) return [];
    const at = promote.data.sha.slice(0, 7);
    return promote.data.tasks.flatMap((task) =>
      on(task, (bean) =>
        withPhase(withNote(bean, `gitstalk: validated: on the stalk at ${at}`), {
          phase: 'green',
          reason: `validated; on the stalk at ${at}`,
        }),
      ),
    );
  },
  'rework.start': (event, { on }) => {
    const rework = ReworkStart.safeParse(event);
    if (!rework.success) return [];
    const { reason, failing, culprits, conflicts } = rework.data;
    return on(rework.data.task, (bean) =>
      withRework(bean, { reason, failing, culprits, conflicts }),
    );
  },
  'task.parked': (event, fold) => stopped(event, 'parked', fold),
  'task.drop': (event, fold) => stopped(event, 'dropped', fold),
  'decision.request': (event, { on }) => {
    const card = DecisionRequest.safeParse(event);
    if (!card.success) return [];
    return on(card.data.task, (bean) =>
      decisionLines(card.data.card, card.data.against).reduce(withNote, bean),
    );
  },
};

function eventUpdates(
  event: EmittedEvent,
  beans: ReadonlyMap<string, PushBean>,
  context: FoldContext,
): Updates {
  const handler = HANDLERS[event.type];
  if (handler === undefined) return [];
  return handler(event, {
    beans,
    verdict: (bean) => ({ bean, link: context.link(bean) }),
    checkLines: context.checkLines,
    on: (task, update) => {
      const bean = task === null || task === undefined ? undefined : beans.get(task);
      return bean === undefined ? [] : [[bean.bean, update(bean)]];
    },
  });
}

function stopped(event: unknown, phase: 'parked' | 'dropped', { on, verdict }: Fold): Updates {
  const parsed = Stopped.safeParse(event);
  if (!parsed.success) return [];
  const { reason } = parsed.data;
  return on(parsed.data.task, (bean) =>
    withPhase(
      { ...bean, awaiting: null },
      { phase, reason, lines: stoppedLines(verdict(bean.bean), phase, reason) },
    ),
  );
}

function checkNote(check: z.infer<typeof PrelandCheck>): string {
  const seconds = check.check_seconds.toFixed(1);
  if (check.green) return `gitstalk: pre-land check green on the merged tree (${seconds} s)`;
  if (check.inherited === true)
    return 'gitstalk: the sprout itself is red here; the bean waits for the sprout to be repaired';
  if (check.held !== undefined)
    return `gitstalk: pre-land check held for a person's approval (${heldWhy(check.held)})`;
  if (isGuardRed(check.failing_tests))
    return `gitstalk: pre-land check sent back by a rule in .gitstalk/ before its tests ran (${seconds} s)`;
  return `gitstalk: pre-land check red (${check.failing_tests.length} failing, ${seconds} s)`;
}

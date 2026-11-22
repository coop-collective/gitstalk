import { describe, expect, it } from 'vitest';

import { TaskId } from '@gitstalk/shared-race/ids';
import type { RunConfigInput } from '@gitstalk/shared-race/run-config';
import { V25_RULES_OFF } from '@gitstalk/shared-race/run-config';

import { createContext } from '../context';
import type { FailRule, ScriptedTask } from '../testing/fake-world';
import type { RaceRun, RaceScenario } from '../testing/scenario';
import { eventsOf, runRace, soloTask, wellFormedProblems } from '../testing/scenario';
import { STALL_SECONDS, ageBound, chooseStart } from './v2-start-order';

/**
 * Dependency-aware starts on a synthetic repo with dependency chains (E4's binding
 * constraint). The 40-task burst comparison lives in `v2-burst.test.ts`.
 */
const DEPENDENCY: Partial<RunConfigInput> = { start_order: 'dependency' };

/** Chain lengths of the synthetic repo: a few long chains, many short ones; then singletons. */
const CHAINS = [20, 15, 12, 10, 8, 8, 6, 6, 5, 5, 4, 4, 3, 3, 3, 2, 2, 2, 2, 2];
const SYNTHETIC_TASKS = 200;

/** A seeded linear congruential generator in [0, 1). */
function lcg(seed: number): () => number {
  const state = { value: seed };
  return () => {
    state.value = (Math.imul(state.value, 1_103_515_245) + 12_345) >>> 0;
    return state.value / 2 ** 32;
  };
}

function taskIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `t${String(index + 1).padStart(3, '0')}`);
}

/** Chain names in history order: chains interleaved at random, keeping each chain's order. */
function interleave(chains: readonly number[], total: number, random: () => number): string[] {
  const queues = chains.map((length, chain) => Array.from({ length }, () => `chain${chain}`));
  const singletons = total - chains.reduce((sum, length) => sum + length, 0);
  queues.push(...Array.from({ length: singletons }, () => ['solo']));
  const slots: string[] = [];
  while (queues.some((queue) => queue.length > 0)) {
    const open = queues.filter((queue) => queue.length > 0);
    const next = open[Math.floor(random() * open.length)]?.shift();
    if (next !== undefined) slots.push(next);
  }
  return slots;
}

type ChainShape = { chains?: readonly number[]; total?: number; seed?: number };

/**
 * Tasks in history order: chain members append to their chain's hot file, so a member
 * started before its predecessor landed conflicts with it. Agents work 2-10 minutes; the
 * footprints are predicted perfectly.
 */
export function chainScenario(
  config: Partial<RunConfigInput>,
  shape: ChainShape = {},
): RaceScenario {
  const { chains = CHAINS, total = SYNTHETIC_TASKS, seed = 11 } = shape;
  const random = lcg(seed);
  const slots = interleave(chains, total, random);
  const ids = taskIds(total);
  const chainOf = (index: number): string => slots[index] ?? 'solo';
  const tasks: ScriptedTask[] = ids.map((id, index) =>
    chainOf(index) === 'solo'
      ? soloTask(id)
      : soloTask(id, { appends: { [`src/${chainOf(index)}/log.ts`]: `entry ${id}` } }),
  );
  const footprints = Object.fromEntries(
    ids.map((id, index) => {
      const own = `src/${id}`;
      const selected = chainOf(index) === 'solo' ? [own] : [own, `src/${chainOf(index)}`];
      return [id, { method: 'oracle', selected, probs: {} }];
    }),
  );
  const durations = ids.map((id) => [id, 120_000 + Math.floor(random() * 480_000)] as const);
  const logs = chains.map((_, chain) => [`src/chain${chain}/log.ts`, 'log\n'] as const);
  return {
    tasks,
    seed,
    durations: Object.fromEntries(durations),
    baseFiles: { 'README.md': 'arena\n', ...Object.fromEntries(logs) },
    config: {
      policy: 'beanstalk-v2',
      agents: 64,
      ci_seconds: 60,
      ci_slots: 4,
      footprints,
      ...config,
    },
  };
}

type ChainNumbers = {
  readonly green: number;
  readonly dropped: number;
  readonly conflicts: number;
  /** When 85% of the tasks were green (the 170th of 200 in E4's shape). */
  readonly green85Minutes: number;
};

function chainNumbers(run: RaceRun): ChainNumbers {
  const tasks = Object.values(run.state.tasks);
  const greens = tasks
    .flatMap((task) => (task.greenAt === null ? [] : [task.greenAt]))
    .toSorted((a, b) => a - b);
  return {
    green: greens.length,
    dropped: tasks.filter((task) => task.status === 'dropped').length,
    conflicts: tasks.reduce((sum, task) => sum + task.conflicts, 0),
    green85Minutes: (greens[Math.ceil(tasks.length * 0.85) - 1] ?? Number.POSITIVE_INFINITY) / 60,
  };
}

/**
 * E4's shape at half size, so `pnpm check` stays fast: 100 tasks, 32 agents. The full 200
 * tasks on 64 agents takes about 30 s to simulate; its numbers are in the README.
 */
const HALF_CHAINS = [10, 8, 6, 5, 4, 4, 3, 3, 2, 2, 2, 2];
const HALF: ChainShape = { chains: HALF_CHAINS, total: 100 };
const HALF_AGENTS: Partial<RunConfigInput> = { agents: 32 };

describe('dependency-aware starts on dependency chains', () => {
  // A deterministic but CPU-heavy simulation: about 2 s quiet, more under load, so it gets room.
  it(
    'keeps every chained bean that fifo drops under v2.4, at about fifo’s pace',
    { timeout: 120_000 },
    () => {
      const v24 = { ...V25_RULES_OFF, ...HALF_AGENTS };
      const fifo = chainNumbers(runRace(chainScenario(v24, HALF)));
      const run = runRace(chainScenario({ ...v24, ...DEPENDENCY }, HALF));
      const dependency = chainNumbers(run);

      expect(wellFormedProblems(run.events)).toEqual([]);
      expect(fifo.dropped).toBeGreaterThan(0);
      expect(dependency).toMatchObject({ green: 100, dropped: 0 });
      expect(dependency.conflicts).toBeLessThan(fifo.conflicts * 0.7);
      expect(dependency.green85Minutes).toBeLessThan(fifo.green85Minutes * 1.15);
    },
  );

  // Two 100-task simulations: CPU-heavy, so it gets the same room as the chain test above.
  it(
    'under the v2.5 defaults (rescue keeps fifo’s beans) still cuts the conflicts',
    { timeout: 120_000 },
    () => {
      const fifo = chainNumbers(runRace(chainScenario(HALF_AGENTS, HALF)));
      const dependency = chainNumbers(
        runRace(chainScenario({ ...HALF_AGENTS, ...DEPENDENCY }, HALF)),
      );

      expect(fifo).toMatchObject({ green: 100, dropped: 0 });
      expect(dependency).toMatchObject({ green: 100, dropped: 0 });
      expect(dependency.conflicts).toBeLessThan(fifo.conflicts * 0.7);
    },
  );

  it('pipelines a chain at most three beans deep, then waits for a landing', () => {
    const run = runRace(chainScenario({ ...DEPENDENCY, agents: 20 }, { chains: [6], total: 20 }));

    const placements = eventsOf(run.events, 'placement.decision');
    const first = placements.filter((event) => event.t === placements[0]?.t);
    expect(first).toHaveLength(17);
    expect(first.filter((event) => event.rule === 'least-overlap')).toHaveLength(2);
    expect(chainNumbers(run)).toMatchObject({ green: 20, dropped: 0 });
  });

  it('starts an aged task next once enough later tasks overtook it', () => {
    expect(ageBound(1, 40)).toBe(4);
    expect(ageBound(64, 200)).toBe(32);
    expect(ageBound(64, 8)).toBe(2);
    const run = runRace(
      chainScenario({ ...DEPENDENCY, agents: 2 }, { chains: [12], total: 40, seed: 3 }),
    );

    expect(eventsOf(run.events, 'placement.decision', { rule: 'aged' }).length).toBeGreaterThan(0);
    expect(chainNumbers(run).green).toBe(40);
  });
});

/**
 * The longest stretch, in seconds, during which an agent had no invocation, a task was
 * unstarted and no task started: how long a free agent sat beside startable work.
 */
function longestIdleWait(run: RaceRun, agents: number): number {
  const total = Object.keys(run.state.tasks).length;
  const open = new Set<unknown>();
  const state = { placed: 0, longest: 0, idleSince: null as number | null };
  for (const event of run.events) {
    if (state.idleSince !== null)
      state.longest = Math.max(state.longest, event.t - state.idleSince);
    if (event.type === 'invocation.start') open.add(event['inv']);
    if (event.type === 'invocation.end') open.delete(event['inv']);
    if (event.type === 'placement.decision') state.placed += 1;
    const isIdle = state.placed < total && open.size < agents;
    if (!isIdle) state.idleSince = null;
    else if (state.idleSince === null || event.type === 'placement.decision') {
      state.idleSince = event.t;
    }
  }
  return state.longest;
}

/** Later tasks started ahead of each task (placements whose `skipped` names it). */
function overtakes(run: RaceRun): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of eventsOf(run.events, 'placement.decision')) {
    const skipped = event['skipped'];
    if (!Array.isArray(skipped)) continue;
    for (const id of skipped) counts.set(String(id), (counts.get(String(id)) ?? 0) + 1);
  }
  return counts;
}

/**
 * `cf-demo-sonnet-30-s7`: 30 agents on 40 tasks, where the old age bound (`2 × agents` = 60
 * starts) could never fire and agents waited for landings while beans stayed unstarted (t039
 * started at 33 minutes). Chains of hot-file appends collide when pipelined.
 */
const THIRTY_ON_FORTY: ChainShape = { chains: [9, 6, 5, 4, 3, 3, 2], total: 40, seed: 7 };

describe('dependency-aware starts with more agents than independent work', () => {
  const run = runRace(chainScenario({ ...DEPENDENCY, agents: 30 }, THIRTY_ON_FORTY));

  it('keeps the age bound reachable at any agent count', () => {
    expect(ageBound(30, 40)).toBe(10);
    expect(ageBound(12, 40)).toBe(6);
    for (const agents of [1, 4, 12, 30, 64]) {
      for (const tasks of [4, 40, 200]) expect(ageBound(agents, tasks)).toBeLessThan(tasks);
    }
  });

  it('never leaves a free agent waiting longer than the stall bound beside unstarted work', () => {
    expect(wellFormedProblems(run.events)).toEqual([]);
    expect(chainNumbers(run)).toMatchObject({ green: 40, dropped: 0 });
    expect(eventsOf(run.events, 'placement.decision', { rule: 'stalled' }).length).toBeGreaterThan(
      0,
    );
    expect(longestIdleWait(run, 30)).toBeLessThanOrEqual(STALL_SECONDS + 1);
  });

  it('bounds every task’s wait: overtaken at most the age bound unless a clash is in flight', () => {
    const bound = ageBound(30, 40);
    const placements = eventsOf(run.events, 'placement.decision');
    for (const [id, count] of overtakes(run)) {
      if (count <= bound) continue;
      // Overtaken beyond the bound only while a bean it clashes with was in flight.
      const own = placements.find((event) => event['task'] === id);
      expect(own?.['overlap']).not.toEqual([]);
    }
    const lastStart = Math.max(...eventsOf(run.events, 'task.start').map((event) => event.t));
    // Before the fix the last bean started at 20.8 minutes (17.3 with the stall bound).
    expect(lastStart / 60).toBeLessThan(19);
  });
});

/** t002 and t001 are fine alone; together they fail a module test that reads both. */
const MODULE_CLASH: FailRule = {
  markers: ['impl:t001', 'impl:t002'],
  file: 'src/shared/both.test.ts',
  name: 'both features together',
  reads: ['src/t001/index.ts', 'src/t002/index.ts'],
};

/**
 * F's gap: dependency starts put a bean after its declared partner, so the partner is already
 * in the bean's base when they clash, in a test neither owns. One agent, bound to its bean.
 */
function partnerInBase(config: Partial<RunConfigInput>): RaceScenario {
  return {
    tasks: [soloTask('t001'), soloTask('t002', { coupledWith: ['t001'] })],
    rules: [MODULE_CLASH],
    config: {
      policy: 'beanstalk-v2',
      agents: 1,
      ci_seconds: 60,
      release_on_check: false,
      ...DEPENDENCY,
      ...config,
    },
  };
}

function t002Culprits(run: RaceRun): unknown[] {
  return eventsOf(run.events, 'rework.start', { task: 't002', reason: 'preland-red' }).map(
    (event) => event['culprits'],
  );
}

describe('a declared partner already in the bean’s base (F’s culprit gap)', () => {
  it('v2.4 names no culprit: the partner landed before the bean’s base', () => {
    const run = runRace(partnerInBase(V25_RULES_OFF));

    expect(run.state.tasks['t002']?.baseSha).toBe(
      eventsOf(run.events, 'land', { task: 't001' })[0]?.['sha'],
    );
    expect(t002Culprits(run)[0]).toEqual([]);
  });

  it('base culprits name it by the failing test’s read set', () => {
    const run = runRace(partnerInBase({ ...V25_RULES_OFF, base_culprits: true }));

    expect(t002Culprits(run)[0]).toEqual(['t001']);
  });

  it('v2.5 raises the pair’s start card first, and any later red still names the partner', () => {
    const run = runRace(partnerInBase({}));

    expect(eventsOf(run.events, 'decision.request')[0]).toMatchObject({
      task: 't002',
      against: ['t001'],
      trigger: 'start',
    });
    for (const culprits of t002Culprits(run)) expect(culprits).toEqual(['t001']);
  });
});

describe('the stall bound counts a carded bean from its start card', () => {
  /** t003 shares one module with each of t002, t004 and t005 (none a hub). */
  const ids = ['t001', 't002', 't003', 't004', 't005', 't006'];
  const shared: Readonly<Record<string, readonly string[]>> = {
    t002: ['src/a'],
    t003: ['src/a', 'src/b', 'src/c'],
    t004: ['src/b'],
    t005: ['src/c'],
  };
  const footprints = Object.fromEntries(
    ids.map((id) => [
      id,
      { method: 'oracle', selected: [`src/${id}`, ...(shared[id] ?? [])], probs: {} },
    ]),
  );
  const run = runRace({
    tasks: ids.map((id) => soloTask(id)),
    config: { policy: 'beanstalk-v2', ci_seconds: 60, footprints, ...DEPENDENCY },
  });
  const t003 = TaskId.parse('t003');
  const CARD_OPENED = 600;

  /**
   * The race's end state, rewound: t004 and t005 started at 100 s and are in flight, t002 took
   * a slot and waits for its start card (opened at 600 s; no `startedAt` until the card's
   * initial run), and t003, which clashes with all three, is unstarted.
   */
  function choiceAt(now: number): ReturnType<typeof chooseStart> {
    const state = structuredClone(run.state);
    const policy = state.policy;
    if (policy?.kind !== 'beanstalk-v2') throw new Error('not a beanstalk-v2 run');
    state.clock = 0;
    const rewind = (id: string, fields: Record<string, unknown>): void => {
      const task = state.tasks[id];
      if (task === undefined) throw new Error(`no ${id}`);
      Object.assign(task, { landedSha: null, greenAt: null, ...fields });
    };
    rewind('t002', { status: 'running', startedAt: null });
    rewind('t003', { status: 'pending', startedAt: null });
    rewind('t004', { status: 'running', startedAt: 100 });
    rewind('t005', { status: 'running', startedAt: 100 });
    policy.cards['D001'] = {
      id: 'D001',
      task: TaskId.parse('t002'),
      against: [TaskId.parse('t001')],
      specs: {},
      openedAt: CARD_OPENED,
      status: 'open',
      timerId: null,
      red: { head: policy.sprout, failing: [], output: '' },
      winner: null,
      loser: null,
      outcome: null,
      text: null,
      by: null,
      snapshot: null,
      winnerContext: null,
      amendment: null,
      trigger: 'start',
    };
    const ctx = createContext(state, state.createdAtMs + now * 1000, run.env);
    return chooseStart(ctx, [t003], 'dependency');
  }

  it('waits until the card has been open for the stall bound', () => {
    // Before the fix the carded bean counted as started now: the wait never ended.
    expect(choiceAt(CARD_OPENED + 60)).toEqual({
      kind: 'wait',
      wakeAt: CARD_OPENED + STALL_SECONDS,
    });
  });

  it('then starts the clashing bean anyway, though the card is still open', () => {
    expect(choiceAt(CARD_OPENED + STALL_SECONDS + 1)).toMatchObject({
      kind: 'start',
      task: 't003',
      rule: 'stalled',
    });
  });
});

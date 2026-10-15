/**
 * The continuous engine's driver: where a race has Python driver slots running agents, a
 * repository engine has pushes. It holds an internal long poll on every free slot, answers a
 * bean's initial invocation at once with the pushed commit, and keeps a rework invocation open
 * until the bean's author pushes again (that push is its result). It folds the engine's events
 * into the pushed beans (`push-events.ts`) for the waiting pushes and the status refs.
 *
 * It runs inside the engine's Durable Object, synchronously around `step`: every engine input
 * goes through the host's `apply`, and replies to the internal polls are answered after the
 * step that produced them (never inside it).
 */
import { InvocationResult } from '@gitstalk/shared-race/driver';
import type { TaskId } from '@gitstalk/shared-race/ids';
import { InvocationId, Sha, SlotId } from '@gitstalk/shared-race/ids';
import type { RunConfig } from '@gitstalk/shared-race/run-config';
import type { ArenaTask } from '@gitstalk/shared-race/task';

import type {
  EmittedEvent,
  EngineInput,
  EngineInstruction,
  EngineReply,
  EngineResponse,
} from '../engine/model';
import type { EngineState } from '../engine/state';
import type { Logger } from '../log';
import { pushedBeanRef } from './bean-refs';
import type { CheckHold, PushBean, PushProgress } from './push-bean';
import {
  progressOf,
  pushRefusal,
  readPushBean,
  receivedBean,
  savePushBean,
  withPhase,
} from './push-bean';
import { foldEvents } from './push-events';
import type { PushIntent } from './push-intent';
import type { ProtectedAccess } from '../checks/protected-access';
import type { BeanRef, ReworkFacts } from './push-messages';
import { conflictLines, heldLines, heldWhy, redLines } from './push-messages';

const INTERNAL_POLL = 'push:';
/** Poll rounds per drain: a slot that keeps being answered `wait` is not polled forever. */
const MAX_DRAIN_ROUNDS = 200;
/** Lines of a rework prompt shown for a rework the flow has no verdict text for. */
const GENERIC_PROMPT_LINES = 15;

/** What the driver needs from the engine's Durable Object. */
export type PushHost = {
  readonly sql: SqlStorage;
  readonly log: Logger;
  apply(input: EngineInput): EngineResponse;
  state(): EngineState;
  config(): RunConfig;
  /** Persists a changed configuration (a pushed bean's definition) and rebuilds the engine env. */
  setConfig(config: RunConfig): void;
  link(bean: string): string | null;
  /** The lines the check of a tree gave (which checks ran, or why none did). */
  checkLines(sha: string): readonly string[];
  /** Publishes the bean's status ref in the background (when its phase or head changed). */
  publish(bean: PushBean): void;
};

/** What the push is told it submitted. */
export type Received = {
  readonly bean: string;
  readonly sha: string;
  readonly title: string;
  readonly isNew: boolean;
  readonly task: string | null;
};

export type Submitted =
  | { readonly ok: true; readonly push: number; readonly received: Received }
  | { readonly ok: false; readonly reason: string };

export class PushDriver {
  readonly #host: PushHost;
  readonly #replies: { slot: SlotId; reply: EngineReply }[] = [];
  #polls = 0;
  #draining = false;

  constructor(host: PushHost) {
    this.#host = host;
  }

  /** Whether a poll id is one of the driver's own (its reply comes back to `take`). */
  static isInternalPoll(pollId: string): boolean {
    return pollId.startsWith(INTERNAL_POLL);
  }

  /** A reply to an internal poll, answered after the current step (`drain`). */
  take(pollId: string, reply: EngineReply): void {
    const slot = SlotId.safeParse(pollId.slice(INTERNAL_POLL.length).split(':')[0]);
    if (slot.success) this.#replies.push({ slot: slot.data, reply });
  }

  /** Answers queued replies and polls free slots until nothing changes. Not re-entrant. */
  drain(): void {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
        const next = this.#replies.shift();
        if (next !== undefined) this.#answer(next.slot, next.reply);
        else if (!this.#pollFreeSlots()) return;
      }
      this.#host.log.warn('push driver: drain stopped after its round limit');
    } finally {
      this.#draining = false;
    }
  }

  /** Folds a step's events into the pushed beans they concern. */
  onEvents(events: readonly EmittedEvent[]): void {
    const beans = new Map<string, PushBean>();
    for (const event of events) {
      const task = 'task' in event && typeof event.task === 'string' ? event.task : null;
      const tasks = 'tasks' in event && Array.isArray(event.tasks) ? event.tasks : [];
      for (const id of [task, ...tasks]) {
        if (typeof id !== 'string' || beans.has(id)) continue;
        const bean = readPushBean(this.#host.sql, id);
        if (bean !== null) beans.set(id, bean);
      }
    }
    if (beans.size === 0) return;
    const context = {
      link: (bean: string) => this.#host.link(bean),
      checkLines: (sha: string) => this.#host.checkLines(sha),
    };
    for (const id of foldEvents(events, beans, context)) {
      const bean = beans.get(id);
      if (bean !== undefined) this.#save(bean);
    }
  }

  /** Why a push to `bean` must be refused now, or null when it may go ahead. */
  refusal(bean: TaskId): string | null {
    const phase = this.#host.state().phase;
    if (phase !== 'running') return `the repository engine is ${phase}`;
    return pushRefusal(readPushBean(this.#host.sql, bean));
  }

  /** A push of `bean` at `head` landed upstream: the bean is created or its rework answered. */
  submit(input: {
    bean: TaskId;
    head: Sha;
    intent: PushIntent;
    actor: string;
    protectedAccess: ProtectedAccess;
    /** The head's ancestors, newest first (to find where it forked the sprout). */
    history: readonly string[];
    /** The files the push changes since it forked the sprout. */
    files: readonly string[];
  }): Submitted {
    const refusal = this.refusal(input.bean);
    if (refusal !== null) return { ok: false, reason: refusal };
    const previous = readPushBean(this.#host.sql, input.bean);
    const bean = receivedBean({ ...input, ...input.intent, previous });
    if (previous === null) {
      const admitted = this.#admit(bean, this.forkPoint(input.history));
      if (admitted !== null) return { ok: false, reason: admitted };
    } else {
      this.#save(bean);
      const answered = this.#answerRework(previous, bean);
      if (answered !== null) return { ok: false, reason: answered };
    }
    this.drain();
    const received = {
      bean: bean.bean,
      sha: input.head,
      title: bean.title,
      isNew: previous === null,
      task: bean.task,
    };
    return { ok: true, push: bean.pushes, received };
  }

  /** What a push waiting on `bean` sees after line `after`. */
  progress(bean: string, push: number, after: number): PushProgress | null {
    const stored = readPushBean(this.#host.sql, bean);
    return stored === null ? null : progressOf(stored, push, after);
  }

  /** The newest of the head's ancestors that is on the sprout line (null: none known). */
  forkPoint(history: readonly string[]): Sha | null {
    const policy = this.#host.state().policy;
    if (policy === null || !('shaIdx' in policy)) return null;
    const onLine = new Set(Object.keys(policy.shaIdx));
    const base = this.#host.state().baseSha;
    if (base !== null) onLine.add(base);
    const found = history.find((sha) => onLine.has(sha));
    return found === undefined ? null : Sha.parse(found);
  }

  #admit(bean: PushBean, base: Sha | null): string | null {
    const config = this.#host.config();
    if (config.tasks.some((task) => task.id === bean.bean)) return `bean ${bean.bean} exists`;
    this.#host.setConfig({ ...config, tasks: [...config.tasks, beanDefinition(bean)] });
    this.#save(bean);
    const response = this.#host.apply({ kind: 'admit', at: Date.now(), task: bean.bean, base });
    return response.kind === 'refused' ? response.refusal.message : null;
  }

  /** The bean's waiting rework gets the new push as its result. */
  #answerRework(previous: PushBean, pushed: PushBean): string | null {
    const awaiting = previous.awaiting;
    if (awaiting === null) return `bean ${previous.bean} is not waiting for a push`;
    const inv = InvocationId.safeParse(awaiting.inv);
    if (!inv.success) return `bean ${previous.bean} waits on an unknown invocation`;
    const slot = SlotId.safeParse(awaiting.slot);
    if (!slot.success) return `bean ${previous.bean} waits on an unknown slot`;
    const response = this.#host.apply({
      kind: 'result',
      at: Date.now(),
      slot: slot.data,
      inv: inv.data,
      result: pushResult(pushed),
    });
    return response.kind === 'refused' ? response.refusal.message : null;
  }

  /** An internal poll's reply: answer an initial at once, hold a rework for the next push. */
  #answer(slot: SlotId, reply: EngineReply): void {
    if (!('invocation' in reply)) return;
    const invocation = reply.invocation;
    const bean = readPushBean(this.#host.sql, invocation.task);
    switch (invocation.kind) {
      case 'initial':
        this.#answerInitial(invocation, bean);
        return;
      case 'rework':
      case 'sync':
      case 'fixer':
        if (bean !== null) this.#hold(bean, invocation, slot);
        return;
      case 'test-author':
      case 'reconcile':
      case 'test-first':
        // Pushed beans carry no acceptance tests for an author to write or amend.
        this.#apply(invocation, {
          ...noCommit(),
          result_text: 'no tests to author',
        });
        return;
      default:
        return;
    }
  }

  #answerInitial(invocation: EngineInstruction, bean: PushBean | null): void {
    if (bean === null) {
      this.#apply(invocation, {
        ...noCommit(),
        ok: false,
        infra_error: 'no pushed commit',
      });
      return;
    }
    this.#apply(invocation, pushResult(bean));
  }

  /**
   * A red, a conflict or a hold of the approval rules: the rework waits for the author (or, for
   * a hold, for a person's approval, which re-submits the same head); its verdict is the push's
   * answer.
   */
  #hold(bean: PushBean, invocation: EngineInstruction, slot: SlotId): void {
    const context = { bean: bean.bean, link: this.#host.link(bean.bean) };
    const waiting = {
      ...bean,
      awaiting: { inv: invocation.inv, slot, kind: invocation.kind, prompt: invocation.prompt },
    };
    const verdict =
      bean.held === null
        ? reworkVerdict({ context, facts: this.#facts(bean), prompt: invocation.prompt })
        : heldVerdict(context, bean.held);
    this.#save(withPhase(waiting, verdict));
  }

  #facts(bean: PushBean): ReworkFacts {
    const rework = bean.rework ?? { reason: 'rework', failing: [], culprits: [], conflicts: [] };
    return { ...rework, culprits: rework.culprits.map((id) => this.#beanRef(id)) };
  }

  #beanRef(id: string): BeanRef {
    const task = this.#host.config().tasks.find((candidate) => candidate.id === id);
    return { bean: id, title: task?.title ?? id, intent: task?.prompt ?? '' };
  }

  #apply(invocation: EngineInstruction, result: InvocationResult): void {
    const response = this.#host.apply({
      kind: 'result',
      at: Date.now(),
      slot: invocation.slot,
      inv: invocation.inv,
      result,
    });
    if (response.kind === 'refused')
      this.#host.log.warn('push driver: result refused', {
        inv: invocation.inv,
        ...response.refusal,
      });
  }

  /** Polls every slot that is neither polling nor running; true if any poll was made. */
  #pollFreeSlots(): boolean {
    const state = this.#host.state();
    if (state.phase !== 'running') return false;
    const free = state.slots.filter((slot) => slot.pollId === null && slot.running === null);
    for (const slot of free) {
      this.#polls += 1;
      const pollId = `${INTERNAL_POLL}${slot.id}:${this.#polls}`;
      const response = this.#host.apply({ kind: 'poll', at: Date.now(), slot: slot.id, pollId });
      if (response.kind === 'poll' && response.reply !== null) this.take(pollId, response.reply);
    }
    return free.length > 0 && this.#replies.length > 0;
  }

  #save(bean: PushBean): void {
    savePushBean(this.#host.sql, bean);
    this.#host.publish(bean);
  }
}

/** The engine task of a pushed bean: its intent is the prompt; it has no acceptance tests. */
function beanDefinition(bean: PushBean): ArenaTask {
  return {
    id: bean.bean,
    title: bean.title,
    prompt: bean.intent,
    acceptance_tests: {},
    oracle_paths: [],
    oracle_modules: [],
    kind: bean.task === null ? 'push' : `push:${bean.task}`,
    difficulty: 1,
    couplings: [],
  };
}

/** An invocation's result as a push gives it: the pushed commit and its files, at no agent cost. */
function pushResult(bean: PushBean): InvocationResult {
  return InvocationResult.parse({
    ok: true,
    subtype: 'success',
    cost_source: 'push',
    pushed_ref: pushedBeanRef(bean.bean),
    head_sha: bean.head,
    new_commit: true,
    files: bean.files,
  });
}

/** An invocation's result when there is no pushed commit to give. */
function noCommit(): InvocationResult {
  return InvocationResult.parse({
    ok: false,
    subtype: 'no-commit',
    cost_source: 'push',
    pushed_ref: null,
    head_sha: null,
    new_commit: false,
  });
}

type Verdict = {
  readonly phase: 'red' | 'conflict';
  readonly reason: string;
  readonly lines: readonly string[];
};

/** A red or a conflict the author fixes. */
function reworkVerdict(input: {
  context: { bean: string; link: string | null };
  facts: ReworkFacts;
  prompt: string;
}): Verdict {
  const { facts } = input;
  const isConflict = facts.reason === 'conflict';
  return {
    phase: isConflict ? 'conflict' : 'red',
    reason: isConflict
      ? `conflicts with the sprout in ${facts.conflicts.join(', ')}`
      : `${facts.failing.length} failing test(s) on the merged tree`,
    lines: verdictLines(input),
  };
}

/** A hold: red to git (the push's wait ends), but nothing for the author to fix. */
function heldVerdict(context: { bean: string; link: string | null }, held: CheckHold): Verdict {
  const why = heldWhy(held);
  return {
    phase: 'red',
    reason: `held for a person's approval (${why})`,
    lines: heldLines(context, why),
  };
}

function verdictLines(input: {
  context: { bean: string; link: string | null };
  facts: ReworkFacts;
  prompt: string;
}): string[] {
  const { context, facts, prompt } = input;
  if (facts.reason === 'conflict') return conflictLines(context, facts, prompt);
  if (facts.reason === 'preland-red') return redLines(context, facts, prompt);
  return genericLines(context.bean, facts.reason, prompt);
}

function genericLines(bean: string, reason: string, prompt: string): string[] {
  const lines = prompt
    .replaceAll('trunk', 'sprout')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(0, GENERIC_PROMPT_LINES);
  return [
    `gitstalk: REWORK (${reason}): ${bean} was not landed:`,
    ...lines.map((line) => `gitstalk:   ${line}`),
  ];
}

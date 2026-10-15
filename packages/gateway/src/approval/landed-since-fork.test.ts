import { describe, expect, it } from 'vitest';

import { Sha, TaskId } from '@gitstalk/shared-race/ids';

import type { TaskState } from '../engine/model';
import { newTaskState } from '../engine/tasks';

import { inFlightBefore, intentCheckedBeans, withIntents } from './landed-since-fork';

describe('intentCheckedBeans', () => {
  it('reads every Intent-checked trailer, comma or space separated, without bean/ prefixes', () => {
    const message = [
      'Add $5 shipping in dollars',
      '',
      'Intent-checked: price-dollars, bean/tax',
      'intent-checked: rounding',
    ].join('\n');
    expect([...intentCheckedBeans(message)]).toEqual(['price-dollars', 'tax', 'rounding']);
  });

  it('names nothing without a message or a trailer', () => {
    expect(intentCheckedBeans(null).size).toBe(0);
    expect(intentCheckedBeans('Intent checked price-dollars by eye').size).toBe(0);
  });
});

describe('withIntents', () => {
  it('adds each landed bean’s intent and the files both beans changed', () => {
    const landed = [
      {
        bean: 'price-dollars',
        files: ['src/price.mjs', 'src/checkout.mjs'],
        sha: Sha.parse('d'.repeat(40)),
        parent: Sha.parse('a'.repeat(40)),
        state: 'landed' as const,
      },
    ];
    const intents = withIntents(landed, {
      files: ['src/checkout.mjs'],
      intent: (bean) => (bean === 'price-dollars' ? 'Price in dollars, not cents' : null),
    });
    expect(intents).toEqual([
      { ...landed[0], intent: 'Price in dollars, not cents', sharedFiles: ['src/checkout.mjs'] },
    ]);
  });
});

describe('inFlightBefore', () => {
  const FORK = Sha.parse('a'.repeat(40));
  const task = (id: string, update: Partial<TaskState>): TaskState => ({
    ...newTaskState(TaskId.parse(id), []),
    baseSha: FORK,
    ...update,
  });
  const files = (bean: string) => [`src/${bean}.mjs`];

  it('lists beans pushed earlier that are still being checked, oldest first', () => {
    const tasks = {
      shipping: task('shipping', {
        status: 'testing',
        startedAt: 10,
        headSha: Sha.parse('b'.repeat(40)),
      }),
      tax: task('tax', { status: 'queued', startedAt: 5, headSha: Sha.parse('c'.repeat(40)) }),
      price: task('price', {
        status: 'testing',
        startedAt: 20,
        headSha: Sha.parse('d'.repeat(40)),
      }),
    };
    expect(inFlightBefore(tasks, 'price', files)).toEqual([
      {
        bean: 'tax',
        files: ['src/tax.mjs'],
        sha: 'c'.repeat(40),
        parent: FORK,
        state: 'in-flight',
      },
      {
        bean: 'shipping',
        files: ['src/shipping.mjs'],
        sha: 'b'.repeat(40),
        parent: FORK,
        state: 'in-flight',
      },
    ]);
  });

  it('leaves out later pushes, landed beans and beans sent back to their author', () => {
    const head = Sha.parse('b'.repeat(40));
    const tasks = {
      later: task('later', { status: 'testing', startedAt: 30, headSha: head }),
      landed: task('landed', { status: 'landed', startedAt: 1, headSha: head, landedSha: head }),
      reworking: task('reworking', { status: 'rework', startedAt: 2, headSha: head }),
      price: task('price', { status: 'testing', startedAt: 20, headSha: head }),
    };
    expect(inFlightBefore(tasks, 'price', files)).toEqual([]);
  });

  it('breaks a tie in start time by name, so of two beans exactly one is first', () => {
    const head = Sha.parse('b'.repeat(40));
    const tasks = {
      alpha: task('alpha', { status: 'testing', startedAt: 7, headSha: head }),
      beta: task('beta', { status: 'testing', startedAt: 7, headSha: head }),
    };
    expect(inFlightBefore(tasks, 'beta', files).map((bean) => bean.bean)).toEqual(['alpha']);
    expect(inFlightBefore(tasks, 'alpha', files)).toEqual([]);
  });
});

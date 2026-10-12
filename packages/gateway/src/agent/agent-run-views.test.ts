import { describe, expect, it } from 'vitest';

import { LogTail, findWorkflow, triggerText } from './agent-run-views';

const steps = new Map([
  [1, 'Build'],
  [2, 'Deploy'],
]);

function lines(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    step: index % 2 === 0 ? 1 : 2,
    at: '2026-10-12T00:00:00Z',
    text: `line ${index}`,
  }));
}

describe('LogTail', () => {
  it('keeps the newest lines within tail and bytes, and says what it left out', () => {
    const tail = new LogTail({ tail: 3, grep: undefined, steps });
    tail.add(lines(10));
    expect(tail.result(10_000)).toEqual({
      total: 10,
      matched: 10,
      shown: 3,
      truncated: true,
      text: '[Deploy] line 7\n[Build] line 8\n[Deploy] line 9',
    });
    expect(tail.result(20).text).toBe('[Deploy] line 9');
  });

  it('filters by text, case-insensitively, and counts matches', () => {
    const tail = new LogTail({ tail: 10, grep: 'DEPLOY] LINE 1', steps });
    tail.add(lines(20));
    expect(tail.result(10_000)).toMatchObject({
      total: 20,
      matched: 6,
      shown: 6,
      truncated: false,
    });
  });

  it('holds a bounded number of lines however long the log is', () => {
    const tail = new LogTail({ tail: 2, grep: undefined, steps: new Map() });
    for (let batch = 0; batch < 100; batch += 1) tail.add(lines(50));
    expect(tail.result(10_000)).toMatchObject({ total: 5000, shown: 2 });
  });
});

describe('findWorkflow', () => {
  const workflows = [
    { path: '.github/workflows/ci.yml', name: 'CI' },
    { path: '.gitstalk/automations/fix-red.yml', name: 'Fix reds' },
  ];

  it('finds a workflow by path, file name, id or name', () => {
    expect(findWorkflow(workflows, '.github/workflows/ci.yml')?.name).toBe('CI');
    expect(findWorkflow(workflows, 'ci.yml')?.name).toBe('CI');
    expect(findWorkflow(workflows, 'ci')?.name).toBe('CI');
    expect(findWorkflow(workflows, 'fix reds')?.name).toBe('Fix reds');
    expect(findWorkflow(workflows, 'deploy')).toBeUndefined();
  });
});

describe('triggerText', () => {
  it('reads triggers as an agent would write them', () => {
    expect(
      triggerText({
        kind: 'push',
        branches: ['main'],
        branchesIgnore: [],
        paths: [],
        pathsIgnore: [],
      }),
    ).toBe('push (main)');
    expect(triggerText({ kind: 'schedule', crons: ['0 6 * * *'] })).toBe('schedule (0 6 * * *)');
  });
});

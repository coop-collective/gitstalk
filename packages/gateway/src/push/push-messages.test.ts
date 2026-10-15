import { describe, expect, it } from 'vitest';

import { heldLines, heldWhy, promptOutput, redLines, withoutRemotePrefix } from './push-messages';

describe('verdict output', () => {
  it('keeps the telling lines of the suite output and drops stack frames', () => {
    const prompt = [
      'Output:',
      '```',
      'not ok 1 - a 10% discount on 100 is 90',
      '    at TestContext.<anonymous> (/work/test/discount.test.js:4:50)',
      '  {',
      "  code: 'ERR_ASSERTION',",
      '  actual: 99,',
      '  }',
      '```',
    ].join('\n');
    expect(promptOutput(prompt)).toEqual([
      'not ok 1 - a 10% discount on 100 is 90',
      "  code: 'ERR_ASSERTION',",
      '  actual: 99,',
    ]);
  });
});

describe('a guard red', () => {
  const guardPrompt = [
    'Output:',
    '```',
    ...Array.from({ length: 20 }, (_, n) => `guard line ${n + 1}`),
    '```',
  ].join('\n');

  it('keeps its output from the top, where a suite keeps the end', () => {
    expect(promptOutput(guardPrompt, 'guard')[0]).toBe('guard line 1');
    expect(promptOutput(guardPrompt, 'guard')).toHaveLength(20);
    expect(promptOutput(guardPrompt)).toHaveLength(12);
    expect(promptOutput(guardPrompt)[0]).toBe('guard line 9');
  });

  it('is told by its failing "test" in the configuration directory', () => {
    const facts = {
      reason: 'preland-red',
      failing: ['.gitstalk/policy.yml > recheck against beans that landed after it forked'],
      culprits: [],
      conflicts: [],
    };
    const lines = redLines({ bean: 'shipping', link: null }, facts, guardPrompt);
    expect(lines.join('\n')).toContain('guard line 1');
    const suite = redLines(
      { bean: 'shipping', link: null },
      { ...facts, failing: ['test/a.test.mjs > a'] },
      guardPrompt,
    );
    expect(suite.join('\n')).not.toContain('guard line 1\n');
  });
});

describe('stored remote lines', () => {
  it('drops the prefix, also the one verdicts stored before the rename carry', () => {
    expect(withoutRemotePrefix('gitstalk: LANDED: a')).toBe('LANDED: a');
    expect(withoutRemotePrefix('beanstalk: LANDED: a')).toBe('LANDED: a');
    expect(withoutRemotePrefix('gitstalk:   indented')).toBe('  indented');
    expect(withoutRemotePrefix('plain')).toBe('plain');
  });
});

describe('a hold of the approval rules', () => {
  it('tells the push it waits for a person, and never to fix anything', () => {
    const why = heldWhy({ classes: ['auth', 'docs-only'], class: 'auth', by: 'clef' });
    expect(why).toBe('class auth, decided by clef');
    const lines = heldLines(
      { bean: 'login', link: 'https://gitstalk.dev/coop/app/changes/login' },
      why,
    );
    expect(lines[0]).toBe(
      "gitstalk: HELD: login waits for a person's approval (class auth, decided by clef); nothing in it needs fixing",
    );
    expect(lines.at(-1)).toBe('gitstalk:   web: https://gitstalk.dev/coop/app/changes/login');
    expect(lines.join('\n')).not.toMatch(/RED|fix:|sent back/iu);
  });

  it('names the classes when no class rule decided', () => {
    expect(heldWhy({ classes: ['infra'], class: null, by: 'rules' })).toBe(
      'classes infra, decided by rules',
    );
  });
});

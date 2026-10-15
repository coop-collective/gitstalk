import { describe, expect, it } from 'vitest';

import type { WatchedBean } from './bean-wait';
import { needsPush } from './bean-wait';
import { arrivedLines, settledLines, waitEndLines, waitHeaderLines } from './wait-messages';

const HELD_VERDICT = [
  "gitstalk: HELD: price-in-dollars waits for a person's approval (class code, decided by clef); nothing in it needs fixing",
];

function bean(name: string, fields: Partial<WatchedBean> = {}): WatchedBean {
  return {
    bean: name,
    phase: 'checking',
    pushes: 1,
    verdict: null,
    verdictPhase: null,
    held: false,
    nextNote: 1,
    ...fields,
  };
}

const held = bean('price-in-dollars', {
  phase: 'red',
  held: true,
  verdict: HELD_VERDICT,
  verdictPhase: 'red',
});
const red = bean('total', { phase: 'red', verdict: ['gitstalk: RED: total was not landed'] });

describe('a wait on a bean the approval rules hold', () => {
  it('calls it held, never red, and asks for no push', () => {
    const lines = [
      ...waitHeaderLines('any', [held], []),
      ...settledLines(held),
      ...waitEndLines('any', [held], null),
    ].join('\n');
    expect(lines).toContain('waiting for the first verdict of price-in-dollars (held)');
    expect(lines).toContain("price-in-dollars is held for a person's approval:");
    expect(lines).toContain('your beans: price-in-dollars (held)');
    expect(lines).toContain(
      'next: ask your person to approve price-in-dollars on its page; do not push it again',
    );
    expect(lines).not.toMatch(/\(red\)|waits for your push|next: fix|push -f/u);
  });

  it('names a hold that arrives during the wait as held', () => {
    expect(arrivedLines(held)[0]).toBe('gitstalk: verdict for price-in-dollars: held');
  });

  it('asks for a fix of a red bean only, beside a held one', () => {
    const end = waitEndLines('all', [held, red], null).join('\n');
    expect(end).toContain('your beans: price-in-dollars (held), total (red)');
    expect(end).toContain('next: fix total (rebase');
    expect(end).not.toContain('fix price-in-dollars');
    expect(settledLines(red)[0]).toBe('gitstalk: total is red and waits for your push:');
  });

  it('does not count a held bean as needing its author', () => {
    expect(needsPush(held)).toBe(false);
    expect(needsPush(red)).toBe(true);
    expect(needsPush(bean('in-check'))).toBe(false);
  });
});

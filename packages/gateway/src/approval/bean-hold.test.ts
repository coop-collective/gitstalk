import { describe, expect, it } from 'vitest';

import type { RouteReceipt } from '@gitstalk/shared-race/approval-policy';

import type { Approval } from './approval-store';
import { holdOf } from './bean-hold';

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);

const CARD: RouteReceipt = {
  bean: 'login',
  classes: ['protected'],
  route: 'card',
  class: 'protected',
  by: 'clef',
  probability: 0.81,
  principal: '@erin',
  reviewers: ['@dana'],
  refused: null,
  approval: { state: 'awaiting', actor: null },
  policy: { path: '.gitstalk/policy.yml', sha: 'c'.repeat(40), valid: true },
  revision: HEAD,
  at: 1,
};

const APPROVAL: Approval = {
  actor: 'dana',
  atMs: Date.UTC(2026, 9, 14, 12),
  note: 'fine',
  client: 'MCP (Claude Code)',
  idempotencyKey: null,
};

describe('a bean’s hold', () => {
  it('is held while the card judged its head and nobody approved it', () => {
    const hold = holdOf({ receipt: CARD, approval: null, pushed: { head: HEAD, phase: 'red' } });
    expect(hold).toEqual({
      state: 'held',
      revision: HEAD,
      classes: ['protected'],
      class: 'protected',
      by: 'clef',
      probability: 0.81,
      reviewers: ['@dana'],
      policy: { path: '.gitstalk/policy.yml', sha: 'c'.repeat(40) },
      approval: null,
    });
  });

  it('is approved once a person approved its head', () => {
    const hold = holdOf({
      receipt: CARD,
      approval: APPROVAL,
      pushed: { head: HEAD, phase: 'checking' },
    });
    expect(hold).toMatchObject({
      state: 'approved',
      approval: {
        by: 'dana',
        at: '2026-10-14T12:00:00.000Z',
        note: 'fine',
        client: 'MCP (Claude Code)',
      },
    });
  });

  it('is cleared by a new push until that push is judged', () => {
    expect(
      holdOf({ receipt: CARD, approval: null, pushed: { head: NEXT, phase: 'checking' } }),
    ).toBeNull();
  });

  it('is none for other routes, refusals and beans that are gone', () => {
    const pushed = { head: HEAD, phase: 'red' } as const;
    expect(holdOf({ receipt: { ...CARD, route: 'auto' }, approval: null, pushed })).toBeNull();
    expect(holdOf({ receipt: { ...CARD, refused: 'no' }, approval: null, pushed })).toBeNull();
    expect(holdOf({ receipt: null, approval: null, pushed })).toBeNull();
    expect(
      holdOf({ receipt: CARD, approval: null, pushed: { head: HEAD, phase: 'dropped' } }),
    ).toBeNull();
  });
});

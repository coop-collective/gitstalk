import { describe, expect, it } from 'vitest';

import type { SelfApprovalInput } from './self-approval';
import { selfApprovalRefusal } from './self-approval';

const CLAUDE = { kind: 'mcp', name: 'Claude Code', session: 'oauth:claude-code' } as const;

function input(
  pusher: string | null,
  overrides: Partial<SelfApprovalInput> = {},
): SelfApprovalInput {
  return {
    bean: 'login',
    client: CLAUDE,
    approver: 'dana',
    pushed: { actor: 'dana', pusher },
    ...overrides,
  };
}

describe('the self-approval rule', () => {
  it.each([
    ['the same OAuth client', 'oauth:claude-code'],
    ["the person's SSH key", 'ssh-key:k1'],
    ["the person's personal token", 'personal-token:t1'],
    ['an MCP session of unknown client', 'mcp'],
    ['a credential that was not recorded', null],
  ])('refuses an agent approving its person’s push through %s', (_what, pusher) => {
    expect(selfApprovalRefusal(input(pusher))).toContain('confirm_owner_intent: true');
  });

  it.each([
    ['another OAuth client', 'oauth:codex'],
    ['the web editor', 'web'],
  ])('allows an agent approving its person’s push through %s', (_what, pusher) => {
    expect(selfApprovalRefusal(input(pusher))).toBeNull();
  });

  it("allows someone else's push, whatever pushed it", () => {
    expect(selfApprovalRefusal(input('oauth:claude-code', { approver: 'coop' }))).toBeNull();
  });

  it('allows the person on the web, and an agent whose person confirmed it', () => {
    expect(selfApprovalRefusal(input('oauth:claude-code', { client: { kind: 'web' } }))).toBeNull();
    const confirmed = { ...CLAUDE, confirm_owner_intent: true };
    expect(selfApprovalRefusal(input('oauth:claude-code', { client: confirmed }))).toBeNull();
  });

  it('compares handles without case', () => {
    expect(selfApprovalRefusal(input('ssh-key:k1', { approver: 'Dana' }))).not.toBeNull();
  });
});

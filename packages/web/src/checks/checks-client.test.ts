import { describe, expect, it } from 'vitest';

import { checksClient } from './checks-client';

function binding(answer: unknown) {
  return { convertChecks: () => Promise.resolve(answer) };
}

describe('checksClient', () => {
  it('is null for a gateway without the checks RPC', () => {
    expect(checksClient({}, 'u1')).toBeNull();
    expect(checksClient(null, 'u1')).toBeNull();
  });

  it('passes a pushed bean on, and validates its shape', async () => {
    const pushed = { kind: 'pushed', bean: 'checks-abc123', commit: 'c'.repeat(40) };
    const client = checksClient(binding({ ok: true, value: pushed }), 'u1');
    expect(await client?.convert('r1', { yaml: 'run: [node, --test]\n' })).toEqual({
      ok: true,
      value: pushed,
    });
    const odd = checksClient(binding({ ok: true, value: { kind: 'pushed' } }), 'u1');
    expect(await odd?.convert('r1', { yaml: '' })).toMatchObject({ ok: false, status: 502 });
  });

  it("passes the gateway's refusal on in its words", async () => {
    const error = { code: 'forbidden', status: 403, message: 'Only maintainers and the owner' };
    const client = checksClient(binding({ ok: false, error }), 'u1');
    expect(await client?.convert('r1', { yaml: '' })).toEqual({
      ok: false,
      status: 403,
      message: 'Only maintainers and the owner',
    });
  });

  it('reads a gateway that threw as no answer', async () => {
    const client = checksClient({ convertChecks: () => Promise.reject(new Error('down')) }, 'u1');
    expect(await client?.convert('r1', { yaml: '' })).toEqual({
      ok: false,
      status: 502,
      message: 'The gateway did not answer.',
    });
  });
});

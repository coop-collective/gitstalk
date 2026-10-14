import { describe, expect, it } from 'vitest';

import { rulesClient } from './rules-client';

const SOURCE = {
  path: '.gitstalk/policy.yml',
  base: { commit: 'a'.repeat(40), blob: null },
  content: null,
  role: 'maintain',
  save: { kind: 'allowed' },
};

function binding(answers: Record<string, unknown>) {
  return {
    rulesSource: () => Promise.resolve(answers['rulesSource']),
    saveRules: () => Promise.resolve(answers['saveRules']),
    rulesBean: () => Promise.resolve(answers['rulesBean']),
  };
}

describe('rulesClient', () => {
  it('is null for a gateway without the rules RPC', () => {
    expect(rulesClient({}, 'u1')).toBeNull();
    expect(rulesClient(null, 'u1')).toBeNull();
  });

  it('reads the source and validates its shape', async () => {
    const client = rulesClient(binding({ rulesSource: { ok: true, value: SOURCE } }), 'u1');
    expect(await client?.source('r1')).toEqual({ ok: true, value: SOURCE });
    const odd = rulesClient(binding({ rulesSource: { ok: true, value: { path: 1 } } }), 'u1');
    expect(await odd?.source('r1')).toMatchObject({ ok: false, status: 502 });
  });

  it("passes the gateway's refusal on in its words", async () => {
    const error = { code: 'forbidden', status: 403, message: 'Only maintainers and the owner' };
    const client = rulesClient(binding({ saveRules: { ok: false, error } }), 'u1');
    const saved = await client?.save('r1', {
      base: { commit: 'a'.repeat(40), blob: null },
      content: '',
    });
    expect(saved).toEqual({ ok: false, status: 403, message: 'Only maintainers and the owner' });
  });
});

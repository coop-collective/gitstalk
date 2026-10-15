import { describe, expect, it } from 'vitest';

import { consentChoices, keyApprovalChoices } from './scope-choices';

const GRANTABLE = ['read', 'collaborate', 'write', 'secrets', 'create'];

describe('the scopes a person ticks', () => {
  it('offers create on the consent page, ticked when the agent asked for it', () => {
    const asked = consentChoices(GRANTABLE, ['read', 'write', 'create', 'secrets']);
    expect(asked.map((choice) => [choice.scope, choice.checked])).toEqual([
      ['read', true],
      ['collaborate', false],
      ['write', true],
      ['secrets', false],
      ['create', true],
    ]);
    expect(asked.find((choice) => choice.scope === 'create')?.text).toContain(
      'Create repositories',
    );
    const notAsked = consentChoices(GRANTABLE, ['read', 'collaborate', 'write']);
    expect(notAsked.find((choice) => choice.scope === 'create')).toMatchObject({ checked: false });
  });

  it('offers create on the SSH key approval page, ticked, when setup asked for it', () => {
    expect(keyApprovalChoices({ wantsCreate: true })).toEqual([
      expect.objectContaining({ scope: 'create', checked: true }),
    ]);
    expect(keyApprovalChoices({ wantsCreate: false })).toEqual([]);
  });
});

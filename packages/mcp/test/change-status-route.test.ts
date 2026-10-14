import { describe, expect, it } from 'vitest';

import { TaskId } from '@gitstalk/shared-race/ids';

import { classifierFrom } from '@gitstalk/shared-ask/ask/classifier-from-env';
import { gatewaySource } from '@gitstalk/shared-ask/forge/gateway-source';
import { pickerFrom } from '@gitstalk/shared-ask/pick/picker-from-env';

import { changeStatus } from '../src/tools/change-status';
import { toolContext } from '../src/tools/tool-context';
import { fakeGateway, RUN } from './fake-gateway';

/** t005 of the recorded run, held by a `card` route. */
const RECEIPT = {
  bean: 't005',
  classes: ['auth'],
  route: 'card',
  class: 'auth',
  by: 'clef',
  probability: 0.81,
  principal: 'agent:a3',
  reviewers: ['@security'],
  refused: null,
  approval: { state: 'awaiting', actor: null },
  policy: { path: '.gitstalk/policy.toml', sha: 'c'.repeat(40), valid: true },
  revision: null,
  at: 1,
};

function context(overrides: Record<string, unknown>) {
  const gateway = fakeGateway(overrides);
  return toolContext({
    run: RUN,
    gateway,
    source: gatewaySource(gateway),
    classifier: classifierFrom({ name: 'keywords', model: '', ai: undefined }),
    picker: pickerFrom({ name: 'rules', ai: undefined, gateway: '' }),
    webUrl: 'https://web.test',
  });
}

describe('bean_status and the approval rules', () => {
  it('shows the route receipt and says the bean waits for a person', async () => {
    const answer = await changeStatus(
      context({ beanRoute: () => Promise.resolve({ ok: true, value: RECEIPT }) }),
      TaskId.parse('t005'),
    );
    expect(answer?.route).toMatchObject({ route: 'card', by: 'clef', probability: 0.81 });
    expect(answer?.next).toContain("Held for a person's approval (class auth, clef)");
  });

  it('shows no receipt from a gateway without approval rules', async () => {
    const answer = await changeStatus(context({}), TaskId.parse('t005'));
    expect(answer?.route).toBeNull();
  });
});

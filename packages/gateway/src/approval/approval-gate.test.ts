import { describe, expect, it } from 'vitest';

import type { ModelRunner as AiRunner } from '@gitstalk/shared-ask/pick/decision-model';
import {
  DECISION_MODELS,
  askChoice,
  decisionModelFrom,
} from '@gitstalk/shared-ask/pick/decision-model';

import type { RouteReceipt } from '@gitstalk/shared-race/approval-policy';
import { Sha } from '@gitstalk/shared-race/ids';

import type { LandingTree } from '../checks/check-store';
import type { FileChange } from '../git/diff-text';
import type { ApprovalHost } from './approval-gate';
import { CARD_MIN_PROBABILITY, judgeLanding } from './approval-gate';

const ONTO = Sha.parse('a'.repeat(40));
const MERGED = Sha.parse('b'.repeat(40));
const SANDBOX = { kind: 'sandbox', slot: 'a2' } as const;

const POLICY = `
classes:
  - name: comment-only
    match: { syntax: comments-and-whitespace }
    route: auto
  - name: auth
    match: { paths: ["src/auth/**"] }
    route: card
  - name: api
    match: { paths: ["src/api/**"] }
    route: triage
`;

type Fake = {
  readonly host: ApprovalHost;
  /** Each Workers AI call: the model id and the body. */
  readonly asked: { readonly model: string; readonly body: Readonly<Record<string, unknown>> }[];
  readonly reads: { count: number };
};

function fakeHost(options: {
  readonly policy?: string | null;
  readonly changes?: readonly FileChange[];
  readonly ai?: AiRunner;
  readonly approvedBy?: string;
}): Fake {
  const asked: Fake['asked'] = [];
  const reads = { count: 0 };
  const store = new Map<string, { receipt: RouteReceipt; fingerprint: string }>();
  const clef = options.ai;
  const ai: AiRunner | null =
    clef === undefined
      ? null
      : {
          run: (model, body, runOptions) => {
            asked.push({ model, body });
            return clef.run(model, body, runOptions);
          },
        };
  const host: ApprovalHost = {
    readPolicy: () =>
      Promise.resolve({
        file:
          options.policy === null
            ? null
            : { path: '.gitstalk/policy.yml', text: options.policy ?? POLICY },
        sha: 'c'.repeat(40),
      }),
    changedFiles: () => {
      reads.count += 1;
      return Promise.resolve(options.changes ?? []);
    },
    principal: (_task, instance) => (instance.kind === 'sandbox' ? `agent:${instance.slot}` : '?'),
    origin: () => 'agent',
    revision: () => null,
    approval: () =>
      options.approvedBy === undefined ? null : { actor: options.approvedBy, atMs: 1 },
    previous: (task) => store.get(task) ?? null,
    save: (entry) => store.set(entry.receipt.bean, entry),
    model: decisionModelFrom({ name: 'clef', ai, gateway: '', budgetMs: 50 }),
    now: () => 1000,
  };
  return { host, asked, reads };
}

function landing(files: readonly string[], task = 'b1'): LandingTree {
  return { sha: MERGED, task, onto: ONTO, files };
}

function change(path: string, before: string, after: string): FileChange {
  return { path, before, after, beforeId: null, afterId: null };
}

function clefSays(choice: string, probability: number): AiRunner {
  return {
    run: () =>
      Promise.resolve({
        answers: { route: { choice, probabilities: { [choice]: probability } } },
      }),
  };
}

function answering(route: {
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
}): AiRunner {
  return { run: () => Promise.resolve({ answers: { route } }) };
}

describe('judgeLanding', () => {
  it('lets a comment-only change to a carded path through, reading the diff once', async () => {
    const fake = fakeHost({
      changes: [change('src/auth/a.ts', 'let a = 1;\n', '// why\nlet a = 1;\n')],
    });
    const judged = await judgeLanding(fake.host, landing(['src/auth/a.ts']), SANDBOX);
    expect(judged.hold).toBeNull();
    expect(judged.receipt).toMatchObject({
      route: 'auto',
      class: 'comment-only',
      classes: ['comment-only', 'auth'],
      by: 'policy',
      principal: 'agent:a2',
    });
    expect(fake.reads.count).toBe(1);
  });

  it('holds a code change to a carded path until it is approved', async () => {
    const changes = [change('src/auth/a.ts', 'let a = 1;\n', 'let a = 2;\n')];
    const held = await judgeLanding(
      fakeHost({ changes }).host,
      landing(['src/auth/a.ts']),
      SANDBOX,
    );
    expect(held.hold?.failingTests[0]?.name).toBe('awaits approval by a person');
    expect(held.receipt.approval).toEqual({ state: 'awaiting', actor: null });
    const approved = await judgeLanding(
      fakeHost({ changes, approvedBy: 'acme' }).host,
      landing(['src/auth/a.ts']),
      SANDBOX,
    );
    expect(approved.hold).toBeNull();
    expect(approved.receipt.approval).toEqual({ state: 'approved', actor: 'acme' });
  });

  it('reads no file contents when paths decide alone', async () => {
    const fake = fakeHost({});
    await judgeLanding(fake.host, landing(['README.md', 'src/auth/a.ts']), SANDBOX);
    expect(fake.reads.count).toBe(0);
  });

  it('asks Clef to triage, with the required body, and keeps its probability', async () => {
    const fake = fakeHost({ ai: clefSays('auto', 0.83) });
    const judged = await judgeLanding(fake.host, landing(['src/api/orders.ts']), SANDBOX);
    expect(judged.receipt).toMatchObject({ route: 'auto', by: 'clef', probability: 0.83 });
    expect(fake.asked[0]).toMatchObject({
      model: DECISION_MODELS.clef.workersAiId,
      body: { model: 'clef-flash', questions: { route: { type: 'choice' } } },
    });
    expect(judged.lines.join('\n')).toContain('api -> auto (clef, p=0.83)');
  });

  it('holds a bean only when Clef is sure; an unsure card lands on its tests', async () => {
    const unsure = fakeHost({
      ai: answering({ choice: 'card', probabilities: { card: 0.51, auto: 0.49 } }),
    });
    const landed = await judgeLanding(unsure.host, landing(['src/api/orders.ts']), SANDBOX);
    expect(landed.receipt).toMatchObject({ route: 'auto', by: 'clef', probability: 0.49 });
    const sure = fakeHost({ ai: clefSays('card', CARD_MIN_PROBABILITY) });
    const held = await judgeLanding(sure.host, landing(['src/api/orders.ts']), SANDBOX);
    expect(held.receipt).toMatchObject({ route: 'card', by: 'clef' });
  });

  it('reuses a triage while the change is the same', async () => {
    const fake = fakeHost({ ai: clefSays('card', 0.7) });
    await judgeLanding(fake.host, landing(['src/api/orders.ts']), SANDBOX);
    await judgeLanding(fake.host, landing(['src/api/orders.ts']), SANDBOX);
    expect(fake.asked).toHaveLength(1);
    await judgeLanding(fake.host, landing(['src/api/orders.ts', 'src/api/b.ts']), SANDBOX);
    expect(fake.asked).toHaveLength(2);
  });

  it('falls back to the rule when Clef is late or answers outside the choices', async () => {
    const late: AiRunner = { run: () => new Promise(() => undefined) };
    const slow = await judgeLanding(
      fakeHost({ ai: late }).host,
      landing(['src/api/a.ts']),
      SANDBOX,
    );
    expect(slow.receipt).toMatchObject({ route: 'card', by: 'rules', probability: null });
    const odd = await judgeLanding(
      fakeHost({ ai: clefSays('maybe', 1) }).host,
      landing(['src/api/a.ts']),
      SANDBOX,
    );
    expect(odd.receipt.by).toBe('rules');
  });

  it('judges by the built-in rules alone when the policy on the stalk is invalid', async () => {
    const fake = fakeHost({ policy: 'classes: 1' });
    const judged = await judgeLanding(fake.host, landing(['.gitstalk/automations/a.md']), SANDBOX);
    expect(judged.receipt).toMatchObject({ route: 'card', class: 'policy-change' });
    expect(judged.receipt.policy.valid).toBe(false);
    expect(judged.lines.join('\n')).toContain('is invalid; only the built-in rules apply');
  });

  it('routes everything auto, silently, with no policy on the stalk', async () => {
    const judged = await judgeLanding(
      fakeHost({ policy: null }).host,
      landing(['.gitstalk/automations/a.md']),
      SANDBOX,
    );
    expect(judged).toMatchObject({ hold: null, lines: [], receipt: { route: 'auto' } });
  });
});

describe('askChoice', () => {
  it('falls back without a binding', async () => {
    const answer = await askChoice(decisionModelFrom({ name: 'clef', ai: null, gateway: '' }), {
      state: {},
      instructions: 'pick',
      criteria: { a: 'one', b: 'two' },
      fallback: 'b',
    });
    expect(answer).toMatchObject({
      kind: 'fell-back',
      value: { choice: 'b' },
      reason: 'no decision model',
    });
  });
});

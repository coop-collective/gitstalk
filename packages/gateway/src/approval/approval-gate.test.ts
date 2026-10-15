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
const PRICE_SHA = Sha.parse('d'.repeat(40));
const PRICE_DOLLARS: LandedFake = {
  bean: 'price-dollars',
  files: ['src/api/price.ts'],
  sha: PRICE_SHA,
  parent: ONTO,
  intent: 'Price in dollars, not cents',
  message: 'Price in dollars, not cents\n\nEvery amount the API returns is now in dollars.',
  changes: [
    {
      path: 'src/api/price.ts',
      before: 'export function price() {\n  return 10000;\n}\n',
      after: 'export function price() {\n  return 100;\n}\n',
      beforeId: null,
      afterId: null,
    },
  ],
};
/** The shipping bean's own change: it imports `price.ts` and calls `price()` on a new line. */
const SHIPPING_CHANGES: readonly FileChange[] = [
  {
    path: 'src/api/checkout.ts',
    before: "import { price } from './price';\n\nexport function total() {\n  return price();\n}\n",
    after:
      "import { price } from './price';\n\nconst SHIPPING = 500;\n\nexport function total() {\n  return price() + SHIPPING;\n}\n",
    beforeId: null,
    afterId: null,
  },
];

/** A bean landed since the fork, as the fake host serves it. */
type LandedFake = {
  readonly bean: string;
  readonly files: readonly string[];
  readonly sha: Sha;
  readonly parent: Sha;
  readonly intent: string;
  readonly message: string;
  readonly changes: readonly FileChange[];
  readonly state?: 'landed' | 'in-flight';
};

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
  /** The bean's pushed head (null: a race). */
  readonly revision?: string | null;
  /** The stalk commit the policy is read at; moved by a test between checks. */
  readonly stalk?: { sha: string };
  /** Beans landed since the bean forked, with intents; moved by a test between checks. */
  readonly landed?: { beans: readonly LandedFake[] };
  /** The beans the pushed head's `Intent-checked:` trailers name. */
  readonly checked?: { beans: readonly string[] };
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
        sha: options.stalk?.sha ?? 'c'.repeat(40),
      }),
    changedFiles: (range) => {
      reads.count += 1;
      const landedBean = options.landed?.beans.find((entry) => entry.sha === range.to);
      return Promise.resolve(landedBean?.changes ?? options.changes ?? []);
    },
    principal: (_task, instance) => (instance.kind === 'sandbox' ? `agent:${instance.slot}` : '?'),
    origin: () => 'agent',
    revision: () => options.revision ?? null,
    intent: (task) =>
      task === 'b1'
        ? 'Add $5 shipping (in cents)'
        : (options.landed?.beans.find((entry) => entry.bean === task)?.intent ?? null),
    beansNotSeen: () =>
      (options.landed?.beans ?? []).map(({ bean, files, sha, parent, state }) => ({
        bean,
        files,
        sha,
        parent,
        state: state ?? 'landed',
      })),
    headMessage: (task) =>
      Promise.resolve(
        task === 'b1'
          ? `Add $5 shipping (in cents)\n\nShipping is a flat 500 cents.${checkedTrailer(options.checked)}`
          : (options.landed?.beans.find((entry) => entry.bean === task)?.message ?? null),
      ),
    approval: () =>
      options.approvedBy === undefined
        ? null
        : { actor: options.approvedBy, atMs: 1, note: null, client: 'web', idempotencyKey: null },
    previous: (task) => store.get(task) ?? null,
    save: (entry) => store.set(entry.receipt.bean, entry),
    model: decisionModelFrom({ name: 'clef', ai, gateway: '', budgetMs: 50 }),
    clashModel: decisionModelFrom({ name: 'clef-27b', ai, gateway: '', budgetMs: 50 }),
    now: () => 1000,
  };
  return { host, asked, reads };
}

function checkedTrailer(checked: { beans: readonly string[] } | undefined): string {
  return checked === undefined ? '' : `\n\nIntent-checked: ${checked.beans.join(', ')}`;
}

/** Clef answering the route and each `clash.<n>` question (a yes-or-no probability). */
function clefAnswers(route: string, clashes: Readonly<Record<string, number>>): AiRunner {
  const answers = Object.fromEntries(Object.entries(clashes).map(([key, noul]) => [key, { noul }]));
  return {
    run: () =>
      Promise.resolve({
        answers: { route: { choice: route, probabilities: { [route]: 0.8 } }, ...answers },
      }),
  };
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
    expect(held.hold?.held).toEqual({
      classes: held.receipt.classes,
      class: held.receipt.class,
      by: held.receipt.by,
    });
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

  it('reuses a triage when the same push is re-checked on a newer stalk', async () => {
    const stalk = { sha: 'c'.repeat(40) };
    const fake = fakeHost({ ai: clefSays('auto', 0.7), revision: 'r1', stalk });
    const first = await judgeLanding(fake.host, landing(['src/api/orders.ts']), SANDBOX);
    stalk.sha = 'd'.repeat(40);
    const recheck = await judgeLanding(
      fake.host,
      landing(['src/api/orders.ts', 'src/api/shrunk-later.ts']),
      SANDBOX,
    );
    expect(fake.asked).toHaveLength(1);
    expect(first.receipt.latencyMs).toEqual(expect.any(Number));
    expect(recheck.receipt).toMatchObject({ route: 'auto', by: 'clef', latencyMs: null });
    expect(recheck.receipt.policy.sha).toBe('d'.repeat(40));
  });

  it('asks again for a new push, or when the policy file changes', async () => {
    const changing = fakeHost({ ai: clefSays('auto', 0.7), revision: 'r1' });
    await judgeLanding(changing.host, landing(['src/api/orders.ts']), SANDBOX);
    const nextPush = fakeHost({ ai: clefSays('auto', 0.7), revision: 'r2' });
    nextPush.host.save(changing.host.previous('b1') ?? fail());
    await judgeLanding(nextPush.host, landing(['src/api/orders.ts']), SANDBOX);
    expect(nextPush.asked).toHaveLength(1);
    const newPolicy = fakeHost({
      ai: clefSays('auto', 0.7),
      revision: 'r1',
      policy: `${POLICY}  - name: docs\n    match: { class: docs-only }\n    route: auto\n`,
    });
    newPolicy.host.save(changing.host.previous('b1') ?? fail());
    await judgeLanding(newPolicy.host, landing(['src/api/orders.ts']), SANDBOX);
    expect(newPolicy.asked).toHaveLength(1);
  });

  it('tells Clef the class’s description and the diff’s size and test share', async () => {
    const fake = fakeHost({
      ai: clefSays('auto', 0.8),
      policy: `classes:\n  - name: lib\n    description: The framework runtime.\n    match: { paths: ["lib/**"] }\n    route: triage\n`,
      changes: [
        change('lib/request.js', 'a\nb\n', 'a\nB\nc\n'),
        change('test/request.test.js', 't\n', 't\nu\nv\n'),
      ],
    });
    await judgeLanding(fake.host, landing(['lib/request.js', 'test/request.test.js']), SANDBOX);
    expect(fake.reads.count).toBe(1);
    expect(fake.asked[0]?.body).toMatchObject({
      questions: { route: { type: 'choice', criteria: { auto: expect.any(String) } } },
      state: {
        classes: ['lib'],
        class: 'lib',
        class_description: 'The framework runtime.',
        file_count: 2,
        lines_added: 4,
        lines_removed: 1,
        test_line_share: 0.4,
        new_files: 0,
        deleted_files: 0,
      },
    });
  });

  it('shows Clef both messages and how the beans connect, with a clash question each', async () => {
    const fake = fakeHost({
      ai: clefAnswers('auto', { 'clash.0': 0.2 }),
      changes: SHIPPING_CHANGES,
      landed: { beans: [PRICE_DOLLARS] },
    });
    await judgeLanding(fake.host, landing(['src/api/checkout.ts']), SANDBOX);
    expect(fake.asked.map((call) => call.model)).toEqual([
      DECISION_MODELS.clef.workersAiId,
      DECISION_MODELS['clef-27b'].workersAiId,
    ]);
    expect(fake.asked[0]?.body).toMatchObject({
      questions: {
        route: { type: 'choice', criteria: { auto: expect.any(String), card: expect.any(String) } },
      },
    });
    expect(fake.asked[1]?.body['questions']).toEqual({
      'clash.0': { type: 'noul', instructions: expect.stringContaining('price-dollars') },
    });
    expect(fake.asked[1]?.body).toMatchObject({
      state: {
        intent: 'Add $5 shipping (in cents)',
        message: 'Add $5 shipping (in cents)\n\nShipping is a flat 500 cents.',
        landed_since_fork: [
          {
            bean: 'price-dollars',
            intent: 'Price in dollars, not cents',
            message:
              'Price in dollars, not cents\n\nEvery amount the API returns is now in dollars.',
            files: ['src/api/price.ts'],
            shared_files: [],
            this_imports_theirs: ['src/api/checkout.ts -> src/api/price.ts'],
            they_changed_this_uses: ['price'],
          },
        ],
      },
    });
    expect(fake.asked[0]?.body).not.toHaveProperty('questions.route.criteria.recheck');
  });

  it('asks only the route, as before, when no bean landed after it forked', async () => {
    const fake = fakeHost({ ai: clefSays('auto', 0.8) });
    await judgeLanding(fake.host, landing(['src/api/checkout.ts']), SANDBOX);
    expect(Object.keys(fake.asked[0]?.body['questions'] ?? {})).toEqual(['route']);
    expect(fake.asked[0]?.body['state']).not.toHaveProperty('landed_since_fork');
    expect(fake.asked[0]?.body['state']).not.toHaveProperty('message');
  });

  it('sends a sure clash back to its author as a red naming the bean and the links', async () => {
    const fake = fakeHost({
      ai: clefAnswers('auto', { 'clash.0': 0.9 }),
      changes: SHIPPING_CHANGES,
      landed: { beans: [PRICE_DOLLARS] },
    });
    const judged = await judgeLanding(fake.host, landing(['src/api/checkout.ts']), SANDBOX);
    expect(judged.receipt).toMatchObject({
      route: 'auto',
      by: 'clef',
      probability: 0.9,
      recheck: ['price-dollars'],
      approval: { state: 'not-needed' },
    });
    expect(judged.hold).toMatchObject({ green: false });
    expect(judged.hold).not.toHaveProperty('awaitsApproval');
    const output = judged.hold?.output ?? '';
    expect(output).toContain('price-dollars: Price in dollars, not cents');
    expect(output).toContain('imports: src/api/checkout.ts -> src/api/price.ts');
    expect(output).toContain('it changed, you use: price');
    expect(output).toContain('Intent-checked: price-dollars');
    const lines = judged.lines.join('\n');
    expect(lines).toContain('api -> recheck (clef, p=0.90)');
    expect(lines).toContain('back to its author: recheck against price-dollars');
  });

  it('lets a sure card win over a clash, and tells the person about the clash', async () => {
    const fake = fakeHost({
      ai: clefAnswers('card', { 'clash.0': 0.9 }),
      landed: { beans: [PRICE_DOLLARS] },
    });
    const judged = await judgeLanding(fake.host, landing(['src/api/checkout.ts']), SANDBOX);
    expect(judged.receipt).toMatchObject({
      route: 'card',
      approval: { state: 'awaiting' },
      recheck: ['price-dollars'],
    });
    expect(judged.hold).toMatchObject({ awaitsApproval: true });
    expect(judged.hold?.output).toContain('Before approving: Clef also thinks it may disagree');
    expect(judged.hold?.output).toContain('price-dollars: Price in dollars, not cents');
    const lines = judged.lines.join('\n');
    expect(lines).toContain('api -> card (clef, p=0.80)');
    expect(lines).toContain('clef also sees a possible clash with price-dollars');
    expect(lines).not.toContain('back to its author');
  });

  it('lets a bean whose author marked the landed beans checked through on its tests', async () => {
    const fake = fakeHost({
      ai: clefSays('auto', 0.8),
      landed: { beans: [PRICE_DOLLARS] },
      checked: { beans: ['price-dollars'] },
    });
    const judged = await judgeLanding(fake.host, landing(['src/api/checkout.ts']), SANDBOX);
    expect(judged.hold).toBeNull();
    expect(judged.receipt.recheck).toBeUndefined();
    expect(Object.keys(fake.asked[0]?.body['questions'] ?? {})).toEqual(['route']);
  });

  it('lands an unsure clash on its tests, and asks again when another bean lands', async () => {
    const landed: { beans: readonly LandedFake[] } = { beans: [PRICE_DOLLARS] };
    const fake = fakeHost({
      ai: clefAnswers('auto', { 'clash.0': 0.25, 'clash.1': 0.1 }),
      revision: 'r1',
      landed,
    });
    const unsure = await judgeLanding(fake.host, landing(['src/api/checkout.ts']), SANDBOX);
    expect(unsure).toMatchObject({ hold: null, receipt: { route: 'auto', probability: 0.8 } });
    await judgeLanding(fake.host, landing(['src/api/checkout.ts']), SANDBOX);
    expect(fake.asked).toHaveLength(2);
    const tax = {
      ...PRICE_DOLLARS,
      bean: 'tax',
      sha: Sha.parse('e'.repeat(40)),
      intent: 'Add tax',
    };
    landed.beans = [tax, PRICE_DOLLARS];
    await judgeLanding(fake.host, landing(['src/api/checkout.ts']), SANDBOX);
    expect(fake.asked).toHaveLength(4);
  });

  it('lands on the route alone when the clash call fails', async () => {
    const routeOnly: AiRunner = {
      run: (model) =>
        model === DECISION_MODELS['clef-27b'].workersAiId
          ? Promise.reject(new Error('clef 27b unavailable'))
          : Promise.resolve({
              answers: { route: { choice: 'auto', probabilities: { auto: 0.8 } } },
            }),
    };
    const fake = fakeHost({ ai: routeOnly, landed: { beans: [PRICE_DOLLARS] } });
    const judged = await judgeLanding(fake.host, landing(['src/api/checkout.ts']), SANDBOX);
    expect(judged).toMatchObject({ hold: null, receipt: { route: 'auto', by: 'clef' } });
    expect(judged.receipt.recheck).toBeUndefined();
  });

  it('never rechecks when Clef is down: the rule picks auto or card as before', async () => {
    const fake = fakeHost({ landed: { beans: [PRICE_DOLLARS] } });
    const judged = await judgeLanding(fake.host, landing(['src/api/checkout.ts']), SANDBOX);
    expect(judged.receipt).toMatchObject({ route: 'card', by: 'rules' });
    expect(judged.receipt.recheck).toBeUndefined();
  });

  it('judges a later push against an earlier one still in flight, and says so in the red', async () => {
    const inFlight: LandedFake = { ...PRICE_DOLLARS, state: 'in-flight' };
    const fake = fakeHost({
      ai: clefAnswers('auto', { 'clash.0': 0.8 }),
      changes: SHIPPING_CHANGES,
      landed: { beans: [inFlight] },
    });
    const judged = await judgeLanding(fake.host, landing(['src/api/checkout.ts']), SANDBOX);
    expect(fake.asked[0]?.body).toMatchObject({
      state: { landed_since_fork: [{ bean: 'price-dollars', in_flight: true }] },
    });
    expect(judged.receipt.recheck).toEqual(['price-dollars']);
    expect(judged.hold?.output).toContain(
      'price-dollars (pushed before this one, still being checked): Price in dollars, not cents',
    );
  });

  it('records how long Clef took, also when the rule answered for it', async () => {
    const late: AiRunner = { run: () => new Promise(() => undefined) };
    const slow = await judgeLanding(
      fakeHost({ ai: late }).host,
      landing(['src/api/a.ts']),
      SANDBOX,
    );
    expect(slow.receipt).toMatchObject({ by: 'rules' });
    expect(slow.receipt.latencyMs).toBeGreaterThanOrEqual(40);
    const carded = await judgeLanding(fakeHost({}).host, landing(['src/auth/a.ts']), SANDBOX);
    expect(carded.receipt.latencyMs).toBeNull();
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

function fail(): never {
  throw new Error('expected a saved receipt');
}

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

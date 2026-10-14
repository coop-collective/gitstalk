/**
 * The offline evaluation of Clef's triage (`triage-eval/README.md`): a labelled set of bean
 * situations from the staging benchmark (`triage-eval/cases.json`), the exact Workers AI
 * bodies the gate sends for them (`triage-eval/requests.jsonl`, kept equal to the code here;
 * `vitest -u` rewrites it), and the gate run over each case with a mocked AI binding.
 * `scripts/clef-triage-eval.mjs --live` sends the same bodies to Clef itself.
 */
import { describe, expect, it } from 'vitest';

import type { ModelRunner } from '@gitstalk/shared-ask/pick/decision-model';
import {
  DECISION_MODELS,
  decisionModelFrom,
  requestBody,
} from '@gitstalk/shared-ask/pick/decision-model';
import { classifyChange } from '@gitstalk/shared-race/approval-policy';
import type { RouteReceipt } from '@gitstalk/shared-race/approval-policy';
import { Sha } from '@gitstalk/shared-race/ids';
import { policyOf, readApprovalPolicy } from '@gitstalk/shared-race/policy-file';

import type { ApprovalHost } from './approval-gate';
import { judgeLanding } from './approval-gate';
import type { ChangeSize, TriageQuestion, TriageSubject } from './triage-question';
import { triageQuestion } from './triage-question';
import cases from './triage-eval/cases.json';

/** The staging benchmark's policy (`research/race/runs/stg-scion-policy-fastify-16-s7/policy.yml`). */
const BENCHMARK_POLICY = `classes:
  - name: comment-only
    match: { syntax: comments-and-whitespace }
    route: auto
  - name: docs
    match: { class: docs-only }
    route: auto
  - name: lib
    match: { paths: ["lib/**"] }
    route: triage
`;

/** The same policy with a description on the triaged class (`description`, new). */
const LIB_DESCRIPTION =
  "The framework's runtime: request and reply handling, routing, hooks, validation and errors.";

type EvalCase = (typeof cases)[number];

/** The question exactly as the benchmark asked it (before 2026-10-14's wording and state). */
function asRunQuestion(subject: TriageSubject): TriageQuestion {
  return {
    state: {
      classes: subject.classes,
      class: subject.decidedBy,
      files: subject.files.slice(0, 40),
      file_count: subject.files.length,
    },
    instructions:
      'Route this change to a source repository: auto lands it after its tests pass; card asks a person to approve it first.',
    criteria: {
      auto: 'The change is low risk: it cannot change behaviour a person must check (comments, docs, tests, a small isolated fix).',
      card: 'The change can alter sensitive behaviour (security, data, money, public interfaces, configuration), so a person should approve it.',
    },
  };
}

const VARIANTS = {
  /** What the staging runs sent. */
  'as-run': (entry: EvalCase) => asRunQuestion(subjectOf(entry, null)),
  /** Today's wording and state: the diff's size and test share. */
  current: (entry: EvalCase) => triageQuestion(subjectOf(entry, null)),
  /** Today's, with a description on the policy's class. */
  'current-described': (entry: EvalCase) => triageQuestion(subjectOf(entry, LIB_DESCRIPTION)),
} as const;

function subjectOf(entry: EvalCase, description: string | null): TriageSubject {
  const policy = policyOf(readApprovalPolicy(BENCHMARK_POLICY));
  const files = entry.files.map((path) => ({ path, commentOnly: false }));
  const classification = classifyChange(policy, files);
  return {
    classes: classification.classes,
    decidedBy: classification.decidedBy,
    description,
    files: entry.files,
    size: entry.size satisfies ChangeSize,
  };
}

/** Every case's body under every variant, one JSON line each, as `requests.jsonl` holds them. */
function evaluationRequests(): string {
  const spec = DECISION_MODELS.clef;
  const lines = Object.entries(VARIANTS).flatMap(([variant, question]) =>
    cases.map((entry) => {
      const asked = question(entry);
      const route = {
        type: 'choice',
        instructions: asked.instructions,
        criteria: asked.criteria,
      } as const;
      const body = requestBody(spec, asked.state, { route });
      return JSON.stringify({ variant, id: entry.id, model: spec.workersAiId, body });
    }),
  );
  return `${lines.join('\n')}\n`;
}

describe('the triage evaluation set', () => {
  it('holds every triaged bean of the benchmark, labelled, and synthetic cards', () => {
    const triaged = cases.filter((entry) => entry.recorded !== null);
    expect(triaged).toHaveLength(37);
    expect(cases.filter((entry) => entry.label === 'card').length).toBeGreaterThanOrEqual(8);
    for (const entry of cases) expect(subjectOf(entry, null).classes, entry.id).toEqual(['lib']);
  });

  it('keeps requests.jsonl equal to the bodies the gate sends', async () => {
    await expect(evaluationRequests()).toMatchFileSnapshot('./triage-eval/requests.jsonl');
  });

  it('routes each case by the label a sure Clef gives, through the gate', async () => {
    for (const entry of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one case at a time keeps failures readable
      const { receipt } = await judgeCase(
        entry,
        answering(entry.label === 'card' ? 'card' : 'auto', 0.9),
      );
      expect(receipt.route, entry.id).toBe(entry.label === 'card' ? 'card' : 'auto');
      expect(receipt.by, entry.id).toBe('clef');
    }
  });

  it('lands t013 when Clef answers card at its recorded p=0.51', async () => {
    const t013 = cases.find((entry) => entry.id === 't013');
    expect(t013?.recorded?.s7).toContain('card 0.51');
    const { receipt, hold } = await judgeCase(t013 ?? fail(), answering('card', 0.51, 0.49));
    expect(hold).toBeNull();
    expect(receipt).toMatchObject({ route: 'auto', by: 'clef', probability: 0.49 });
  });

  it('asks Clef once for t013’s first push, however often it is re-checked', async () => {
    const t013 = cases.find((entry) => entry.id === 't013') ?? fail();
    const asked: unknown[] = [];
    const ai: ModelRunner = {
      run: (_model, body) => {
        asked.push(body);
        return Promise.resolve({
          answers: { route: { choice: 'auto', probabilities: { auto: 0.62 } } },
        });
      },
    };
    const saved = new Map<string, { receipt: RouteReceipt; fingerprint: string }>();
    // The recorded first push was judged four times on four stalks, as prerequisites landed.
    for (const [index, files] of [
      t013.files,
      t013.files,
      t013.files.slice(1),
      t013.files.slice(2),
    ].entries()) {
      // oxlint-disable-next-line no-await-in-loop -- each re-check follows a landing
      await judgeCase({ ...t013, files }, ai, { saved, stalk: String(index).repeat(40) });
    }
    expect(asked).toHaveLength(1);
  });
});

function judgeCase(
  entry: EvalCase,
  ai: ModelRunner,
  options: {
    readonly saved?: Map<string, { receipt: RouteReceipt; fingerprint: string }>;
    readonly stalk?: string;
  } = {},
) {
  const saved = options.saved ?? new Map();
  const host: ApprovalHost = {
    readPolicy: () =>
      Promise.resolve({
        file: { path: '.gitstalk/policy.yml', text: BENCHMARK_POLICY },
        sha: options.stalk ?? 'c'.repeat(40),
      }),
    changedFiles: () => Promise.resolve(null),
    principal: () => '@loadgen',
    origin: () => 'agent',
    revision: () => 'b19ec8058aa04c1c4eda7f97ebbaed85a910159b',
    approval: () => null,
    previous: (task) => saved.get(task) ?? null,
    save: (judged) => saved.set(judged.receipt.bean, judged),
    model: decisionModelFrom({ name: 'clef', ai, gateway: '', budgetMs: 50 }),
    now: () => 1000,
  };
  const landing = {
    sha: Sha.parse('b'.repeat(40)),
    task: entry.id,
    onto: Sha.parse('a'.repeat(40)),
    files: entry.files,
  };
  return judgeLanding(host, landing, { kind: 'sandbox', slot: 'a1' });
}

function answering(choice: 'auto' | 'card', probability: number, other?: number): ModelRunner {
  const probabilities = {
    [choice]: probability,
    ...(other === undefined ? {} : { [choice === 'auto' ? 'card' : 'auto']: other }),
  };
  return { run: () => Promise.resolve({ answers: { route: { choice, probabilities } } }) };
}

function fail(): never {
  throw new Error('the case is missing from cases.json');
}

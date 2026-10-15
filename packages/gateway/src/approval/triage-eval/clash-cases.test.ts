/**
 * The offline half of the clash evaluation (`README.md` here): a labelled set of bean pairs
 * (`clash-cases.json`, one bean being judged and one that landed after it forked, each with its
 * intent, message and before/after files), and the exact Workers AI bodies the gate sends for
 * them (`clash-requests.jsonl`, kept equal to the code here; `vitest -u` rewrites it). The links
 * come from the real `beanLinks()` over the files. `scripts/clef-clash-eval.mjs --live` sends the
 * bodies to Clef Flash and scores the `clash.0` answers against the labels.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DECISION_MODELS, requestBody } from '@gitstalk/shared-ask/pick/decision-model';
import { Sha } from '@gitstalk/shared-race/ids';

import type { FileChange } from '../../git/diff-text';
import { NO_LINKS, beanLinks, linkCount } from '../bean-links';
import type { BeanLinks } from '../bean-links';
import type { LandedContext } from '../landed-since-fork';
import { withIntents } from '../landed-since-fork';
import { changeSize, clashQuestions, triageQuestion } from '../triage-question';
import type { TriageSubject } from '../triage-question';
import rawCases from './clash-cases.json';

/** A file's text as lines (joined with a final newline), or null when absent on that side. */
const FileText = z.array(z.string()).nullable();

const BeanSide = z.object({
  bean: z.string().regex(/^[a-z0-9-]+$/u),
  intent: z.string().min(1),
  message: z.string().nullable(),
  changes: z.array(z.object({ path: z.string().min(1), before: FileText, after: FileText })).min(1),
});

const ClashCase = z.object({
  id: z.string().regex(/^[kn]\d{2}$/u),
  language: z.enum(['javascript', 'typescript', 'python', 'go', 'java', 'rust']),
  clash: z.boolean(),
  note: z.string().min(1),
  this: BeanSide,
  theirs: BeanSide,
});

type ClashCase = z.infer<typeof ClashCase>;
type BeanSide = z.infer<typeof BeanSide>;

const cases = z.array(ClashCase).parse(rawCases);

/** The policy class every case's files fall in (the class that routed the bean to triage). */
const TRIAGED_CLASS = 'src';
/** Characters of a commit message Clef reads (`MESSAGE_CHARS` in `approval-gate.ts`). */
const MESSAGE_CHARS = 600;

/**
 * `current`: what the gate sends when `this` pushes second; `intents-only`: the same without
 * links, to see what they add; `swapped`: the gate judging `theirs` against a landed `this`
 * (whichever bean pushes second is the one judged, so both orders happen).
 */
const VARIANTS = {
  current: { links: 'code', judged: 'this' },
  'intents-only': { links: 'none', judged: 'this' },
  swapped: { links: 'code', judged: 'theirs' },
} as const;

type Variant = keyof typeof VARIANTS;
const VARIANT_NAMES: readonly Variant[] = ['current', 'intents-only', 'swapped'];

describe('the clash evaluation set', () => {
  it('holds about as many clashes as non-clashes, in several languages', () => {
    const clashes = cases.filter((entry) => entry.clash).length;
    expect(clashes).toBeGreaterThanOrEqual(15);
    expect(cases.length - clashes).toBeGreaterThanOrEqual(15);
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(cases.length);
    expect(new Set(cases.map((entry) => entry.language)).size).toBeGreaterThanOrEqual(5);
  });

  it('gives each bean a change, and shared files the same base on both sides', () => {
    for (const entry of cases) {
      const theirs = new Map(entry.theirs.changes.map((change) => [change.path, change.before]));
      for (const change of entry.this.changes)
        if (theirs.has(change.path))
          expect(change.before, entry.id).toEqual(theirs.get(change.path));
    }
  });

  // k11 and n11 also meet only over HTTP, but link by a local variable both name `order`.
  it('links each pair through its code, except across languages and a tests-only bean', () => {
    const unlinked = cases
      .filter((entry) => linkCount(linksOf(entry, 'current')) === 0)
      .map((entry) => entry.id);
    expect(unlinked).toEqual(['k17', 'n09', 'n18']);
  });

  it('asks one clash question beside the route for every case', () => {
    for (const entry of cases) {
      const questions = bodyOf(entry, 'current')['questions'];
      const keys =
        typeof questions === 'object' && questions !== null ? Object.keys(questions) : [];
      expect(keys, entry.id).toEqual(['route', 'clash.0']);
    }
  });

  it('keeps clash-requests.jsonl equal to the bodies the gate sends', async () => {
    await expect(evaluationRequests()).toMatchFileSnapshot('./clash-requests.jsonl');
  });
});

/** Every case's body under every variant, one JSON line each. */
function evaluationRequests(): string {
  const lines = VARIANT_NAMES.flatMap((variant) =>
    cases.map((entry) =>
      JSON.stringify({
        variant,
        id: entry.id,
        clash: entry.clash,
        links: linkCount(linksOf(entry, variant)),
        model: DECISION_MODELS.clef.workersAiId,
        body: bodyOf(entry, variant),
      }),
    ),
  );
  return `${lines.join('\n')}\n`;
}

/** The Workers AI body for a case: the route question and the landed bean's clash question. */
function bodyOf(entry: ClashCase, variant: Variant): Record<string, unknown> {
  const subject = subjectOf(oriented(entry, variant), linksOf(entry, variant));
  const question = triageQuestion(subject);
  const clashes = clashQuestions(subject.landedSinceFork);
  const route = {
    type: 'choice',
    instructions: question.instructions,
    criteria: question.criteria,
  } as const;
  return { ...requestBody(DECISION_MODELS.clef, question.state, { route, ...clashes.questions }) };
}

function subjectOf(entry: ClashCase, links: BeanLinks): TriageSubject {
  const mine = changesOf(entry.this);
  const files = mine.map((change) => change.path);
  const landed = {
    bean: entry.theirs.bean,
    files: entry.theirs.changes.map((change) => change.path),
    sha: Sha.parse('b'.repeat(40)),
    parent: Sha.parse('a'.repeat(40)),
    state: 'landed' as const,
  };
  const [intent] = withIntents([landed], { files, intent: () => entry.theirs.intent });
  const context: LandedContext = {
    ...(intent ?? landed),
    intent: entry.theirs.intent,
    sharedFiles: intent?.sharedFiles ?? [],
    message: messageBeyond(entry.theirs),
    links,
  };
  return {
    classes: [TRIAGED_CLASS],
    decidedBy: TRIAGED_CLASS,
    description: null,
    files,
    size: changeSize(mine),
    intent: entry.this.intent,
    message: messageBeyond(entry.this),
    landedSinceFork: [context],
  };
}

function linksOf(entry: ClashCase, variant: Variant): BeanLinks {
  if (VARIANTS[variant].links === 'none') return NO_LINKS;
  const judged = oriented(entry, variant);
  return beanLinks(changesOf(judged.this), changesOf(judged.theirs));
}

/** The case with the judged bean as `this`. */
function oriented(entry: ClashCase, variant: Variant): ClashCase {
  return VARIANTS[variant].judged === 'this'
    ? entry
    : { ...entry, this: entry.theirs, theirs: entry.this };
}

function changesOf(side: BeanSide): readonly FileChange[] {
  return side.changes.map((change) => ({
    path: change.path,
    before: textOf(change.before),
    after: textOf(change.after),
    beforeId: change.before === null ? null : `${change.path}@before`,
    afterId: change.after === null ? null : `${change.path}@after`,
  }));
}

function textOf(lines: readonly string[] | null): string | null {
  return lines === null ? null : `${lines.join('\n')}\n`;
}

/** The gate's `messageBeyond`: the message when it says more than the intent, else null. */
function messageBeyond(side: BeanSide): string | null {
  const text = side.message?.trim() ?? '';
  if (text === '' || text === side.intent.trim()) return null;
  return text.slice(0, MESSAGE_CHARS);
}

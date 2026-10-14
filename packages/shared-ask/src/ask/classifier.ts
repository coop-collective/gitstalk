/**
 * Question → view spec. Classifiers are swappable behind one interface: the deterministic
 * keyword router (the default) and a Workers AI model (optional, off unless configured).
 * Whatever a classifier answers is validated against the catalog; anything invalid falls
 * back to the keyword router, which always answers.
 */
import { parseQuestion } from './question-words';
import type { LineRef, QuestionClass, ViewSpec } from './view-spec';
import { ViewSpec as ViewSpecSchema } from './view-spec';

/** `clef` and `jev` name the decision model whose route replaced the classifier's. */
export type ClassifierName = 'keywords' | 'workers-ai' | 'clef' | 'jev';

export type Classification = {
  readonly spec: ViewSpec;
  /** Which classifier produced the spec (the AI one may have fallen back). */
  readonly by: ClassifierName;
};

export interface Classifier {
  readonly name: ClassifierName;
  classify(question: string, defaultRef: LineRef): Promise<Classification>;
}

type Rule = { readonly cls: QuestionClass; readonly weight: number; readonly pattern: RegExp };

/** Phrases that point at a class; weights break ties (a red sprout is "what broke" first). */
const RULES: readonly Rule[] = [
  { cls: 'pending-promotion', weight: 3, pattern: /\bnot (?:yet )?on (?:the )?stalk\b/ },
  { cls: 'pending-promotion', weight: 3, pattern: /\bsprout but not\b/ },
  {
    cls: 'pending-promotion',
    weight: 3,
    pattern: /\b(?:awaiting|pending|waiting for) (?:promotion|validation)\b/,
  },
  {
    cls: 'pending-promotion',
    weight: 3,
    pattern: /\b(?:not (?:yet )?promoted|unvalidated|ahead of (?:the )?stalk)\b/,
  },
  {
    cls: 'pending-promotion',
    weight: 2,
    pattern: /\bsprout (?:vs\.?|versus|and) (?:the )?stalk\b/,
  },
  { cls: 'what-broke', weight: 2, pattern: /\b(?:broke|broken|breaks?|breaking)\b/ },
  { cls: 'what-broke', weight: 2, pattern: /\b(?:go|goes|went|turn(?:ed)?) red\b|\bred\b/ },
  {
    cls: 'what-broke',
    weight: 2,
    pattern: /\b(?:fail(?:s|ed|ing|ure|ures)?|revert(?:s|ed)?|culprit)\b/,
  },
  {
    cls: 'in-flight',
    weight: 2,
    pattern: /\b(?:in[- ]flight|in progress|being worked on|right now|currently)\b/,
  },
  {
    cls: 'in-flight',
    weight: 2,
    pattern: /\b(?:working on|collid(?:e|es|ing)|overlap(?:s|ping)?)\b/,
  },
  {
    cls: 'decisions',
    weight: 2,
    pattern: /\b(?:decid(?:e|ed|es|ing)|decisions?|cards?|chose|choice)\b/,
  },
  {
    cls: 'tests-for',
    weight: 2,
    pattern: /\b(?:tests? (?:that )?cover(?:s|ing)?|covered by|coverage)\b/,
  },
  { cls: 'tests-for', weight: 2, pattern: /\b(?:what|which) tests?\b|\btests? for\b/ },
  { cls: 'who-why', weight: 1, pattern: /\bwho\b/ },
  { cls: 'who-why', weight: 1, pattern: /\bwhy\b/ },
  { cls: 'recent-changes', weight: 1, pattern: /\bwhat (?:has )?changed\b|\bchanges?\b/ },
  { cls: 'recent-changes', weight: 1, pattern: /\b(?:recent(?:ly)?|latest|lately|diff|history)\b/ },
  { cls: 'agent-activity', weight: 1, pattern: /\b(?:done|doing|did|touched|worked)\b/ },
];

/** The deterministic router: weighted phrase matches, then the entities. */
export const keywordClassifier: Classifier = {
  name: 'keywords',
  classify: (question, defaultRef) =>
    Promise.resolve({ spec: classifyByKeywords(question, defaultRef), by: 'keywords' }),
};

export function classifyByKeywords(question: string, defaultRef: LineRef): ViewSpec {
  const entities = parseQuestion(question);
  const cls = pickClass(question.toLowerCase(), entities);
  return {
    class: cls,
    entities: {
      feature: entities.feature,
      paths: [...entities.paths],
      agent: cls === 'agent-activity' || entities.agent !== null ? entities.agent : null,
      bean: entities.bean,
    },
    range: { minutes: entities.minutes, ref: entities.ref ?? defaultRef },
  };
}

function pickClass(text: string, entities: ReturnType<typeof parseQuestion>): QuestionClass {
  const scores = new Map<QuestionClass, number>();
  for (const rule of RULES) {
    if (rule.pattern.test(text)) scores.set(rule.cls, (scores.get(rule.cls) ?? 0) + rule.weight);
  }
  if (entities.agent !== null) bump(scores, 'agent-activity', 2);
  if (entities.bean !== null) bump(scores, 'bean', 2);
  if (entities.agent === null) scores.delete('agent-activity');
  const ranked = [...scores].toSorted(([, a], [, b]) => b - a);
  const best = ranked[0];
  if (best === undefined || best[1] < 1) return 'explore';
  return best[0];
}

function bump(scores: Map<QuestionClass, number>, cls: QuestionClass, weight: number): void {
  scores.set(cls, (scores.get(cls) ?? 0) + weight);
}

/** Validates a classifier's raw output; undefined when it is not a usable spec. */
export function validSpec(raw: unknown): ViewSpec | undefined {
  const parsed = ViewSpecSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

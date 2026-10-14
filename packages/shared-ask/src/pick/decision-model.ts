/**
 * Typed questions to a decision model on Workers AI: Cloudflare's Clef (the default) or
 * TypeSafe's Jev, both System One models that answer `choice`, `noul` and `score` questions
 * and never write text. One code path serves every model; what differs (the Workers AI id,
 * the `model` field Clef requires in the body, the name a receipt shows) is data in
 * `DECISION_MODELS`.
 *
 * Every ask has a budget and a fallback: a failure, a timeout or an answer outside the
 * question comes back as `fell-back` carrying the caller's fallback value, never as a throw.
 */
import { z } from 'zod';

export type DecisionModelName = 'clef' | 'clef-27b' | 'jev';
/** Which model family answered; what receipts record in `by`. */
export type DecisionModelFamily = 'clef' | 'jev';

export type DecisionModelSpec = {
  readonly name: DecisionModelName;
  readonly family: DecisionModelFamily;
  /** How a receipt names the family ("Clef ranked…"). */
  readonly familyLabel: string;
  /** How a label names the exact model that answered. */
  readonly displayName: string;
  readonly workersAiId: string;
  /** The body's `model` field (Clef requires `clef` or `clef-flash`); null to send none. */
  readonly bodyModel: string | null;
};

/**
 * Clef Flash (9B) is the default for the hot path; Clef (27B) is the precise one. The
 * changelog gives Clef 64K tokens of context; the clef-flash model page says 24,576, so
 * state is kept to compact JSON either way.
 */
export const DECISION_MODELS: Readonly<Record<DecisionModelName, DecisionModelSpec>> = {
  clef: {
    name: 'clef',
    family: 'clef',
    familyLabel: 'Clef',
    displayName: 'Clef Flash',
    workersAiId: '@cf/cloudflare/clef-flash',
    bodyModel: 'clef-flash',
  },
  'clef-27b': {
    name: 'clef-27b',
    family: 'clef',
    familyLabel: 'Clef',
    displayName: 'Clef 27B',
    workersAiId: '@cf/cloudflare/clef',
    bodyModel: 'clef',
  },
  jev: {
    name: 'jev',
    family: 'jev',
    familyLabel: 'Jev',
    displayName: 'Jev',
    workersAiId: 'typesafe/jev',
    bodyModel: null,
  },
};

export const DECISION_BUDGET_MS = 1500;

/** The slice of the Workers AI binding a decision model uses. */
export type ModelRunner = {
  run(
    model: string,
    input: Readonly<Record<string, unknown>>,
    options?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
};

/** A decision model ready to ask: which one, the binding, the gateway and the budget. */
export type DecisionModel = {
  readonly spec: DecisionModelSpec;
  readonly ai: ModelRunner;
  /** AI Gateway id the call goes through (logs, caching, unified billing); null for none. */
  readonly gateway: string | null;
  /** An ask must come back within this, or its fallback answers. */
  readonly budgetMs: number;
  /** Where failures are reported (the caller's structured logger). */
  readonly onError?: (question: string, error: unknown) => void;
};

export type DecisionModelConfig = {
  /** `clef`, `clef-27b` or `jev`; anything else (such as `rules`) means no model. */
  readonly name: string;
  /** The optional `AI` binding. */
  readonly ai: unknown;
  /** AI Gateway id (the `DECISION_GATEWAY` var); empty for none. */
  readonly gateway: string;
  readonly budgetMs?: number;
  readonly onError?: (question: string, error: unknown) => void;
};

export type Question =
  | {
      readonly type: 'choice';
      readonly instructions: string;
      /** Option id to what the model reads about it. */
      readonly criteria: Readonly<Record<string, string>>;
    }
  | { readonly type: 'noul'; readonly instructions: string }
  | {
      readonly type: 'score';
      readonly instructions: string;
      /** Ordered levels, lowest first. */
      readonly criteria: readonly string[];
    };

const Probabilities = z.record(z.string(), z.number());

const Answer = z.union([
  z.object({
    type: z.literal('choice').optional(),
    choice: z.string(),
    probabilities: Probabilities.optional(),
    confidence: z.number().optional(),
  }),
  z.object({ type: z.literal('noul').optional(), noul: z.number() }),
  z.object({
    type: z.literal('score').optional(),
    score: z.number(),
    probabilities: Probabilities.optional(),
    confidence: z.number().optional(),
  }),
]);
export type Answer = z.infer<typeof Answer>;

const Answers = z.object({ answers: z.record(z.string(), Answer) });

export type ChoiceAnswer = {
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number | null;
};

/** What every single-question ask takes. */
export type AskOptions = {
  /** The question key, also what `onError` reports (`[A-Za-z0-9_.-]{1,100}`); the type by default. */
  readonly id?: string;
  /** What the model reads: compact JSON or text, never secrets. */
  readonly state: unknown;
  readonly instructions: string;
};

export type Decided<T> =
  | {
      readonly kind: 'answered';
      readonly value: T;
      readonly model: DecisionModelSpec;
      readonly confidence: number | null;
      readonly ms: number;
    }
  | { readonly kind: 'fell-back'; readonly value: T; readonly reason: string; readonly ms: number };

/**
 * The decision model the configuration names, or null when it names none (`rules`), names an
 * unknown model or the `AI` binding is missing; callers then use their rule.
 */
export function decisionModelFrom(config: DecisionModelConfig): DecisionModel | null {
  if (!isDecisionModelName(config.name) || !isModelRunner(config.ai)) return null;
  return {
    spec: DECISION_MODELS[config.name],
    ai: config.ai,
    gateway: config.gateway === '' ? null : config.gateway,
    budgetMs: config.budgetMs ?? DECISION_BUDGET_MS,
    ...(config.onError === undefined ? {} : { onError: config.onError }),
  };
}

export function isDecisionModelName(name: string): name is DecisionModelName {
  return Object.hasOwn(DECISION_MODELS, name);
}

/** Asks one choice question; the fallback answers when the model cannot or picks off-list. */
export async function askChoice(
  model: DecisionModel | null,
  question: AskOptions & {
    readonly criteria: Readonly<Record<string, string>>;
    readonly fallback: string;
  },
): Promise<Decided<ChoiceAnswer>> {
  const key = question.id ?? 'choice';
  const fallback = { choice: question.fallback, probabilities: {}, confidence: null };
  return decide(model, { key, fallback }, async (live) => {
    const answer = await askOne(
      live,
      { key, state: question.state },
      {
        type: 'choice',
        instructions: question.instructions,
        criteria: question.criteria,
      },
    );
    if (!('choice' in answer)) throw new Error('the answer is not a choice');
    if (!Object.hasOwn(question.criteria, answer.choice))
      throw new Error(`"${answer.choice}" is not an option`);
    const probabilities = answer.probabilities ?? {};
    const confidence = answer.confidence ?? probabilities[answer.choice] ?? null;
    return { value: { choice: answer.choice, probabilities, confidence }, confidence };
  });
}

/** Asks one yes/no question; the value is the probability of yes. */
export function askNoul(
  model: DecisionModel | null,
  question: AskOptions & { readonly fallback: number },
): Promise<Decided<number>> {
  const key = question.id ?? 'noul';
  return decide(model, { key, fallback: question.fallback }, async (live) => {
    const answer = await askOne(
      live,
      { key, state: question.state },
      {
        type: 'noul',
        instructions: question.instructions,
      },
    );
    if (!('noul' in answer)) throw new Error('the answer is not a noul');
    return { value: answer.noul, confidence: null };
  });
}

/** Asks one score question; the value is the probability-weighted level (0 is the lowest). */
export function askScore(
  model: DecisionModel | null,
  question: AskOptions & { readonly levels: readonly string[]; readonly fallback: number },
): Promise<Decided<number>> {
  const key = question.id ?? 'score';
  return decide(model, { key, fallback: question.fallback }, async (live) => {
    const answer = await askOne(
      live,
      { key, state: question.state },
      {
        type: 'score',
        instructions: question.instructions,
        criteria: question.levels,
      },
    );
    if (!('score' in answer)) throw new Error('the answer is not a score');
    return { value: answer.score, confidence: answer.confidence ?? null };
  });
}

/**
 * Asks several questions in one call (1 to 64; keys `[A-Za-z0-9_.-]{1,100}`) and returns
 * every answer by key. Throws on failure or timeout: callers that want a fallback per
 * question use `askChoice`, `askNoul` or `askScore`.
 */
export async function askQuestions(
  model: DecisionModel,
  state: unknown,
  questions: Readonly<Record<string, Question>>,
): Promise<Readonly<Record<string, Answer>>> {
  const raw = await withBudget(
    model.ai.run(
      model.spec.workersAiId,
      requestBody(model.spec, state, questions),
      model.gateway === null ? {} : { gateway: { id: model.gateway } },
    ),
    model.budgetMs,
  );
  return Answers.parse(unwrap(raw)).answers;
}

/** The System One body, plus the `model` field when the spec has one. */
export function requestBody(
  spec: DecisionModelSpec,
  state: unknown,
  questions: Readonly<Record<string, Question>>,
): Readonly<Record<string, unknown>> {
  return { ...(spec.bodyModel === null ? {} : { model: spec.bodyModel }), state, questions };
}

async function askOne(
  model: DecisionModel,
  at: { readonly key: string; readonly state: unknown },
  question: Question,
): Promise<Answer> {
  const answer = (await askQuestions(model, at.state, { [at.key]: question }))[at.key];
  if (answer === undefined) throw new Error('no answer for the question');
  return answer;
}

async function decide<T>(
  model: DecisionModel | null,
  ask: { readonly key: string; readonly fallback: T },
  answer: (
    live: DecisionModel,
  ) => Promise<{ readonly value: T; readonly confidence: number | null }>,
): Promise<Decided<T>> {
  const started = Date.now();
  if (model === null)
    return { kind: 'fell-back', value: ask.fallback, reason: 'no decision model', ms: 0 };
  try {
    const { value, confidence } = await answer(model);
    return { kind: 'answered', value, model: model.spec, confidence, ms: Date.now() - started };
  } catch (error: unknown) {
    model.onError?.(ask.key, error);
    return {
      kind: 'fell-back',
      value: ask.fallback,
      reason: reason(error),
      ms: Date.now() - started,
    };
  }
}

/** The binding returns the answer; the REST API wraps it in `result` (twice). */
function unwrap(raw: unknown): unknown {
  let value = raw;
  for (let depth = 0; depth < 2; depth += 1) {
    if (typeof value !== 'object' || value === null || 'answers' in value) return value;
    value = Reflect.get(value, 'result') ?? value;
  }
  return value;
}

function withBudget<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    // Narrowed first: Workers' clearTimeout takes no undefined.
    if (timer !== undefined) clearTimeout(timer);
  });
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 120) : 'unknown error';
}

function isModelRunner(value: unknown): value is ModelRunner {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'run') === 'function'
  );
}

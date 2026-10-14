/**
 * The picker: where the page decides what to show. Code computes a candidate list, a picker
 * orders it, nothing writes layout (`docs/claude-opus/14` §5). Two pickers share one shape:
 * - `rulesPicker`: each decision's own deterministic rule;
 * - `modelPicker`: a decision model on Workers AI through AI Gateway (Clef Flash by default,
 *   or Clef 27B or TypeSafe's Jev; see `decision-model.ts`) ranks the candidates; any
 *   failure, timeout or answer outside the catalog falls back to the rule.
 *
 * Every decision leaves a receipt, so the page can show what was asked, the candidates, what
 * was chosen and by whom.
 */
import type { DecisionModel, DecisionModelFamily } from './decision-model';
import { askChoice } from './decision-model';

export type PickCandidate = {
  readonly id: string;
  /** What the model reads about the option: a description, never data values. */
  readonly description: string;
  /** How the receipt names it to a person. */
  readonly label: string;
};

export type RuleChoice = {
  /** Candidate ids, best first. */
  readonly chosen: readonly string[];
  /** The rule, in words, for the receipt. */
  readonly why: string;
};

export type PickDecision = {
  /** Stable name of the decision (`lead`, `route`, `files`, `sections`, `suggest`). */
  readonly id: string;
  readonly title: string;
  /** The instruction the model gets. */
  readonly ask: string;
  /** Compact context the model reads alongside the instruction (the question, a few flags). */
  readonly state: Readonly<Record<string, unknown>>;
  readonly candidates: readonly PickCandidate[];
  /** How many to keep, best first. */
  readonly slots: number;
  readonly rule: () => RuleChoice;
};

export type PickedBy = DecisionModelFamily | 'rules';

export type PickReceipt = {
  readonly decision: string;
  readonly title: string;
  readonly ask: string;
  readonly candidates: readonly PickCandidate[];
  readonly chosen: readonly string[];
  readonly by: PickedBy;
  /** The model that answered (`Clef Flash`, `Jev`); null when the rule did. */
  readonly model: string | null;
  /** Why the rule answered (or `Clef ranked…`). */
  readonly why: string;
  /** The model's confidence in its top choice; null for rules. */
  readonly confidence: number | null;
  readonly ms: number;
  /** Bytes of state plus candidate descriptions the model reads. */
  readonly inputBytes: number;
};

export interface Picker {
  readonly name: PickedBy;
  /** The model that ranks (`Clef Flash`); null for the rules. */
  readonly model: string | null;
  decide(decision: PickDecision): Promise<PickReceipt>;
}

export const rulesPicker: Picker = {
  name: 'rules',
  model: null,
  decide: (decision) => Promise.resolve(byRule(decision, 0, '')),
};

/**
 * A decision model (Clef by default) ranks the candidates as one `choice` question; any
 * failure, timeout or answer outside the candidates falls back to the decision's rule.
 */
export function modelPicker(model: DecisionModel): Picker {
  const { family, familyLabel, displayName } = model.spec;
  return {
    name: family,
    model: displayName,
    decide: async (decision) => {
      if (decision.candidates.length < 2) return byRule(decision, 0, '');
      const asked = await askChoice(model, {
        id: decision.id,
        state: decision.state,
        instructions: decision.ask,
        criteria: criteriaOf(decision),
        fallback: '',
      });
      if (asked.kind === 'fell-back')
        return byRule(decision, asked.ms, ` ${familyLabel} did not answer (${asked.reason}).`);
      return {
        ...receiptBase(decision),
        chosen: rankByProbability({
          decision,
          top: asked.value.choice,
          probabilities: asked.value.probabilities,
        }),
        by: family,
        model: displayName,
        why: `${familyLabel} ranked the candidates; ties follow the rule.`,
        confidence: asked.confidence,
        ms: asked.ms,
      };
    },
  };
}

/** Bytes of what a decision sends to the model (shown on the receipt). */
export function inputBytes(decision: PickDecision): number {
  return JSON.stringify({ state: decision.state, criteria: criteriaOf(decision) }).length;
}

/** The model's top choice first, then the others by probability, ties in the rule's order. */
function rankByProbability(input: {
  readonly decision: PickDecision;
  readonly top: string;
  readonly probabilities: Readonly<Record<string, number>> | undefined;
}): readonly string[] {
  const ruleOrder = input.decision.rule().chosen;
  const position = (id: string): number => {
    const at = ruleOrder.indexOf(id);
    return at === -1 ? ruleOrder.length : at;
  };
  const probability = (id: string): number => input.probabilities?.[id] ?? 0;
  const rest = input.decision.candidates
    .map((candidate) => candidate.id)
    .filter((id) => id !== input.top)
    .toSorted((a, b) => probability(b) - probability(a) || position(a) - position(b));
  return [input.top, ...rest].slice(0, input.decision.slots);
}

function byRule(decision: PickDecision, ms: number, note: string): PickReceipt {
  const rule = decision.rule();
  const ids = new Set(decision.candidates.map((candidate) => candidate.id));
  return {
    ...receiptBase(decision),
    chosen: rule.chosen.filter((id) => ids.has(id)).slice(0, decision.slots),
    by: 'rules',
    model: null,
    why: `${rule.why}${note}`,
    confidence: null,
    ms,
  };
}

function receiptBase(decision: PickDecision) {
  return {
    decision: decision.id,
    title: decision.title,
    ask: decision.ask,
    candidates: decision.candidates,
    inputBytes: inputBytes(decision),
  };
}

function criteriaOf(decision: PickDecision): Readonly<Record<string, string>> {
  return Object.fromEntries(
    decision.candidates.map((candidate) => [candidate.id, candidate.description]),
  );
}

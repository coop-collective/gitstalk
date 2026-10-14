/**
 * Where the picker decides inside an answer (`docs/claude-opus/14` §5): the question's
 * class (`route`), which resolved files the answer is about (`files`) and the order of the
 * answer's sections (`sections`). Code supplies every candidate and a rule; the picker only
 * orders them.
 */
import type { PickDecision, PickReceipt, Picker } from '../pick/picker';
import type { RailBlock } from './answer';
import type { RankedFile } from './resolve-files';
import type { QuestionClass, ViewSpec } from './view-spec';
import { CATALOG, QUESTION_CLASSES } from './view-spec';

/** Files the `files` decision chooses among, and how many it keeps. */
const FILE_CANDIDATES = 14;
const FILES_KEPT = 8;
/** Below this many ranked files there is nothing to choose. */
const FILES_TO_PICK = 4;

/** A section of an answer: the main pane or one rail block. */
export type SectionId = 'main' | RailBlock['kind'];

const SECTION_DESCRIPTIONS: Readonly<Record<SectionId, string>> = {
  main: 'the main view: a diff, a file, a bean or a list',
  beans: 'the beans involved, newest first',
  decisions: 'decision cards between specs that disagreed',
  tests: 'tests that cover the code and whether they pass',
  agents: 'the agents and what each holds',
  red: 'red validations, culprits and repairs',
  promotion: 'beans on the sprout waiting for the stalk',
  checks: "a bean's checks and reworks",
};

export type Routed = { readonly spec: ViewSpec; readonly receipt: PickReceipt };

/** The picker routes the question; the classifier's class is the rule. */
export async function pickRoute(input: {
  readonly picker: Picker;
  readonly question: string;
  readonly spec: ViewSpec;
  readonly classifiedBy: string;
}): Promise<Routed> {
  const decision: PickDecision = {
    id: 'route',
    title: 'Route the question',
    ask: 'Which kind of question is this?',
    state: { question: input.question },
    candidates: QUESTION_CLASSES.map((cls) => ({
      id: cls,
      description: CATALOG[cls].description,
      label: CATALOG[cls].label,
    })),
    slots: 1,
    rule: () => ({
      chosen: [input.spec.class],
      why: `Rule: the ${input.classifiedBy} router chose ${CATALOG[input.spec.class].label}.`,
    }),
  };
  const picked = await input.picker.decide(decision);
  const receipt = keepKeywordMatch(picked, input.spec.class);
  const chosen = QUESTION_CLASSES.find((cls) => cls === receipt.chosen[0]) ?? input.spec.class;
  return { spec: withClass(input.spec, chosen), receipt };
}

/**
 * The router's own match stands when it found one: the model's route decides only questions
 * the keywords could not place (`explore`). Its probabilities are flat on short questions, so
 * overriding a clear keyword match would trade a right answer for a guess.
 */
function keepKeywordMatch(receipt: PickReceipt, matched: QuestionClass): PickReceipt {
  if (receipt.model === null || matched === 'explore' || receipt.chosen[0] === matched)
    return receipt;
  return {
    ...receipt,
    chosen: [matched, ...receipt.chosen.filter((id) => id !== matched)].slice(0, 1),
    why: `The keywords matched ${CATALOG[matched].label}, so that stands; ${receipt.model} suggested ${receipt.chosen[0] ?? 'nothing'}.`,
  };
}

/** The picker chooses which resolved files the answer is about; the resolver's ranking is the rule. */
export async function pickFiles(input: {
  readonly picker: Picker;
  readonly feature: string;
  readonly ranked: readonly RankedFile[];
}): Promise<{ readonly ranked: readonly RankedFile[]; readonly receipt: PickReceipt | null }> {
  if (input.ranked.length < FILES_TO_PICK) return { ranked: input.ranked, receipt: null };
  const candidates = input.ranked.slice(0, FILE_CANDIDATES);
  const receipt = await input.picker.decide({
    id: 'files',
    title: 'Choose the files the answer is about',
    ask: `Which file is most about “${input.feature}”?`,
    state: { feature: input.feature },
    candidates: candidates.map((file) => ({
      id: file.path,
      description: file.path,
      label: file.path,
    })),
    slots: FILES_KEPT,
    rule: () => ({
      chosen: candidates.map((file) => file.path),
      why: 'Rule: the resolver’s ranking (name matches, then beans, then content).',
    }),
  });
  const byPath = new Map(candidates.map((file) => [file.path, file]));
  const ranked = receipt.chosen.flatMap((path) => {
    const file = byPath.get(path);
    return file === undefined ? [] : [file];
  });
  return { ranked, receipt };
}

/** The picker orders the answer's sections; the catalog's arrangement is the rule. */
export function pickSections(input: {
  readonly picker: Picker;
  readonly question: string;
  readonly cls: QuestionClass;
  readonly available: readonly SectionId[];
}): Promise<PickReceipt> {
  return input.picker.decide({
    id: 'sections',
    title: 'Arrange the answer',
    ask: `For the question “${input.question}”, which section should the reader see first?`,
    state: { question: input.question, kind: CATALOG[input.cls].label },
    candidates: input.available.map((id) => ({
      id,
      description: SECTION_DESCRIPTIONS[id],
      label: id,
    })),
    slots: input.available.length,
    rule: () => ({
      chosen: CARD_FIRST.has(input.cls) ? cardFirst(input.available) : input.available,
      why: `Rule: the fixed arrangement for ${CATALOG[input.cls].label}.`,
    }),
  });
}

/** Classes whose answer is a card first (the red validation, the decision), then the files. */
const CARD_FIRST: ReadonlySet<QuestionClass> = new Set(['what-broke', 'decisions']);

function cardFirst(available: readonly SectionId[]): readonly SectionId[] {
  const [main, first, ...rest] = available;
  return main === undefined || first === undefined ? available : [first, main, ...rest];
}

function withClass(spec: ViewSpec, cls: QuestionClass): ViewSpec {
  return cls === spec.class ? spec : { ...spec, class: cls };
}

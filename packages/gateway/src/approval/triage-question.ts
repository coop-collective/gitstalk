/**
 * The question the approval gate asks Clef when a bean's class routes to `triage`
 * (`docs/claude-opus/32-approval-rules.md`): what Clef reads about the change (its classes, the
 * deciding class and what that class is, its paths, and, when the gate read the diff, how big
 * it is and how much of it is tests; its intent and commit message, and the beans that landed
 * after it forked: their intents, messages and how the two changes connect) and the routes'
 * criteria, plus one yes-or-no `clash` question per connected landed bean. Pure, so the offline
 * evaluation (`triage-eval.test.ts`, `scripts/clef-triage-eval.mjs`) builds the same bodies
 * the gate sends.
 */
import { isDocPath, isTestPath } from '@gitstalk/shared-race/approval-policy';

import type { Question } from '@gitstalk/shared-ask/pick/decision-model';

import type { FileChange } from '../git/diff-text';
import { diffReport } from '../git/diff-text';
import { linkCount } from './bean-links';
import type { LandedContext } from './landed-since-fork';

/** Paths a triage question lists. */
const TRIAGE_PATHS = 40;

/** What the gate knows about a bean it triages. */
export type TriageSubject = {
  readonly classes: readonly string[];
  /** The class whose `triage` route decided, and its description when the policy gives one. */
  readonly decidedBy: string | null;
  readonly description: string | null;
  readonly files: readonly string[];
  /** The bean merge's line counts, when the gate read its diff. */
  readonly size: ChangeSize | null;
  /** The bean's intent (its first push's commit message), when it has one. */
  readonly intent: string | null;
  /** Its latest push's whole commit message, when it says more than the intent. */
  readonly message: string | null;
  /** Beans that landed after it forked and its author has not marked as checked. */
  readonly landedSinceFork: readonly LandedContext[];
};

/** How big a change is, by lines, and how much of it is tests. */
export type ChangeSize = {
  readonly linesAdded: number;
  readonly linesRemoved: number;
  /** Changed lines in test files over all changed lines (0 to 1, two decimals). */
  readonly testShare: number;
  readonly newFiles: number;
  readonly deletedFiles: number;
};

/** The question in `askChoice`'s terms. */
export type TriageQuestion = {
  readonly state: Readonly<Record<string, unknown>>;
  readonly instructions: string;
  readonly criteria: { readonly auto: string; readonly card: string };
};

/** Landed beans asked about one by one, the most connected first; the rest are only listed. */
export const CLASH_QUESTIONS = 4;

/** The `clash` questions, by question key, and the landed bean each one asks about. */
export type ClashQuestions = {
  readonly questions: Readonly<Record<string, Question>>;
  readonly beans: Readonly<Record<string, string>>;
};

/**
 * Written for decisiveness: the staging benchmark's Clef answered the first wording at p 0.51
 * to 0.85, and a feature that added one public property got `card` at 0.51. These say what each
 * route is for, that the tests run either way, and that a backwards-compatible addition is
 * not by itself a reason to hold a bean.
 */
export const TRIAGE_INSTRUCTIONS =
  'Decide how this change to a source repository lands. auto: it lands once its tests pass. card: it waits until a person approves it. The tests run either way, so pick card only when a person reading the change would catch a risk the tests cannot.';

export const TRIAGE_CRITERIA = {
  auto: 'Low risk once its tests pass: comments, docs, tests or type declarations; a bug fix or a small feature confined to a few files; a refactor that keeps behaviour; or a backwards-compatible addition to a public API.',
  card: 'Needs a person even when its tests pass: it touches authentication, permissions, secrets or security checks; stores, migrates or deletes data; handles money; removes or changes existing public behaviour; changes build, CI, dependency or deployment configuration; or it is large (several hundred changed lines across many files).',
} as const;

/**
 * One narrow question per landed bean, answered beside `route` in the same call: a yes is a
 * recheck, which sends the bean back to its author agent rather than to a person. A narrow
 * yes-or-no is better calibrated than a third option on the route (staging, 2026-10-15: the
 * three-way question chose recheck for the shipping-fee pair at p 0.71 from intents alone).
 * Written so overlap alone is not a clash: most landed beans touch unrelated behaviour.
 */
export const CLASH_INSTRUCTIONS = (bean: string): string =>
  `landed_since_fork lists beans that landed after this bean forked: its author never saw them and its tests never ran against them. Answer yes if this bean and ${bean} disagree about something both rely on (a unit, a format, a meaning, a return value or a constant), so that each passes its own tests while together they break. Read both intents and messages, and the links: imports between their files, and names one changed that the other uses. Answer no for changes that only touch the same files or names without assuming different things.`;

export function triageQuestion(subject: TriageSubject): TriageQuestion {
  const landed = subject.landedSinceFork;
  return {
    state: {
      classes: subject.classes,
      class: subject.decidedBy,
      ...(subject.description === null ? {} : { class_description: subject.description }),
      files: subject.files.slice(0, TRIAGE_PATHS),
      file_count: subject.files.length,
      ...(subject.size === null ? {} : sizeState(subject.size)),
      ...(subject.intent === null ? {} : { intent: subject.intent }),
      ...(subject.message === null ? {} : { message: subject.message }),
      ...(landed.length === 0 ? {} : { landed_since_fork: landed.map(landedState) }),
    },
    instructions: TRIAGE_INSTRUCTIONS,
    criteria: TRIAGE_CRITERIA,
  };
}

/**
 * The `clash.<n>` questions for the landed beans most connected to this one (links, then
 * shared files, then newest), at most `CLASH_QUESTIONS`; none when no bean landed since.
 */
export function clashQuestions(landed: readonly LandedContext[]): ClashQuestions {
  const ranked = landed
    .map((bean, index) => ({ bean, index }))
    .toSorted((a, b) => connection(b.bean) - connection(a.bean) || a.index - b.index)
    .slice(0, CLASH_QUESTIONS);
  const keys = ranked.map(({ index }) => `clash.${index}`);
  return {
    questions: Object.fromEntries(
      ranked.map(({ bean }, at) => [
        keys[at] ?? '',
        { type: 'noul', instructions: CLASH_INSTRUCTIONS(bean.bean) } satisfies Question,
      ]),
    ),
    beans: Object.fromEntries(ranked.map(({ bean }, at) => [keys[at] ?? '', bean.bean])),
  };
}

/** The line counts of a diff the gate read; null when it read none. */
export function changeSize(changes: readonly FileChange[] | null): ChangeSize | null {
  if (changes === null) return null;
  const files = diffReport(changes, 0).files;
  const lines = (file: (typeof files)[number]) => file.additions + file.deletions;
  const total = files.reduce((sum, file) => sum + lines(file), 0);
  const tests = files
    .filter((file) => isTestPath(file.path) && !isDocPath(file.path))
    .reduce((sum, file) => sum + lines(file), 0);
  return {
    linesAdded: files.reduce((sum, file) => sum + file.additions, 0),
    linesRemoved: files.reduce((sum, file) => sum + file.deletions, 0),
    testShare: total === 0 ? 0 : Math.round((tests / total) * 100) / 100,
    newFiles: files.filter((file) => file.status === 'added').length,
    deletedFiles: files.filter((file) => file.status === 'deleted').length,
  };
}

function landedState(bean: LandedContext): Readonly<Record<string, unknown>> {
  const { links } = bean;
  return {
    bean: bean.bean,
    ...(bean.intent === null ? {} : { intent: bean.intent }),
    ...(bean.message === null ? {} : { message: bean.message }),
    files: bean.files.slice(0, TRIAGE_PATHS),
    shared_files: bean.sharedFiles.slice(0, TRIAGE_PATHS),
    ...listed('this_imports_theirs', links.thisImportsTheirs),
    ...listed('theirs_imports_this', links.theirsImportsThis),
    ...listed('they_changed_this_uses', links.theyChangedThisUses),
    ...listed('this_changed_they_use', links.thisChangedTheyUse),
  };
}

function listed(key: string, values: readonly string[]): Readonly<Record<string, unknown>> {
  return values.length === 0 ? {} : { [key]: values };
}

/** Links count twice a shared file: an import or a used name is a contract, a file a place. */
function connection(bean: LandedContext): number {
  return linkCount(bean.links) * 2 + bean.sharedFiles.length;
}

function sizeState(size: ChangeSize): Readonly<Record<string, number>> {
  return {
    lines_added: size.linesAdded,
    lines_removed: size.linesRemoved,
    test_line_share: size.testShare,
    new_files: size.newFiles,
    deleted_files: size.deletedFiles,
  };
}

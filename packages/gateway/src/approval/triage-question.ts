/**
 * The question the approval gate asks Clef when a bean's class routes to `triage`
 * (`docs/claude-opus/32-approval-rules.md`): what Clef reads about the change (its classes, the
 * deciding class and what that class is, its paths, and, when the gate read the diff, how big
 * it is and how much of it is tests; its intent, and the intents of the beans that landed after
 * it forked) and the routes' criteria: `recheck` only when such beans exist. Pure, so the offline
 * evaluation (`triage-eval.test.ts`, `scripts/clef-triage-eval.mjs`) builds the same bodies
 * the gate sends.
 */
import { isDocPath, isTestPath } from '@gitstalk/shared-race/approval-policy';

import type { FileChange } from '../git/diff-text';
import { diffReport } from '../git/diff-text';
import type { LandedIntent } from './landed-since-fork';

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
  /** Beans that landed after it forked and its author has not marked as checked. */
  readonly landedSinceFork: readonly LandedIntent[];
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
  readonly criteria: { readonly auto: string; readonly card: string; readonly recheck?: string };
};

/** What Clef may answer: `recheck` is offered only when beans landed after the bean forked. */
export type TriageChoice = 'auto' | 'recheck' | 'card';

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
 * The third route, for two beans that each pass their tests but disagree: back to the author,
 * not to a person. Written so a shared file alone is not a reason (most landed beans touch
 * unrelated behaviour), and so a real risk still goes to a person.
 */
export const RECHECK_INSTRUCTIONS =
  " landed_since_fork lists beans that landed after this one forked, which its author never saw and its tests never ran against. recheck: it goes back to its author agent to check its change against them, because its intent and one of theirs disagree about something both rely on (a unit, a format, a function's meaning or a value), so the two could pass their tests apart and break together. Do not pick recheck only because files overlap.";

export const RECHECK_CRITERION =
  "Its intent conflicts with the intent of a bean in landed_since_fork: they assume different units, formats, meanings or values for something both use, and neither change's tests would show it.";

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
      ...(landed.length === 0 ? {} : { landed_since_fork: landed.map(landedState) }),
    },
    instructions:
      landed.length === 0 ? TRIAGE_INSTRUCTIONS : TRIAGE_INSTRUCTIONS + RECHECK_INSTRUCTIONS,
    criteria:
      landed.length === 0 ? TRIAGE_CRITERIA : { ...TRIAGE_CRITERIA, recheck: RECHECK_CRITERION },
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

function landedState(bean: LandedIntent): Readonly<Record<string, unknown>> {
  return {
    bean: bean.bean,
    ...(bean.intent === null ? {} : { intent: bean.intent }),
    files: bean.files.slice(0, TRIAGE_PATHS),
    shared_files: bean.sharedFiles.slice(0, TRIAGE_PATHS),
  };
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

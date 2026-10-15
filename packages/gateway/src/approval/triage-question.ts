/**
 * The question the approval gate asks Clef when a bean's class routes to `triage`
 * (`docs/claude-opus/32-approval-rules.md`): what Clef reads about the change (its classes, the
 * deciding class and what that class is, its paths, and, when the gate read the diff, how big
 * it is and how much of it is tests) and the two routes' criteria. Pure, so the offline
 * evaluation (`triage-eval.test.ts`, `scripts/clef-triage-eval.mjs`) builds the same bodies
 * the gate sends.
 */
import { isDocPath, isTestPath } from '@gitstalk/shared-race/approval-policy';

import type { FileChange } from '../git/diff-text';
import { diffReport } from '../git/diff-text';

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

export function triageQuestion(subject: TriageSubject): TriageQuestion {
  return {
    state: {
      classes: subject.classes,
      class: subject.decidedBy,
      ...(subject.description === null ? {} : { class_description: subject.description }),
      files: subject.files.slice(0, TRIAGE_PATHS),
      file_count: subject.files.length,
      ...(subject.size === null ? {} : sizeState(subject.size)),
    },
    instructions: TRIAGE_INSTRUCTIONS,
    criteria: TRIAGE_CRITERIA,
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

function sizeState(size: ChangeSize): Readonly<Record<string, number>> {
  return {
    lines_added: size.linesAdded,
    lines_removed: size.linesRemoved,
    test_line_share: size.testShare,
    new_files: size.newFiles,
    deleted_files: size.deletedFiles,
  };
}

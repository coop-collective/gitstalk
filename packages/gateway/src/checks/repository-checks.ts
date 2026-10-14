/**
 * A repository's checks, decided per checked tree (backlog 2.3,
 * `docs/claude-opus/24-checks-config.md`): `.gitstalk/checks.yml` (or a fallback, `CHECKS_PATHS`) is
 * read from the exact tree the check runs on, so a bean that changes it is checked by its own config. Before any
 * suite runs, a bean's pre-land check applies the sprout's protected paths to the files the
 * bean changes. The answer is a suite for the runner, or a check result that needs none:
 *
 * - no file, or the starter's older `[[check]]` draft: the engine's own suite (`node --test`),
 *   exactly what the repository ran before the file was read, and the push is told so;
 * - an invalid file: red, its one failing "test" naming every problem, and no suite run;
 * - a protected path changed by a push that may not: red, naming the paths and who may.
 */
import type { ChecksFile, ChecksResolution } from '@gitstalk/shared-race/checks-config';
import {
  CHECKS_PATH,
  describeChecks,
  protectedChanges,
  protectedPatterns,
  resolveChecksFile,
  suiteOf,
} from '@gitstalk/shared-race/checks-config';
import type { Sha } from '@gitstalk/shared-race/ids';
import type { RunSuite } from '@gitstalk/shared-race/suite';

import type { CheckInstance, CheckResult, FailingTest } from '../engine/model';
import type { LandingTree } from './check-store';
import { REMOTE_PREFIX as P } from '../push/push-messages';
import type { ProtectedAccess } from './protected-access';

/** What a check of one tree does: run this suite, or answer without one. */
export type CheckPlan =
  | { readonly kind: 'run'; readonly suite: RunSuite }
  | { readonly kind: 'answer'; readonly result: CheckResult };

/** What deciding a check needs from the engine's Durable Object. */
export type RepositoryChecksHost = {
  /** The checks file at a commit (`readChecksFile`), or null when the tree has none. */
  readChecks(sha: Sha): Promise<ChecksFile | null>;
  /** Remembers a bean's clean merge onto the sprout: the tree its pre-land check runs on. */
  saveLandingTree(tree: LandingTree): void;
  /** The bean merge that made `sha`, when `sha` is one (its pre-land check's tree). */
  landingTree(sha: Sha): LandingTree | null;
  /** What the bean's latest push may do to protected paths. */
  protectedAccess(task: string): ProtectedAccess;
  /** Keeps the lines a push of this tree's bean sees before its check's verdict. */
  record(sha: Sha, lines: readonly string[]): void;
};

/**
 * Decides one check: reads the tree's config (and, for a pre-land check, the sprout's).
 * `engineSuite` is what the engine is configured to run, for a tree that declares no suite.
 */
export async function planCheck(
  host: RepositoryChecksHost,
  check: { readonly sha: Sha; readonly instance: CheckInstance },
  engineSuite: RunSuite,
): Promise<CheckPlan> {
  const landing = check.instance.kind === 'sandbox' ? host.landingTree(check.sha) : null;
  const [resolution, sprout] = await Promise.all([
    host.readChecks(check.sha).then(resolveChecksFile),
    landing === null ? null : host.readChecks(landing.onto).then(resolveChecksFile),
  ]);
  const guard =
    landing === null || sprout === null
      ? null
      : protectedGuard(landing, sprout, host.protectedAccess(landing.task));
  const decided = decide(resolution, { guard, engineSuite });
  host.record(check.sha, decided.lines);
  return decided.plan;
}

/** The protected paths a bean changes, and whether its push may. */
export type ProtectedGuard = {
  readonly changed: readonly string[];
  readonly patterns: readonly string[];
  readonly access: ProtectedAccess;
};

/** The bean's changes to paths the sprout protects; null when it changes none. */
export function protectedGuard(
  landing: LandingTree,
  sprout: ChecksResolution,
  access: ProtectedAccess,
): ProtectedGuard | null {
  const patterns = protectedPatterns(sprout);
  const changed = protectedChanges(landing.files, patterns);
  return changed.length === 0 ? null : { changed, patterns, access };
}

/**
 * The plan and the push's lines for a tree's config and the bean's protected changes. A tree
 * that declares no suite runs the engine's (`engineSuite`), never "no checks".
 */
export function decide(
  resolution: ChecksResolution,
  context: { readonly guard: ProtectedGuard | null; readonly engineSuite: RunSuite },
): { plan: CheckPlan; lines: readonly string[] } {
  const { guard, engineSuite } = context;
  const guardLines = guard === null ? [] : protectedLines(guard);
  if (guard !== null && !guard.access.allowed)
    return { plan: answer(protectedRed(guard)), lines: guardLines };
  const lines = [
    ...guardLines,
    ...describeChecks(resolution, engineSuite).map((line) => `${P} ${line}`),
  ];
  switch (resolution.kind) {
    case 'missing':
    case 'legacy':
      return { plan: { kind: 'run', suite: engineSuite }, lines };
    case 'invalid':
      return { plan: answer(invalidRed(resolution.path, resolution.problems)), lines };
    case 'valid':
      return { plan: { kind: 'run', suite: suiteOf(resolution.config) }, lines };
    default:
      return resolution satisfies never;
  }
}

const NO_READS = {
  passingFiles: [],
  readSet: [],
  readSets: {},
  readDepths: {},
  stackFiles: [],
  suiteSeconds: 0,
  timedOut: false,
} as const;

function answer(result: CheckResult): CheckPlan {
  return { kind: 'answer', result };
}

/**
 * A pre-land check's refusal by a path guard, answered without a suite: the protected paths
 * here, and the approval rules' writer limits and holds (`approval/approval-gate.ts`), so every
 * guard falls a bean off the same way, with one failing "test" naming what it changed.
 */
export function guardRed(refusal: {
  readonly file: string;
  readonly name: string;
  readonly message: string;
  readonly output: readonly string[];
}): CheckResult {
  return red(
    { file: refusal.file, name: refusal.name, message: refusal.message },
    refusal.output.join('\n'),
  );
}

function red(failing: FailingTest, output: string): CheckResult {
  return {
    ...NO_READS,
    green: false,
    tests: 1,
    failures: 1,
    failingTests: [failing],
    failingFiles: [failing.file],
    output,
  };
}

function invalidRed(path: string, problems: readonly string[]): CheckResult {
  return red(
    { file: path, name: 'the checks config is valid', message: problems.join('; ') },
    [
      `${path} on the merged tree is invalid, so no tests ran:`,
      ...problems.map((problem) => `  ${problem}`),
      'Fix the file in this bean; see /docs/checks for the format.',
    ].join('\n'),
  );
}

function protectedRed(guard: ProtectedGuard): CheckResult {
  const [first = CHECKS_PATH] = guard.changed;
  return red(
    { file: first, name: 'changes a protected path', message: guard.changed.join(', ') },
    [
      `This bean changes protected paths: ${guard.changed.join(', ')}.`,
      `The sprout protects ${guard.patterns.join(', ')} (protected-paths in the checks file; the checks and policy files always).`,
      'Only the owner or a maintainer, pushing with a personal token or an SSH key, may change them;',
      `this push was by ${guard.access.who}.`,
      'Drop those changes from the bean, or ask a maintainer to push them.',
    ].join('\n'),
  );
}

function protectedLines(guard: ProtectedGuard): string[] {
  const paths = guard.changed.join(', ');
  return guard.access.allowed
    ? [`${P} changes protected paths (${paths}): allowed for ${guard.access.who}`]
    : [`${P} changes protected paths (${paths}): refused for ${guard.access.who}`];
}

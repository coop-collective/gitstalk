/**
 * Approval rules by kind of change (`docs/claude-opus/32-approval-rules.md`): the classes a
 * bean's change falls in, computed by code from its paths and (`code-tokens.ts`) its syntax,
 * never by a model, and the route they give it. The file they come from is `policy-file.ts`;
 * Clef ranks only beans a class routes to `triage` (the gateway's `approval/`).
 */
import { z } from 'zod';

import { matchesPattern } from './checks-config';
import { CONFIG_DIRS, configPaths } from './config-dir';
import type { ApprovalPolicy, BuiltinClass, ClassMatch, PolicyClass, Route } from './policy-file';
import { POLICY_CHANGE_CLASS, ROUTES } from './policy-file';

/**
 * A bean changing the configuration directory is class `policy-change`, always routed to
 * `card`: a bean never loosens the rules it is judged by without a person. The backlog is the
 * one exception: agents tick its tasks with ordinary beans (`23-mcp-repository-tools.md`).
 */
const POLICY_CHANGE_PATTERNS: readonly string[] = CONFIG_DIRS.map((dir) => `${dir}/**`);
const POLICY_CHANGE_EXEMPT: readonly string[] = configPaths('backlog.md');

/**
 * The receipt every routed bean leaves (`bean_routes` in its engine; `bean_status`, the
 * web's bean view): its classes, the route, who decided it and how sure, and the approval.
 */
export const RouteReceipt = z.object({
  bean: z.string(),
  classes: z.array(z.string()),
  route: z.enum(ROUTES),
  /** The class whose rule decided; null when none matched. */
  class: z.string().nullable(),
  /** `policy`: a class's own route; `clef`: Clef triaged; `rules`: triage fell back to the rule. */
  by: z.enum(['policy', 'clef', 'rules']),
  /** Clef's probability of its choice; null for the policy and the rules. */
  probability: z.number().nullable(),
  /**
   * How long Clef took to answer (or to fail, when the rule answered for it), in ms; null when
   * Clef was not asked for this receipt (a class's own route, or a triage reused for the same
   * change). Absent in receipts from before 2026-10-14.
   */
  latencyMs: z.number().nullable().optional(),
  /** Who the bean is from, as writer limits name principals. */
  principal: z.string(),
  reviewers: z.array(z.string()),
  /** Why the bean fell off (a writer limit), or null. */
  refused: z.string().nullable(),
  approval: z.object({
    state: z.enum(['not-needed', 'awaiting', 'approved']),
    actor: z.string().nullable(),
  }),
  /** The policy file it was judged by: its path and the stalk commit (null: no file). */
  policy: z.object({ path: z.string().nullable(), sha: z.string().nullable(), valid: z.boolean() }),
  /** The bean revision judged (its pushed head; null in a race). */
  revision: z.string().nullable(),
  at: z.number(),
});
export type RouteReceipt = z.infer<typeof RouteReceipt>;

/** A changed file as classification sees it. */
export type ChangedFile = {
  readonly path: string;
  /** Whether the file's change is only comments and whitespace (`code-tokens.ts`). */
  readonly commentOnly: boolean;
};

/** The classes a bean's change falls in, and what they decide. */
export type Classification = {
  /** Every class that matched, built-in ones first, in the file's order after them. */
  readonly classes: readonly string[];
  /** The route before any triage: the strictest of the matched classes' (`classifyChange`). */
  readonly route: Route;
  /** The class whose route decided (null: no class matched, so `auto`). */
  readonly decidedBy: string | null;
  /** Each class that limits writers, with the principals it allows (groups expanded). */
  readonly writers: readonly { readonly class: string; readonly allowed: readonly string[] }[];
  readonly reviewers: readonly string[];
};

/**
 * Who a change comes from, for the `policy-change` rule: `agent` (anything but a person's own
 * push), or `decider`, a person who may decide (an owner or maintainer pushing with their own
 * credential, as the Settings page does), whose change is itself the decision.
 */
export type ChangeOrigin = 'agent' | 'decider';

/**
 * Sorts a change into classes and routes it. The strictest route of the matched classes wins
 * (card over triage over auto), with two exceptions: an agent's change to the configuration
 * directory is always `policy-change` → `card` (a decider's is listed as `policy-change` and
 * routed by the other classes); and a change that is comment-only takes the route of the
 * policy's comment-only class when it has one, since no behaviour changed (writer limits still
 * apply). The fallback class (`match: { otherwise: true }`) matches only when no other class
 * did, the change is not an agent's policy change, and it has a file outside the configuration
 * directory, so a decider's own save and the backlog's ticks stay as they were. No file changed, or no class matched: `auto`.
 */
export function classifyChange(
  policy: ApprovalPolicy,
  files: readonly ChangedFile[],
  origin: ChangeOrigin = 'agent',
): Classification {
  const builtins = builtinClasses(files);
  const isPolicyChange = files.some(
    (file) => !POLICY_CHANGE_EXEMPT.includes(file.path) && isInConfigDir(file.path),
  );
  const isAgentPolicyChange = isPolicyChange && origin === 'agent';
  const ordinary = policy.classes.filter((entry) => matches(entry.match, files, builtins));
  const matched =
    ordinary.length > 0 || isAgentPolicyChange ? ordinary : fallbackClasses(policy, files);
  const writers = matched
    .filter((entry) => entry.writers.length > 0)
    .map((entry) => ({ class: entry.name, allowed: expand(policy, entry.writers) }));
  const builtinNames: ReadonlySet<string> = new Set(builtins);
  const classes = [
    ...(isPolicyChange ? [POLICY_CHANGE_CLASS] : []),
    ...builtins,
    ...matched.map((entry) => entry.name).filter((name) => !builtinNames.has(name)),
  ];
  const reviewers = [...new Set(matched.flatMap((entry) => expand(policy, entry.reviewers)))];
  const base = { classes, writers, reviewers };
  if (isAgentPolicyChange) return { ...base, route: 'card', decidedBy: POLICY_CHANGE_CLASS };
  const commentRule = builtins.includes('comment-only')
    ? matched.find((entry) => isCommentMatch(entry.match))
    : undefined;
  if (commentRule !== undefined)
    return { ...base, route: commentRule.route, decidedBy: commentRule.name };
  const strictest = matched.reduce<PolicyClass | null>(
    (best, entry) => (best === null || rank(entry.route) > rank(best.route) ? entry : best),
    null,
  );
  return strictest === null
    ? { ...base, route: 'auto', decidedBy: null }
    : { ...base, route: strictest.route, decidedBy: strictest.name };
}

/**
 * The writer limits a principal breaks: each class whose writers do not include it. A person
 * is `@handle`; a race's agent is `agent:a<slot>`.
 */
export function brokenWriterLimits(
  classification: Classification,
  principal: string,
): readonly { readonly class: string; readonly allowed: readonly string[] }[] {
  return classification.writers.filter((limit) => !limit.allowed.includes(principal));
}

/** Whether `path` can be judged comment-only (a policy without a syntax class never asks). */
export function asksForSyntax(policy: ApprovalPolicy): boolean {
  return policy.classes.some((entry) => isCommentMatch(entry.match));
}

/** The built-in classes of a change: each holds only when every changed file has the kind. */
export function builtinClasses(files: readonly ChangedFile[]): readonly BuiltinClass[] {
  if (files.length === 0) return [];
  const all = (test: (path: string) => boolean): boolean => files.every((file) => test(file.path));
  const classes: BuiltinClass[] = [];
  if (files.every((file) => file.commentOnly)) classes.push('comment-only');
  if (all(isDocPath)) classes.push('docs-only');
  if (all(isTestPath)) classes.push('tests-only');
  if (all(isLockfilePath)) classes.push('lockfile');
  return classes;
}

const DOC_EXTENSIONS: ReadonlySet<string> = new Set([
  'md',
  'mdx',
  'markdown',
  'txt',
  'rst',
  'adoc',
]);
const LOCKFILES: ReadonlySet<string> = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'uv.lock',
  'composer.lock',
  'go.sum',
]);

/** Documentation: prose files anywhere, and anything under a top-level `docs/`. */
export function isDocPath(path: string): boolean {
  return path.startsWith('docs/') || DOC_EXTENSIONS.has(extensionOf(path));
}

/** Tests: under a `test`, `tests` or `__tests__` directory, or named `*.test.*`, `*.spec.*`, `*_test.*`. */
export function isTestPath(path: string): boolean {
  const segments = path.split('/');
  const name = segments.at(-1) ?? '';
  return (
    segments.slice(0, -1).some((dir) => dir === 'test' || dir === 'tests' || dir === '__tests__') ||
    /\.(?:test|spec)\.[^.]+$/u.test(name) ||
    /_test\.[^.]+$/u.test(name) ||
    /^test_[^/]+\.py$/u.test(name)
  );
}

/** A package manager's lockfile, at any depth. */
export function isLockfilePath(path: string): boolean {
  return LOCKFILES.has(path.slice(path.lastIndexOf('/') + 1));
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** The fallback class, for a change no other class matched, when it has a file to route. */
function fallbackClasses(
  policy: ApprovalPolicy,
  files: readonly ChangedFile[],
): readonly PolicyClass[] {
  const fallback = policy.classes.find((entry) => entry.match.kind === 'otherwise');
  const isOutsideConfig = files.some((file) => !isInConfigDir(file.path));
  return fallback !== undefined && isOutsideConfig ? [fallback] : [];
}

function isInConfigDir(path: string): boolean {
  return POLICY_CHANGE_PATTERNS.some((pattern) => matchesPattern(path, pattern));
}

function matches(
  match: ClassMatch,
  files: readonly ChangedFile[],
  builtins: readonly BuiltinClass[],
): boolean {
  switch (match.kind) {
    case 'paths':
      return files.some((file) =>
        match.paths.some((pattern) => matchesPattern(file.path, pattern)),
      );
    case 'syntax':
      return builtins.includes('comment-only');
    case 'class':
      return builtins.includes(match.class);
    case 'otherwise':
      return false;
    default:
      return assertNever(match);
  }
}

function isCommentMatch(match: ClassMatch): boolean {
  return match.kind === 'syntax' || (match.kind === 'class' && match.class === 'comment-only');
}

function rank(route: Route): number {
  return ROUTES.indexOf(route);
}

/** `@name` is the group `name` when the file defines one, else the person `@name`. */
function expand(policy: ApprovalPolicy, principals: readonly string[]): readonly string[] {
  return [
    ...new Set(
      principals.flatMap((principal) => {
        const group = principal.startsWith('@') ? policy.groups[principal.slice(1)] : undefined;
        return group ?? [principal];
      }),
    ),
  ];
}

function assertNever(value: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}

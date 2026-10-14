/**
 * The approval rules' file: `.gitstalk/policy.yml` (or `.beanstalk/policy.yml`, `config-dir.ts`),
 * read from the stalk (`docs/claude-opus/32-approval-rules.md`). YAML like the automations
 * (`.gitstalk/automations/*.yml`) and GitHub's repository config (dependabot.yml, labeler.yml),
 * parsed strictly: YAML 1.2 core schema (`no` stays a string), unique keys, no anchors, aliases
 * or merge keys. Pure: the gateway, the web's Settings page and MCP read the same parse, and a
 * JSON Schema generated from the same Zod schema gives editors completion:
 *
 * ```yaml
 * # yaml-language-server: $schema=https://gitstalk.dev/schemas/policy.json
 * groups:
 *   security: ["@alice", "@bob"]
 * classes:
 *   - name: comment-only
 *     match: { syntax: comments-and-whitespace }
 *     route: auto
 *   - name: migration
 *     match: { paths: ["src/db/migrations/**"] }
 *     route: card
 *     reviewers: ["@data"]
 *   - name: protected
 *     match: { paths: ["src/auth/**"] }
 *     route: card
 *     writers: ["@security"]
 *   - name: everything-else
 *     match: { otherwise: true }
 *     route: triage
 * ```
 *
 * `match: { otherwise: true }` makes the fallback class: it applies only when no other class
 * matched (at most one per file; `approval-policy.ts`).
 */
import { stringify } from 'yaml';
import { z } from 'zod';

import { configPaths } from './config-dir';
import type { ConfigFile } from './config-dir';
import { fieldOf, parseStrictYaml, yamlPathOf } from './strict-yaml';
import type { YamlLocator, YamlPosition } from './strict-yaml';

/** Where the policy lives, in lookup order: `.gitstalk/` wins over `.beanstalk/`. */
export const POLICY_PATHS: readonly string[] = configPaths('policy.yml');

/** The documented place, named in messages. */
export const POLICY_PATH = '.gitstalk/policy.yml';

/** Where the published JSON Schema lives, for the `yaml-language-server` first line. */
export const POLICY_SCHEMA_URL = 'https://gitstalk.dev/schemas/policy.json';

export const ROUTES = ['auto', 'triage', 'card'] as const;
/** `auto`: lands and promotes as today; `triage`: Clef picks auto or card; `card`: a person approves first. */
export type Route = (typeof ROUTES)[number];

/** Classes code computes for every bean, whatever the file says; a policy class can route them. */
export const BUILTIN_CLASSES = ['comment-only', 'docs-only', 'tests-only', 'lockfile'] as const;
export type BuiltinClass = (typeof BUILTIN_CLASSES)[number];

/** The built-in class of a change to the configuration directory (`approval-policy.ts`). */
export const POLICY_CHANGE_CLASS = 'policy-change';

export type ClassMatch =
  | { readonly kind: 'paths'; readonly paths: readonly string[] }
  | { readonly kind: 'syntax'; readonly syntax: 'comments-and-whitespace' }
  | { readonly kind: 'class'; readonly class: BuiltinClass }
  /** The fallback: applies only when no other class matched (`approval-policy.ts`). */
  | { readonly kind: 'otherwise' };

export type PolicyClass = {
  readonly name: string;
  /** What the class is, in a sentence: shown to Clef when it triages the class's beans. */
  readonly description?: string;
  readonly match: ClassMatch;
  readonly route: Route;
  /** Who should decide its cards (shown on the card; the repository's deciders still decide). */
  readonly reviewers: readonly string[];
  /** When non-empty, only these principals may land beans in the class; others fall off. */
  readonly writers: readonly string[];
};

export type ApprovalPolicy = {
  readonly classes: readonly PolicyClass[];
  /** Named groups of principals, referred to as `@name`. */
  readonly groups: Readonly<Record<string, readonly string[]>>;
};

/** One thing wrong with the file: where (line and column, when known; the field) and what. */
export type PolicyProblem = {
  readonly line: number | null;
  readonly column: number | null;
  readonly field: string;
  readonly message: string;
};

export type PolicyResolution =
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'invalid';
      readonly path: string;
      readonly problems: readonly PolicyProblem[];
    }
  | { readonly kind: 'valid'; readonly path: string; readonly policy: ApprovalPolicy };

/**
 * The recommended starter rules, offered by Settings → Approval rules when a repository has no
 * file: comments, docs, tests and lockfiles land on their tests; migrations and auth code wait
 * for a person; everything else is triaged by Clef (the fallback class). An agent's change to
 * `.gitstalk/` is held for a person by the built-in `policy-change` class, so it needs no class
 * here (and a class there would hold a maintainer's own save from Settings too).
 */
export const STARTER_POLICY = `# yaml-language-server: $schema=${POLICY_SCHEMA_URL}
# Recommended starter rules (docs: /docs/approval-rules). A bean takes the strictest route of
# the classes it matches; a comment-only change takes the comments class's route; the
# everything-else class applies only when no other class matched. An agent's change to
# .gitstalk/ always waits for a person (built in).
classes:
  - name: comments
    description: Only comments and whitespace changed.
    match: { syntax: comments-and-whitespace }
    route: auto
  - name: docs
    description: Documentation only.
    match: { class: docs-only }
    route: auto
  - name: tests
    description: Tests only.
    match: { class: tests-only }
    route: auto
  - name: lockfile
    description: A package manager's lockfile only.
    match: { class: lockfile }
    route: auto
  - name: migrations
    description: Database schema and data migrations.
    match: { paths: ["**/migrations/**", "**/*.sql"] }
    route: card
  - name: auth
    description: Authentication, sessions, permissions and secrets handling.
    match: { paths: ["**/auth/**", "**/permissions/**", "**/security/**"] }
    route: card
  - name: everything-else
    description: Any other change.
    match: { otherwise: true }
    route: triage
`;

/** The policy a repository without a file (or with an invalid one) has: no classes. */
export const EMPTY_POLICY: ApprovalPolicy = { classes: [], groups: {} };

const MAX_FILE_CHARS = 32_000;
const MAX_CLASSES = 50;
const MAX_PATTERNS = 100;
const MAX_PRINCIPALS = 100;
const MAX_PROBLEMS = 20;
const MAX_DESCRIPTION_CHARS = 200;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/u;
/** `@handle` (a person, or a group of the file), or `agent:a3` (a race's agent slot). */
const PRINCIPAL = /^(?:@[A-Za-z0-9][A-Za-z0-9_.-]{0,38}|agent:a\d{1,2})$/u;

const Name = z
  .string({ error: 'must be a string' })
  .regex(NAME, 'must be lower-case letters, digits and dashes (at most 40)');

const Pattern = z
  .string({ error: 'must be a string' })
  .min(1, 'must not be empty')
  .max(200, 'must be at most 200 characters')
  .refine((pattern) => !pattern.startsWith('/'), 'is relative to the repository root: drop the /')
  .refine((pattern) => !pattern.split('/').includes('..'), 'must not contain ..');

const Principal = z
  .string({ error: 'must be a string' })
  .regex(PRINCIPAL, 'must be @handle, @group or agent:a<slot>');

const Principals = z
  .array(Principal, { error: 'must be a list of principals' })
  .max(MAX_PRINCIPALS, `must have at most ${MAX_PRINCIPALS} entries`);

const MATCH_SHAPES =
  'must be { paths: [...] }, { syntax: comments-and-whitespace }, { class: docs-only | tests-only | lockfile | comment-only } or { otherwise: true }';

const Match = z.union(
  [
    z.strictObject({
      paths: z
        .array(Pattern, { error: 'must be a list of path patterns' })
        .min(1, 'must name at least one pattern')
        .max(MAX_PATTERNS, `must have at most ${MAX_PATTERNS} patterns`),
    }),
    z.strictObject({ syntax: z.literal('comments-and-whitespace') }),
    z.strictObject({ class: z.enum(BUILTIN_CLASSES) }),
    z.strictObject({ otherwise: z.literal(true) }),
  ],
  { error: (issue) => matchProblem(issue.input) },
);

const ClassEntry = z.strictObject({
  name: Name.refine((name) => name !== POLICY_CHANGE_CLASS, `"${POLICY_CHANGE_CLASS}" is built in`),
  description: z
    .string({ error: 'must be a string' })
    .min(1, 'must not be empty')
    .max(MAX_DESCRIPTION_CHARS, `must be at most ${MAX_DESCRIPTION_CHARS} characters`)
    .optional(),
  match: Match,
  route: z.enum(ROUTES, { error: 'must be auto, triage or card' }),
  reviewers: Principals.default([]),
  writers: Principals.default([]),
});

/** The file's schema; `POLICY_JSON_SCHEMA` is generated from it. */
export const PolicyFile = z.strictObject({
  groups: z.record(Name, Principals).default({}),
  classes: z
    .array(ClassEntry, { error: 'must be a list of classes' })
    .max(MAX_CLASSES, `at most ${MAX_CLASSES} classes`)
    .default([]),
});
export type PolicyFileInput = z.input<typeof PolicyFile>;

/** The JSON Schema of the file, for editors (`# yaml-language-server: $schema=...`). */
export const POLICY_JSON_SCHEMA: Readonly<Record<string, unknown>> = z.toJSONSchema(PolicyFile, {
  io: 'input',
});

/**
 * What `text` (null when the tree has none), found at `path`, declares. Never throws: every
 * problem names its field and, when it can be found, its line and column.
 */
export function readApprovalPolicy(text: string | null, path = POLICY_PATH): PolicyResolution {
  if (text === null) return { kind: 'missing' };
  if (text.length > MAX_FILE_CHARS)
    return invalid(path, [at(null, '', `longer than ${MAX_FILE_CHARS} characters`)]);
  const parsed = parseStrictYaml(text);
  if (!parsed.ok)
    return invalid(
      path,
      parsed.problems.map((problem) => at(problem.position, '', problem.message)),
    );
  const file = PolicyFile.safeParse(parsed.value ?? {});
  if (!file.success)
    return invalid(
      path,
      file.error.issues.slice(0, MAX_PROBLEMS).map((issue) => problemOf(issue, parsed.at)),
    );
  const duplicate = duplicateName(file.data.classes.map((entry) => entry.name));
  if (duplicate !== null)
    return invalid(path, [
      at(
        parsed.at.value(['classes', duplicate.index, 'name']),
        `classes[${duplicate.index}].name`,
        `two classes are named "${duplicate.name}"`,
      ),
    ]);
  const second = secondFallback(file.data.classes.map((entry) => entry.match));
  if (second !== null)
    return invalid(path, [
      at(
        parsed.at.value(['classes', second, 'match', 'otherwise']),
        `classes[${second}].match.otherwise`,
        'only one class may be the fallback ({ otherwise: true })',
      ),
    ]);
  return {
    kind: 'valid',
    path,
    policy: {
      groups: file.data.groups,
      classes: file.data.classes.map(({ description, ...entry }) => ({
        ...entry,
        ...(description === undefined ? {} : { description }),
        match: matchOf(entry.match),
      })),
    },
  };
}

/** `readApprovalPolicy` of the file `readFirstPresent(POLICY_PATHS, ...)` found, or of none. */
export function resolvePolicyFile(file: ConfigFile | null): PolicyResolution {
  return file === null ? { kind: 'missing' } : readApprovalPolicy(file.text, file.path);
}

/** The policy a resolution routes by: an invalid file routes like no file, plus the built-ins. */
export function policyOf(resolution: PolicyResolution): ApprovalPolicy {
  return resolution.kind === 'valid' ? resolution.policy : EMPTY_POLICY;
}

/**
 * The policy as a file's text, with the schema line first: what a Settings page proposes as a
 * bean. `readApprovalPolicy` reads it back equal.
 */
export function writeApprovalPolicy(policy: ApprovalPolicy): string {
  const file = {
    ...(Object.keys(policy.groups).length === 0 ? {} : { groups: policy.groups }),
    classes: policy.classes.map((entry) => ({
      name: entry.name,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      match: matchInput(entry.match),
      route: entry.route,
      ...(entry.reviewers.length === 0 ? {} : { reviewers: entry.reviewers }),
      ...(entry.writers.length === 0 ? {} : { writers: entry.writers }),
    })),
  };
  return `# yaml-language-server: $schema=${POLICY_SCHEMA_URL}\n${stringify(file, { version: '1.2' })}`;
}

/** `policyGet`: the policy on a ref, the commit it came from, and what is wrong with it. */
export type ApprovalPolicyView = {
  readonly ref: string;
  readonly sha: string | null;
  readonly path: string | null;
  readonly policy: ApprovalPolicy | null;
  readonly problems: readonly PolicyProblem[];
};

/** The view of a resolved policy file read at `ref` (`sha`, null when unknown). */
export function policyView(
  resolution: PolicyResolution,
  source: { readonly ref: string; readonly sha: string | null },
): ApprovalPolicyView {
  switch (resolution.kind) {
    case 'missing':
      return { ...source, path: null, policy: null, problems: [] };
    case 'invalid':
      return { ...source, path: resolution.path, policy: null, problems: resolution.problems };
    case 'valid':
      return { ...source, path: resolution.path, policy: resolution.policy, problems: [] };
    default:
      return assertNever(resolution);
  }
}

function at(position: YamlPosition | null, field: string, message: string): PolicyProblem {
  return { line: position?.line ?? null, column: position?.column ?? null, field, message };
}

function problemOf(issue: z.core.$ZodIssue, where: YamlLocator): PolicyProblem {
  const path = yamlPathOf(issue.path);
  if (issue.code === 'unrecognized_keys') {
    const keys = issue.keys.map((key) => `"${key}"`).join(', ');
    const first = issue.keys[0];
    const position = first === undefined ? where.value(path) : where.key([...path, first]);
    return at(position, fieldOf(path), `unknown key ${keys}`);
  }
  return at(where.value(path), fieldOf(path), issue.message);
}

type ParsedMatch = z.infer<typeof Match>;

function matchOf(match: ParsedMatch): ClassMatch {
  if ('paths' in match) return { kind: 'paths', paths: match.paths };
  if ('syntax' in match) return { kind: 'syntax', syntax: match.syntax };
  if ('otherwise' in match) return { kind: 'otherwise' };
  return { kind: 'class', class: match.class };
}

/** Why a `match` is none of its shapes: a misused `otherwise` gets its own message. */
function matchProblem(input: unknown): string {
  if (typeof input !== 'object' || input === null || !('otherwise' in input)) return MATCH_SHAPES;
  if (Object.keys(input).length > 1)
    return 'otherwise cannot be combined with paths, syntax or class: the fallback applies only when no other class matched';
  return input.otherwise === true ? MATCH_SHAPES : 'otherwise must be true';
}

/** The index of the second fallback class, or null when there is at most one. */
function secondFallback(matches: readonly ParsedMatch[]): number | null {
  const fallbacks = [...matches.entries()].filter(([, match]) => 'otherwise' in match);
  return fallbacks[1]?.[0] ?? null;
}

function matchInput(match: ClassMatch): ParsedMatch {
  switch (match.kind) {
    case 'paths':
      return { paths: [...match.paths] };
    case 'syntax':
      return { syntax: match.syntax };
    case 'class':
      return { class: match.class };
    case 'otherwise':
      return { otherwise: true };
    default:
      return assertNever(match);
  }
}

function duplicateName(names: readonly string[]): { name: string; index: number } | null {
  const seen = new Set<string>();
  for (const [index, name] of names.entries()) {
    if (seen.has(name)) return { name, index };
    seen.add(name);
  }
  return null;
}

function invalid(path: string, problems: readonly PolicyProblem[]): PolicyResolution {
  return { kind: 'invalid', path, problems };
}

function assertNever(value: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}

/**
 * A repository's checks: `.gitstalk/checks.toml` (or, from before the rename,
 * `.beanstalk/checks.toml`; `config-dir.ts` has the rule), read from the exact tree a check runs on
 * (`docs/claude-opus/24-checks-config.md`). One suite per repository, an argv for the runner
 * (never a shell), its environment and time limit, the image it runs in, and the paths a bean
 * may change only when a person with the maintain role pushes it.
 *
 * ```toml
 * image = "node"
 * command = ["node", "--test"]
 * timeout_seconds = 300
 * protected_paths = ["migrations/**"]
 *
 * [env]
 * TZ = "UTC"
 * ```
 *
 * A tree without the file runs the engine's own suite (`node --test` for every repository
 * opened from the registry), as repositories did before this file was read. So does the
 * TypeScript starter's older draft (`[[check]]` tables with a shell `command`), which nothing
 * ever read: reading it changes no repository's behaviour. A file that does not parse or
 * validate is a red check whose message says exactly what is wrong.
 */
import { TomlError, parse } from 'smol-toml';
import { z } from 'zod';

import { configPaths } from './config-dir';
import type { ConfigFile } from './config-dir';
import type { RunSuite } from './suite';
import { DEFAULT_SUITE, suiteCommand } from './suite';

/** Where a repository declares its checks, in lookup order: `.gitstalk/` wins over `.beanstalk/`. */
export const CHECKS_PATHS: readonly string[] = configPaths('checks.toml');

/** The documented place, named in messages about a tree that has no checks file. */
export const CHECKS_PATH = '.gitstalk/checks.toml';

/**
 * Paths no bean changes without a person, whatever the file says: the checks file, in both
 * directories (a bean adding `.gitstalk/checks.toml` would override a `.beanstalk/` one). Not
 * all of `.gitstalk/`: agents tick tasks in `.gitstalk/backlog.md` with ordinary beans
 * (`23-mcp-repository-tools.md`); a repository that wants more lists it in `protected_paths`.
 * The approval rules (`policy.yml`, `policy-file.ts`) are protected the same way: they
 * decide which changes reach a person.
 */
export const ALWAYS_PROTECTED: readonly string[] = [...CHECKS_PATHS, ...configPaths('policy.yml')];

/** Images the runner has; the image ships Node 25.8.1 only (`packages/gateway/container/README.md`). */
export const CHECK_IMAGES = ['node'] as const;
export type CheckImage = (typeof CHECK_IMAGES)[number];

export const DEFAULT_COMMAND: readonly string[] = ['node', '--test'];
export const DEFAULT_TIMEOUT_SECONDS = 300;
export const MAX_TIMEOUT_SECONDS = 1800;
const MAX_FILE_CHARS = 16_000;
const MAX_ARGS = 64;
const MAX_ARG_CHARS = 500;
const MAX_ENV_VARS = 32;
const MAX_PATTERNS = 100;
const MAX_PATTERN_CHARS = 200;
const KNOWN_KEYS = ['image', 'command', 'timeout_seconds', 'protected_paths', 'env'] as const;

/** Variables the runner owns (`packages/gateway/container`, check `env`). */
const REFUSED_ENV_NAMES: ReadonlySet<string> = new Set(['PATH', 'HOME', 'CI']);
const REFUSED_ENV_PREFIXES: readonly string[] = ['GIT_', 'LD_', 'NODE_TEST', 'BWRAP'];

/** A repository's checks as its file declares them, defaults filled in. */
export type ChecksConfig = {
  readonly image: CheckImage;
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeout_seconds: number;
  /** As written; `ALWAYS_PROTECTED` is added by `protectedPatterns`. */
  readonly protected_paths: readonly string[];
};

/** What a tree says about its checks; `path` is the file that says it. */
export type ChecksResolution =
  | { readonly kind: 'missing' }
  /** The starter's older `[[check]]` draft: the engine's own suite runs, as before. */
  | { readonly kind: 'legacy'; readonly path: string }
  | { readonly kind: 'invalid'; readonly path: string; readonly problems: readonly string[] }
  | { readonly kind: 'valid'; readonly path: string; readonly config: ChecksConfig };

const hasNoNul = (text: string): boolean => !text.includes('\0');

const Arg = z
  .string()
  .min(1, 'must not be empty')
  .max(MAX_ARG_CHARS, `must be at most ${MAX_ARG_CHARS} characters`)
  .refine(hasNoNul, 'must not contain NUL');

const Command = z
  .array(Arg, {
    error: 'must be an argv array such as ["node", "--test"]; it never runs through a shell',
  })
  .min(2, 'must name node and --test, such as ["node", "--test"]')
  .max(MAX_ARGS, `must have at most ${MAX_ARGS} arguments`)
  .refine(
    (argv) => argv[0] === 'node',
    'must start with "node": the runner reads node\'s test reporter (other test runners need another image; see /docs/checks)',
  )
  .refine((argv) => argv.includes('--test'), 'must run node --test');

const EnvName = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,63}$/, 'must be an upper-case variable name')
  .refine(
    (name) =>
      !REFUSED_ENV_NAMES.has(name) &&
      !REFUSED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)),
    "is the runner's own (PATH, HOME, CI, GIT_*, LD_*, NODE_TEST*, BWRAP* are refused)",
  );

const Env = z
  .record(
    EnvName,
    z
      .string({ error: 'must be a string' })
      .max(4000, 'must be at most 4000 characters')
      .refine(hasNoNul, 'must not contain NUL'),
    {
      error: (issue) =>
        issue.code === 'invalid_type' ? 'must be a table of NAME = "value"' : undefined,
    },
  )
  .refine((env) => Object.keys(env).length <= MAX_ENV_VARS, `at most ${MAX_ENV_VARS} variables`);

const Pattern = z
  .string({ error: 'must be a string' })
  .min(1, 'must not be empty')
  .max(MAX_PATTERN_CHARS, `must be at most ${MAX_PATTERN_CHARS} characters`)
  .refine((pattern) => !pattern.startsWith('/'), 'is relative to the repository root: drop the /')
  .refine(
    (pattern) => !pattern.split('/').includes('..'),
    'must not contain .. (paths are inside the repository)',
  )
  .refine(hasNoNul, 'must not contain NUL');

const ChecksFile = z.strictObject({
  image: z
    .enum(CHECK_IMAGES, {
      error: (issue) =>
        `${JSON.stringify(issue.input)} is not available: the runner image ships Node 25.8.1 only, so the one image is "node" (see /docs/checks)`,
    })
    .default('node'),
  command: Command.default([...DEFAULT_COMMAND]),
  timeout_seconds: z
    .number({ error: 'must be a number of seconds' })
    .int('must be a whole number of seconds')
    .min(1, 'must be at least 1')
    .max(MAX_TIMEOUT_SECONDS, `must be at most ${MAX_TIMEOUT_SECONDS}`)
    .default(DEFAULT_TIMEOUT_SECONDS),
  protected_paths: z
    .array(Pattern, { error: 'must be an array of path patterns' })
    .max(MAX_PATTERNS, `must have at most ${MAX_PATTERNS} patterns`)
    .default([]),
  env: Env.default({}),
});

/**
 * What `text` (the file's contents, or null when the tree has none), found at `path`, declares.
 * Never throws: every problem becomes a sentence naming its line or key.
 */
export function readChecksConfig(text: string | null, path = CHECKS_PATH): ChecksResolution {
  if (text === null) return { kind: 'missing' };
  if (text.length > MAX_FILE_CHARS)
    return invalid(path, [`${path} is longer than ${MAX_FILE_CHARS} characters`]);
  const table = parseToml(text);
  if (!table.ok) return invalid(path, [table.problem]);
  if (isLegacyDraft(table.value)) return { kind: 'legacy', path };
  const parsed = ChecksFile.safeParse(table.value);
  if (!parsed.success) return invalid(path, parsed.error.issues.map(problemOf));
  return { kind: 'valid', path, config: parsed.data };
}

/** `readChecksConfig` of the file `readFirstPresent(CHECKS_PATHS, ...)` found, or of none. */
export function resolveChecksFile(file: ConfigFile | null): ChecksResolution {
  return file === null ? { kind: 'missing' } : readChecksConfig(file.text, file.path);
}

/** The suite the runner runs for a valid config. */
export function suiteOf(config: ChecksConfig): RunSuite {
  return {
    argv: [...config.command],
    files_argv: filesArgv(config.command),
    env: { ...config.env },
    deps: null,
    timeout_seconds: config.timeout_seconds,
    test_hint: `Run \`${suiteCommand({ argv: [...config.command] })}\`.`,
  };
}

/** Every pattern that protects paths on a tree: the file's own (when valid) and the checks'. */
export function protectedPatterns(resolution: ChecksResolution): readonly string[] {
  const own = resolution.kind === 'valid' ? resolution.config.protected_paths : [];
  return [...ALWAYS_PROTECTED, ...own.filter((pattern) => !ALWAYS_PROTECTED.includes(pattern))];
}

/** The `files` a change touches that one of `patterns` protects, in their order. */
export function protectedChanges(
  files: readonly string[],
  patterns: readonly string[],
): readonly string[] {
  return files.filter((file) => patterns.some((pattern) => matchesPattern(file, pattern)));
}

/**
 * Whether `path` matches a protected-path pattern: `*` is any run of characters within one
 * path segment, `?` one such character, `**` any number of whole segments (none included), and
 * a pattern ending in `/` is everything under that directory. Otherwise the path must equal
 * the pattern (a directory's name alone protects only a file of that name).
 */
export function matchesPattern(path: string, pattern: string): boolean {
  const normalised = pattern.endsWith('/') ? `${pattern}**` : pattern;
  return matchSegments(path.split('/'), normalised.split('/'));
}

/** The suite a tree runs when it declares none (no file, or the older draft): the engine's. */
export type FallbackSuite = Pick<RunSuite, 'argv' | 'timeout_seconds'>;

/**
 * The config in a sentence or two, for `remote:` lines and the web. `fallback` is the engine's
 * own suite, which a tree without a usable declaration runs.
 */
export function describeChecks(
  resolution: ChecksResolution,
  fallback: FallbackSuite = DEFAULT_SUITE,
): readonly string[] {
  const engineSuite = `${suiteCommand(fallback)} (timeout ${fallback.timeout_seconds} s)`;
  switch (resolution.kind) {
    case 'missing':
      return [
        `no ${CHECKS_PATH} on this tree: the repository's default suite runs: ${engineSuite}`,
      ];
    case 'legacy':
      return [
        `${resolution.path} is the older [[check]] draft, which does not choose the suite: the repository's default suite runs: ${engineSuite}`,
        `to choose another, write command = ["node", "--test", ...] at the top level (see /docs/checks)`,
      ];
    case 'invalid':
      return [
        `${resolution.path} is invalid:`,
        ...resolution.problems.map((problem) => `  ${problem}`),
      ];
    case 'valid': {
      const { config } = resolution;
      const env = Object.keys(config.env);
      return [
        `checks from ${resolution.path}: ${suiteCommand({ argv: [...config.command] })} ` +
          `(image ${config.image}, timeout ${config.timeout_seconds} s${env.length === 0 ? '' : `, env ${env.join(', ')}`})`,
      ];
    }
    default:
      return assertNever(resolution);
  }
}

/**
 * The TypeScript starter's draft before the format was read (`[[check]]` with `name`, a shell
 * `command` such as "npm test" and `timeout_seconds`), and nothing else: never read by the
 * engine, so a repository holding it keeps the suite it has always run.
 */
function isLegacyDraft(table: unknown): boolean {
  if (!isRecord(table)) return false;
  const keys = Object.keys(table);
  if (keys.length !== 1 || keys[0] !== 'check') return false;
  const checks = table['check'];
  return (
    Array.isArray(checks) &&
    checks.length > 0 &&
    checks.every(
      (check) =>
        isRecord(check) &&
        typeof check['command'] === 'string' &&
        Object.keys(check).every((key) => LEGACY_CHECK_KEYS.has(key)),
    )
  );
}

const LEGACY_CHECK_KEYS: ReadonlySet<string> = new Set(['name', 'command', 'timeout_seconds']);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(path: string, problems: readonly string[]): ChecksResolution {
  return { kind: 'invalid', path, problems };
}

type Parsed = { ok: true; value: unknown } | { ok: false; problem: string };

function parseToml(text: string): Parsed {
  try {
    return { ok: true, value: parse(text) };
  } catch (error: unknown) {
    if (error instanceof TomlError) {
      const reason = (error.message.split('\n')[0] ?? '').replace(/^Invalid TOML document: /, '');
      return { ok: false, problem: `line ${error.line}, column ${error.column}: ${reason}` };
    }
    return { ok: false, problem: `not valid TOML (${String(error)})` };
  }
}

/** One zod issue as a sentence: `command[0]: must start with "node"…`, `unknown key "comand"`. */
function problemOf(issue: z.core.$ZodIssue): string {
  if (issue.code === 'unrecognized_keys') return issue.keys.map(unknownKey).join('; ');
  const message =
    issue.code === 'invalid_key'
      ? issue.issues.map((inner) => inner.message).join('; ')
      : issue.message;
  const where = keyPath(issue.path);
  return where === '' ? message : `${where}: ${message}`;
}

function unknownKey(key: string): string {
  const near = KNOWN_KEYS.find((known) => editDistance(known, key) <= 2);
  const hint =
    near === undefined ? `the keys are ${KNOWN_KEYS.join(', ')}` : `did you mean "${near}"?`;
  if (key === 'check')
    return 'unknown table [[check]]: write the keys at the top level (command = ["node", "--test"], timeout_seconds, …); one suite per repository';
  return `unknown key "${key}" (${hint})`;
}

function keyPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((text, part) => {
    if (typeof part === 'number') return `${text}[${part}]`;
    const name = String(part);
    return text === '' ? name : `${text}.${name}`;
  }, '');
}

/** Levenshtein distance, for "did you mean" on a misspelt key. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (const [i, charA] of a.split('').entries()) {
    const current = [i + 1];
    for (const [j, charB] of b.split('').entries()) {
      const substitution = (previous[j] ?? 0) + (charA === charB ? 0 : 1);
      current.push(Math.min((previous[j + 1] ?? 0) + 1, (current[j] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** The command for chosen test files: its options, without the test files or globs after `--test`. */
function filesArgv(command: readonly string[]): string[] {
  const testAt = command.indexOf('--test');
  return command.filter((arg, index) => index <= testAt || arg.startsWith('-'));
}

function matchSegments(path: readonly string[], pattern: readonly string[]): boolean {
  const [head, ...rest] = pattern;
  if (head === undefined) return path.length === 0;
  if (head === '**') {
    for (let skip = 0; skip <= path.length; skip += 1) {
      if (matchSegments(path.slice(skip), rest)) return true;
    }
    return false;
  }
  const [segment, ...remaining] = path;
  return segment !== undefined && matchSegment(segment, head) && matchSegments(remaining, rest);
}

function matchSegment(segment: string, pattern: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '[^/]*')
    .replaceAll('?', '[^/]');
  return new RegExp(`^${source}$`, 'u').test(segment);
}

function assertNever(value: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}

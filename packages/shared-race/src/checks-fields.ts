/**
 * What a checks file may say, whichever format it is written in (`checks-yaml.ts` for
 * `.gitstalk/checks.yml`, `checks-toml.ts` for the older `checks.toml`): the one config both
 * read into, its limits, and the validators of each value. The formats differ only in their
 * key names and their syntax, so a repository gets exactly the same checks from either.
 */
import { z } from 'zod';

/** Images the runner has; the image ships Node 25.8.1 only (`packages/gateway/container/README.md`). */
export const CHECK_IMAGES = ['node'] as const;
export type CheckImage = (typeof CHECK_IMAGES)[number];

export const DEFAULT_COMMAND: readonly string[] = ['node', '--test'];
export const DEFAULT_TIMEOUT_SECONDS = 300;
export const MAX_TIMEOUT_SECONDS = 1800;
export const MAX_FILE_CHARS = 16_000;
const MAX_ARGS = 64;
const MAX_ARG_CHARS = 500;
const MAX_ENV_VARS = 32;
const MAX_PATTERNS = 100;
const MAX_PATTERN_CHARS = 200;

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

/** What one format's reader makes of a file's text (`checks-config.ts` adds where it was). */
export type ChecksRead =
  /** The TypeScript starter's older `[[check]]` draft: the engine's own suite runs, as before. */
  | { readonly kind: 'legacy' }
  | { readonly kind: 'invalid'; readonly problems: readonly string[] }
  | { readonly kind: 'valid'; readonly config: ChecksConfig };

const hasNoNul = (text: string): boolean => !text.includes('\0');

/** The one image; `node` is the default. */
export const Image = z
  .enum(CHECK_IMAGES, {
    error: (issue) =>
      `${JSON.stringify(issue.input)} is not available: the runner image ships Node 25.8.1 only, so the one image is "node" (see /docs/checks)`,
  })
  .default('node');

/** The suite's argv; `notAList` says what a value that is not a list of strings should be. */
export function commandOf(notAList: string, notAString: string) {
  const arg = z
    .string({ error: notAString })
    .min(1, 'must not be empty')
    .max(MAX_ARG_CHARS, `must be at most ${MAX_ARG_CHARS} characters`)
    .refine(hasNoNul, 'must not contain NUL');
  return z
    .array(arg, { error: notAList })
    .min(2, 'must name node and --test, such as ["node", "--test"]')
    .max(MAX_ARGS, `must have at most ${MAX_ARGS} arguments`)
    .refine(
      (argv) => argv[0] === 'node',
      'must start with "node": the runner reads node\'s test reporter (other test runners need another image; see /docs/checks)',
    )
    .refine((argv) => argv.includes('--test'), 'must run node --test')
    .default([...DEFAULT_COMMAND]);
}

const EnvName = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,63}$/, 'must be an upper-case variable name')
  .refine(
    (name) =>
      !REFUSED_ENV_NAMES.has(name) &&
      !REFUSED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)),
    "is the runner's own (PATH, HOME, CI, GIT_*, LD_*, NODE_TEST*, BWRAP* are refused)",
  );

/** The suite's environment; `notAMap` and `notAString` say what the format expects. */
export function envOf(notAMap: string, notAString: string) {
  return z
    .record(
      EnvName,
      z
        .string({ error: notAString })
        .max(4000, 'must be at most 4000 characters')
        .refine(hasNoNul, 'must not contain NUL'),
      { error: (issue) => (issue.code === 'invalid_type' ? notAMap : undefined) },
    )
    .refine((env) => Object.keys(env).length <= MAX_ENV_VARS, `at most ${MAX_ENV_VARS} variables`)
    .default({});
}

/** A whole number of seconds within the runner's limit. */
export const Seconds = z
  .number({ error: 'must be a number of seconds' })
  .int('must be a whole number of seconds')
  .min(1, 'must be at least 1')
  .max(MAX_TIMEOUT_SECONDS, `must be at most ${MAX_TIMEOUT_SECONDS}`);

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

/** The paths a bean changes only when a maintainer pushes it. */
export const ProtectedPaths = z
  .array(Pattern, { error: 'must be a list of path patterns' })
  .max(MAX_PATTERNS, `must have at most ${MAX_PATTERNS} patterns`)
  .default([]);

/** A zod path as a field name: `env.PATH`, `run[0]`. */
export function keyPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((text, part) => {
    if (typeof part === 'number') return `${text}[${part}]`;
    const name = String(part);
    return text === '' ? name : `${text}.${name}`;
  }, '');
}

/** The one of `known` a misspelt `key` most likely meant (within two edits), if any. */
export function nearestKey(known: readonly string[], key: string): string | undefined {
  return known.find((candidate) => editDistance(candidate, key) <= 2);
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

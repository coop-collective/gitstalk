/**
 * The checks file's older format, `checks.toml`, still read when a tree has no `checks.yml`
 * (`checks-config.ts` has the lookup order; `docs/claude-opus/24-checks-config.md`). Same
 * values as the YAML, with TOML's snake_case keys:
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
 * So does the TypeScript starter's older draft (`[[check]]` tables with a shell `command`),
 * which nothing ever read: it runs the engine's own suite, as it always has.
 */
import { TomlError, parse } from 'smol-toml';
import { z } from 'zod';

import type { ChecksRead } from './checks-fields';
import {
  Image,
  ProtectedPaths,
  Seconds,
  DEFAULT_TIMEOUT_SECONDS,
  commandOf,
  envOf,
  keyPath,
  nearestKey,
} from './checks-fields';

const KNOWN_KEYS = ['image', 'command', 'timeout_seconds', 'protected_paths', 'env'] as const;

const ChecksToml = z.strictObject({
  image: Image,
  command: commandOf(
    'must be an argv array such as ["node", "--test"]; it never runs through a shell',
    'must be a string',
  ),
  timeout_seconds: Seconds.default(DEFAULT_TIMEOUT_SECONDS),
  protected_paths: ProtectedPaths,
  env: envOf('must be a table of NAME = "value"', 'must be a string'),
});

/** What a `checks.toml`'s text declares. Never throws: every problem names its line or key. */
export function readChecksToml(text: string): ChecksRead {
  const table = parseToml(text);
  if (!table.ok) return { kind: 'invalid', problems: [table.problem] };
  if (isLegacyDraft(table.value)) return { kind: 'legacy' };
  const parsed = ChecksToml.safeParse(table.value);
  if (!parsed.success) return { kind: 'invalid', problems: parsed.error.issues.map(problemOf) };
  return { kind: 'valid', config: parsed.data };
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
  if (key === 'check')
    return 'unknown table [[check]]: write the keys at the top level (command = ["node", "--test"], timeout_seconds, …); one suite per repository';
  const near = nearestKey(KNOWN_KEYS, key);
  const hint =
    near === undefined ? `the keys are ${KNOWN_KEYS.join(', ')}` : `did you mean "${near}"?`;
  return `unknown key "${key}" (${hint})`;
}

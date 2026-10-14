/**
 * A repository's checks in YAML: `.gitstalk/checks.yml` (`docs/claude-opus/24-checks-config.md`),
 * like every other file in `.gitstalk/` (policy.yml, automations/*.yml) and named the way
 * GitHub Actions names the same things (`timeout-minutes`, `env`, kebab-case keys). Parsed as
 * strictly as the approval rules (`strict-yaml.ts`), and a JSON Schema generated from the same
 * Zod schema gives editors completion:
 *
 * ```yaml
 * # yaml-language-server: $schema=https://gitstalk.dev/schemas/checks.json
 * image: node
 * timeout-minutes: 2
 * env:
 *   TZ: UTC
 * run: [node, --test, "test/*.test.ts"]
 * protected-paths:
 *   - migrations/**
 * ```
 *
 * `run` is a list of arguments, never a string. In Actions a `run:` string is a shell script;
 * here nothing runs through a shell, so a string would either mean something different from the
 * same text in a workflow (no pipes, no `&&`, no quoting rules) or need a splitting rule of our
 * own. A list says exactly which argv the runner starts, and a string is refused with why.
 */
import { Document, isSeq } from 'yaml';
import { z } from 'zod';

import type { ChecksConfig, ChecksRead } from './checks-fields';
import {
  DEFAULT_TIMEOUT_SECONDS,
  Image,
  MAX_TIMEOUT_SECONDS,
  ProtectedPaths,
  Seconds,
  commandOf,
  envOf,
  keyPath,
  nearestKey,
} from './checks-fields';
import { readChecksToml } from './checks-toml';
import { parseStrictYaml, yamlPathOf } from './strict-yaml';
import type { YamlLocator, YamlPosition } from './strict-yaml';

/** Where the published JSON Schema lives, for the `yaml-language-server` first line. */
export const CHECKS_SCHEMA_URL = 'https://gitstalk.dev/schemas/checks.json';

const KNOWN_KEYS = [
  'image',
  'run',
  'timeout-minutes',
  'timeout-seconds',
  'env',
  'protected-paths',
] as const;

/** `checks.toml`'s spellings, which a file moved from TOML may still use. */
const TOML_SPELLINGS: Readonly<Record<string, string>> = {
  command: 'run',
  timeout_seconds: 'timeout-seconds',
  protected_paths: 'protected-paths',
};

/** Workflow keys: one suite per repository here; workflows live elsewhere. */
const WORKFLOW_KEYS: ReadonlySet<string> = new Set(['jobs', 'steps', 'on', 'runs-on', 'name']);

const NOT_A_STRING =
  'must be a string: put it in quotes (YAML reads unquoted numbers, true, false and null as other types)';

const Minutes = z
  .number({ error: 'must be a number of minutes' })
  .positive('must be more than 0')
  .max(
    MAX_TIMEOUT_SECONDS / 60,
    `must be at most ${MAX_TIMEOUT_SECONDS / 60} (${MAX_TIMEOUT_SECONDS} s)`,
  )
  .refine(
    isWholeSeconds,
    'must come to a whole number of seconds (0.5 is 30 s); for anything finer, write timeout-seconds',
  );

/** The file's schema; `CHECKS_JSON_SCHEMA` is generated from it. */
export const ChecksYamlFile = z.strictObject(
  {
    image: Image,
    'timeout-minutes': Minutes.optional(),
    'timeout-seconds': Seconds.optional(),
    env: envOf('must be a map of NAME: value', NOT_A_STRING),
    run: commandOf(
      'must be a list of arguments such as [node, --test]; it never runs through a shell, so a string such as "npm test" is refused',
      NOT_A_STRING,
    ),
    'protected-paths': ProtectedPaths,
  },
  {
    error: (issue) =>
      issue.code === 'invalid_type'
        ? 'must be a map of keys such as run: [node, --test] (see /docs/checks)'
        : undefined,
  },
);
export type ChecksYamlInput = z.input<typeof ChecksYamlFile>;

/** The JSON Schema of the file, for editors (`# yaml-language-server: $schema=...`). */
export const CHECKS_JSON_SCHEMA: Readonly<Record<string, unknown>> = z.toJSONSchema(
  ChecksYamlFile,
  { io: 'input' },
);

/**
 * What a `checks.yml`'s text declares. Never throws: every problem is a sentence with its line
 * and column (when the document has them) and its field.
 */
export function readChecksYaml(text: string): ChecksRead {
  const document = parseStrictYaml(text);
  if (!document.ok)
    return {
      kind: 'invalid',
      problems: document.problems.map((problem) => sentence(problem.position, '', problem.message)),
    };
  const parsed = ChecksYamlFile.safeParse(document.value ?? {});
  if (!parsed.success)
    return {
      kind: 'invalid',
      problems: parsed.error.issues
        .flatMap((issue) => problemsOf(issue, document.at))
        .toSorted(inFileOrder)
        .map((problem) => problem.text),
    };
  const file = parsed.data;
  if (file['timeout-minutes'] !== undefined && file['timeout-seconds'] !== undefined)
    return {
      kind: 'invalid',
      problems: [
        sentence(
          document.at.key(['timeout-seconds']),
          'timeout-seconds',
          'write timeout-minutes or timeout-seconds, not both',
        ),
      ],
    };
  return { kind: 'valid', config: configOf(file) };
}

/**
 * The config as a `checks.yml`, with the schema line first: what the starters write and what a
 * `checks.toml` converts to. `readChecksYaml` reads it back equal.
 */
export function writeChecksYaml(config: ChecksConfig): string {
  const seconds = config.timeout_seconds;
  const document = new Document(
    {
      image: config.image,
      ...(seconds % 60 === 0
        ? { 'timeout-minutes': seconds / 60 }
        : { 'timeout-seconds': seconds }),
      ...(Object.keys(config.env).length === 0 ? {} : { env: { ...config.env } }),
      run: [...config.command],
      ...(config.protected_paths.length === 0
        ? {}
        : { 'protected-paths': [...config.protected_paths] }),
    },
    { version: '1.2' },
  );
  const run = document.get('run', true);
  if (isSeq(run)) run.flow = true;
  return `# yaml-language-server: $schema=${CHECKS_SCHEMA_URL}\n${document.toString({ lineWidth: 0 })}`;
}

/** A conversion of a `checks.toml`: the equivalent `checks.yml`, or why there is none. */
export type ChecksConversion =
  | { readonly ok: true; readonly yaml: string }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * The `checks.yml` that declares exactly what a `checks.toml`'s text does. Comments are not
 * carried over. An invalid file, or the starter's older draft (which chooses no suite), has no
 * equivalent: converting either would change what the repository runs.
 */
export function tomlChecksToYaml(toml: string): ChecksConversion {
  const read = readChecksToml(toml);
  switch (read.kind) {
    case 'valid':
      return { ok: true, yaml: writeChecksYaml(read.config) };
    case 'legacy':
      return {
        ok: false,
        problems: [
          'this is the older [[check]] draft, which chooses no suite, so there is nothing to convert: delete it, or write .gitstalk/checks.yml with run: [node, --test, ...]',
        ],
      };
    case 'invalid':
      return { ok: false, problems: read.problems };
    default:
      return assertNever(read);
  }
}

type ChecksYamlFile = z.output<typeof ChecksYamlFile>;

function configOf(file: ChecksYamlFile): ChecksConfig {
  const minutes = file['timeout-minutes'];
  return {
    image: file.image,
    command: file.run,
    env: file.env,
    timeout_seconds:
      minutes === undefined
        ? (file['timeout-seconds'] ?? DEFAULT_TIMEOUT_SECONDS)
        : Math.round(minutes * 60),
    protected_paths: file['protected-paths'],
  };
}

function isWholeSeconds(minutes: number): boolean {
  const seconds = minutes * 60;
  return Math.abs(seconds - Math.round(seconds)) < 1e-9;
}

type Located = { readonly position: YamlPosition | null; readonly text: string };

/** One zod issue as sentences, one per unknown key, each where it is in the file. */
function problemsOf(issue: z.core.$ZodIssue, where: YamlLocator): readonly Located[] {
  const path = yamlPathOf(issue.path);
  if (issue.code === 'unrecognized_keys')
    return issue.keys.map((key) => located(where.key([...path, key]), '', unknownKey(key)));
  const message =
    issue.code === 'invalid_key'
      ? issue.issues.map((inner) => inner.message).join('; ')
      : issue.message;
  const position = issue.code === 'invalid_key' ? where.key(path) : where.value(path);
  return [located(position, keyPath(issue.path), message)];
}

function located(position: YamlPosition | null, field: string, message: string): Located {
  return { position, text: sentence(position, field, message) };
}

/** By line, then column; a problem with no position after those with one. */
function inFileOrder(a: Located, b: Located): number {
  const lineOf = (problem: Located) => problem.position?.line ?? Number.MAX_SAFE_INTEGER;
  const columnOf = (problem: Located) => problem.position?.column ?? 0;
  return lineOf(a) - lineOf(b) || columnOf(a) - columnOf(b);
}

function unknownKey(key: string): string {
  const toml = TOML_SPELLINGS[key];
  if (toml !== undefined) return `unknown key "${key}": checks.yml spells it "${toml}"`;
  if (WORKFLOW_KEYS.has(key))
    return `unknown key "${key}": checks.yml declares one suite (image, run, env, …); workflows go in .github/workflows/ or .gitstalk/automations/`;
  const near = nearestKey(KNOWN_KEYS, key);
  const hint =
    near === undefined ? `the keys are ${KNOWN_KEYS.join(', ')}` : `did you mean "${near}"?`;
  return `unknown key "${key}" (${hint})`;
}

/** `line 3, column 5: run[0]: must start with "node"…`, leaving out what is not known. */
function sentence(position: YamlPosition | null, field: string, message: string): string {
  const where = position === null ? '' : `line ${position.line}, column ${position.column}: `;
  return `${where}${field === '' ? '' : `${field}: `}${message}`;
}

function assertNever(value: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}

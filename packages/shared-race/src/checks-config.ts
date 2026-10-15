/**
 * A repository's checks: `.gitstalk/checks.yml`, read from the exact tree a check runs on
 * (`docs/claude-opus/24-checks-config.md`). One suite per repository, an argv for the runner
 * (never a shell), its environment and time limit, the image it runs in, and the paths a bean
 * may change only when a person with the maintain role pushes it. The format is
 * `checks-yaml.ts`; the older `checks.toml` (`checks-toml.ts`) is still read, and so is
 * `.beanstalk/` from before the rename (`config-dir.ts`).
 *
 * A tree without the file runs the engine's own suite (`node --test` for every repository
 * opened from the registry), as repositories did before this file was read. So does the
 * TypeScript starter's older TOML draft (`[[check]]` tables with a shell `command`), which
 * nothing ever read. A file that does not parse or validate is a red check whose message says
 * exactly what is wrong.
 */
import { CONFIG_DIRS, configPaths } from './config-dir';
import type { ConfigFile } from './config-dir';
import type { ChecksConfig } from './checks-fields';
import { MAX_FILE_CHARS } from './checks-fields';
import { readChecksToml } from './checks-toml';
import { readChecksYaml } from './checks-yaml';
import type { RunSuite } from './suite';
import { DEFAULT_SUITE, suiteCommand } from './suite';

export type { ChecksConfig } from './checks-fields';

/** The checks file's names in one directory, in lookup order: YAML wins over the older TOML. */
export const CHECKS_FILE_NAMES: readonly string[] = ['checks.yml', 'checks.yaml', 'checks.toml'];

/**
 * Where a repository declares its checks, in lookup order: `.gitstalk/checks.yml`, then
 * `.gitstalk/checks.yaml`, then `.gitstalk/checks.toml`, then the same three in `.beanstalk/`.
 */
export const CHECKS_PATHS: readonly string[] = CONFIG_DIRS.flatMap((dir) =>
  CHECKS_FILE_NAMES.map((name) => `${dir}/${name}`),
);

/** The documented place: where new files are written, named in messages about a tree without one. */
export const CHECKS_PATH = '.gitstalk/checks.yml';

/**
 * Paths no bean changes without a person, whatever the file says: every checks file name, in
 * both directories and both formats (a bean adding `.gitstalk/checks.yml` would override a TOML
 * one). Not all of `.gitstalk/`: agents tick tasks in `.gitstalk/backlog.md` with ordinary beans
 * (`23-mcp-repository-tools.md`); a repository that wants more lists it in `protected-paths`.
 * The approval rules (`policy.yml`, `policy-file.ts`) are protected the same way: they
 * decide which changes reach a person.
 */
export const ALWAYS_PROTECTED: readonly string[] = [...CHECKS_PATHS, ...configPaths('policy.yml')];

/** Other checks files on the tree, after the one read in `CHECKS_PATHS`; absent when none. */
type Shadows = { readonly shadowed?: readonly string[] };

/** A checks file as found on a tree, with the other checks files it shadows there. */
export type ChecksFile = ConfigFile & Shadows;

/** What a tree says about its checks; `path` is the file that says it. */
export type ChecksResolution =
  | { readonly kind: 'missing' }
  /** The starter's older `[[check]]` draft: the engine's own suite runs, as before. */
  | ({ readonly kind: 'legacy'; readonly path: string } & Shadows)
  | ({
      readonly kind: 'invalid';
      readonly path: string;
      readonly problems: readonly string[];
    } & Shadows)
  | ({ readonly kind: 'valid'; readonly path: string; readonly config: ChecksConfig } & Shadows);

/**
 * What `text` (the file's contents, or null when the tree has none), found at `path`, declares:
 * TOML for a `.toml` path, YAML otherwise. Never throws: every problem becomes a sentence
 * naming its line or key.
 */
export function readChecksConfig(text: string | null, path = CHECKS_PATH): ChecksResolution {
  if (text === null) return { kind: 'missing' };
  if (text.length > MAX_FILE_CHARS)
    return {
      kind: 'invalid',
      path,
      problems: [`${path} is longer than ${MAX_FILE_CHARS} characters`],
    };
  const read = isTomlChecks(path) ? readChecksToml(text) : readChecksYaml(text);
  return { ...read, path };
}

/** Whether `path` is a checks file in the older TOML format. */
export function isTomlChecks(path: string): boolean {
  return path.endsWith('.toml');
}

/**
 * The checks file of a tree (`read` answers null for an absent path): the first of
 * `CHECKS_PATHS` it has, naming every later one it also has. All are read at once, so the
 * fallbacks cost no extra round trip.
 */
export async function readChecksFile(
  read: (path: string) => Promise<string | null>,
): Promise<ChecksFile | null> {
  const texts = await Promise.all(CHECKS_PATHS.map(read));
  const present = CHECKS_PATHS.flatMap((path, index) => {
    const text = texts[index];
    return text === null || text === undefined ? [] : [{ path, text }];
  });
  const [first, ...rest] = present;
  if (first === undefined) return null;
  return rest.length === 0 ? first : { ...first, shadowed: rest.map((file) => file.path) };
}

/** `readChecksConfig` of the file `readChecksFile` found, or of none. */
export function resolveChecksFile(file: ChecksFile | null): ChecksResolution {
  if (file === null) return { kind: 'missing' };
  const resolution = readChecksConfig(file.text, file.path);
  const shadowed = file.shadowed ?? [];
  return resolution.kind === 'missing' || shadowed.length === 0
    ? resolution
    : { ...resolution, shadowed };
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
 * own suite, which a tree without a usable declaration runs. A TOML file read says YAML is the
 * format now; another checks file beside the one read says it is ignored and can go.
 */
export function describeChecks(
  resolution: ChecksResolution,
  fallback: FallbackSuite = DEFAULT_SUITE,
): readonly string[] {
  if (resolution.kind === 'missing') {
    const engineSuite = `${suiteCommand(fallback)} (timeout ${fallback.timeout_seconds} s)`;
    return [`no ${CHECKS_PATH} on this tree: the repository's default suite runs: ${engineSuite}`];
  }
  return [
    ...describeFile(resolution, fallback),
    ...shadowLines(resolution.path, resolution.shadowed ?? []),
  ];
}

function describeFile(
  resolution: Exclude<ChecksResolution, { readonly kind: 'missing' }>,
  fallback: FallbackSuite,
): readonly string[] {
  const engineSuite = `${suiteCommand(fallback)} (timeout ${fallback.timeout_seconds} s)`;
  switch (resolution.kind) {
    case 'legacy':
      return [
        `${resolution.path} is the older [[check]] draft, which does not choose the suite: the repository's default suite runs: ${engineSuite}`,
        `to choose another, write ${CHECKS_PATH} with run: [node, --test, ...] (see /docs/checks)`,
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
        ...(isTomlChecks(resolution.path)
          ? [
              `TOML still works; ${CHECKS_PATH} is the format now (Settings → Checks converts it in one click)`,
            ]
          : []),
      ];
    }
    default:
      return assertNever(resolution);
  }
}

function shadowLines(read: string, shadowed: readonly string[]): readonly string[] {
  return shadowed.map(
    (path) =>
      `${path} is also on this tree and is not read (${read} wins): delete it (git rm ${path})`,
  );
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

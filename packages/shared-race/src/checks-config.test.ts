import * as fc from 'fast-check';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';

import type { ChecksConfig } from './checks-config';
import {
  ALWAYS_PROTECTED,
  CHECKS_PATH,
  CHECKS_PATHS,
  describeChecks,
  matchesPattern,
  protectedChanges,
  protectedPatterns,
  readChecksConfig,
  readChecksFile,
  resolveChecksFile,
  suiteOf,
} from './checks-config';
import { writeChecksYaml } from './checks-yaml';
import { RunSuite } from './suite';

function problems(text: string, path = CHECKS_PATH): readonly string[] {
  const resolution = readChecksConfig(text, path);
  if (resolution.kind !== 'invalid') throw new Error(`expected invalid, got ${resolution.kind}`);
  return resolution.problems;
}

function config(text: string, path = CHECKS_PATH): ChecksConfig {
  const resolution = readChecksConfig(text, path);
  if (resolution.kind !== 'valid') throw new Error(`expected valid: ${JSON.stringify(resolution)}`);
  return resolution.config;
}

/** The file a config is written as, in YAML's key names, for building variations of it. */
function yamlInput(valid: ChecksConfig): Record<string, unknown> {
  return {
    image: valid.image,
    run: [...valid.command],
    'timeout-seconds': valid.timeout_seconds,
    env: { ...valid.env },
    'protected-paths': [...valid.protected_paths],
  };
}

describe('reading .gitstalk/checks.yml', () => {
  it("says a tree without the file runs the repository's default suite, never no checks", () => {
    expect(readChecksConfig(null)).toEqual({ kind: 'missing' });
    expect(describeChecks({ kind: 'missing' })).toEqual([
      "no .gitstalk/checks.yml on this tree: the repository's default suite runs: node --test (timeout 300 s)",
    ]);
  });

  it('fills in the defaults for an empty file, or one of comments only', () => {
    const defaults = {
      image: 'node',
      command: ['node', '--test'],
      env: {},
      timeout_seconds: 300,
      protected_paths: [],
    };
    expect(config('')).toEqual(defaults);
    expect(config('# yaml-language-server: $schema=x\n')).toEqual(defaults);
  });

  it('reads every key', () => {
    const text = [
      '# yaml-language-server: $schema=https://gitstalk.dev/schemas/checks.json',
      'image: node',
      'timeout-minutes: 1.5',
      'env:',
      '  TZ: UTC',
      'run: [node, --test, "spec/**/*.spec.mjs"]',
      'protected-paths:',
      '  - migrations/**',
      '  - LICENSE',
    ].join('\n');
    expect(config(text)).toEqual({
      image: 'node',
      command: ['node', '--test', 'spec/**/*.spec.mjs'],
      env: { TZ: 'UTC' },
      timeout_seconds: 90,
      protected_paths: ['migrations/**', 'LICENSE'],
    });
  });

  it('takes run as a block list as well as a flow list', () => {
    expect(config('run:\n  - node\n  - --test\n  - test/\n').command).toEqual([
      'node',
      '--test',
      'test/',
    ]);
  });

  it('names the line and column of a syntax error', () => {
    expect(problems('image: node\nrun: [node, --test\n')[0]).toMatch(/^line \d+, column \d+: /);
  });

  it('names the line, column and field of a value the schema refuses', () => {
    expect(problems('image: node\n\nrun: [cargo, test]\n')[0]).toMatch(
      /^line 3, column 6: run: must start with "node"/,
    );
  });

  it('refuses a shell string and says why', () => {
    expect(problems('run: npm test')).toEqual([
      'line 1, column 6: run: must be a list of arguments such as [node, --test]; it never runs through a shell, so a string such as "npm test" is refused',
    ]);
  });

  it('refuses a number or boolean where a string goes, rather than guessing its spelling', () => {
    expect(problems('run: [node, --test, 1]')).toEqual([
      'line 1, column 21: run[2]: must be a string: put it in quotes (YAML reads unquoted numbers, true, false and null as other types)',
    ]);
    expect(problems('env:\n  VERSION: 1.10\n')[0]).toMatch(
      /^line 2, column 12: env\.VERSION: must be a string/,
    );
    expect(config('env:\n  VERSION: "1.10"\n').env).toEqual({ VERSION: '1.10' });
  });

  it('refuses a command that does not run node --test', () => {
    expect(problems('run: [cargo, test]')[0]).toMatch(/run: must start with "node"/);
    expect(problems('run: [node, test.js]')).toEqual([
      'line 1, column 6: run: must run node --test',
    ]);
  });

  it('refuses an image the runner does not have, naming the one it has', () => {
    expect(problems('image: rust')[0]).toMatch(
      /^line 1, column 8: image: "rust" is not available: the runner image ships Node 25\.8\.1 only/,
    );
  });

  it('maps timeout-minutes to seconds, and refuses minutes that are not whole seconds', () => {
    expect(config('timeout-minutes: 2').timeout_seconds).toBe(120);
    expect(config('timeout-minutes: 0.25').timeout_seconds).toBe(15);
    expect(config('timeout-minutes: 0.1').timeout_seconds).toBe(6);
    expect(config('timeout-seconds: 45').timeout_seconds).toBe(45);
    expect(problems('timeout-minutes: 0.01')[0]).toContain(
      'timeout-minutes: must come to a whole number of seconds (0.5 is 30 s); for anything finer, write timeout-seconds',
    );
    expect(problems('timeout-minutes: 31')[0]).toContain('timeout-minutes: must be at most 30');
    expect(problems('timeout-minutes: 0')[0]).toContain('timeout-minutes: must be more than 0');
  });

  it('refuses timeout-minutes and timeout-seconds together', () => {
    expect(problems('timeout-minutes: 1\ntimeout-seconds: 60\n')).toEqual([
      'line 2, column 1: timeout-seconds: write timeout-minutes or timeout-seconds, not both',
    ]);
  });

  it('suggests the key a misspelling meant, and the YAML spelling of a TOML key', () => {
    expect(problems('rnu: [node, --test]')).toEqual([
      'line 1, column 1: unknown key "rnu" (did you mean "run"?)',
    ]);
    expect(problems('timeout_minutes: 2')).toEqual([
      'line 1, column 1: unknown key "timeout_minutes" (did you mean "timeout-minutes"?)',
    ]);
    expect(problems('image: node\ncommand: [node, --test]')).toEqual([
      'line 2, column 1: unknown key "command": checks.yml spells it "run"',
    ]);
    expect(problems('protected_paths: [a]')[0]).toContain('checks.yml spells it "protected-paths"');
  });

  it('points a workflow written here at the folders workflows live in', () => {
    expect(problems('jobs:\n  test:\n    runs-on: ubuntu-latest\n')[0]).toContain(
      'workflows go in .github/workflows/ or .gitstalk/automations/',
    );
  });

  it('refuses anchors, aliases, merge keys and duplicate keys', () => {
    expect(problems('env: &e\n  TZ: UTC\n')[0]).toContain('anchors (&name) are not allowed');
    expect(problems('run: [node, --test]\nrun: [node, --test]\n')[0]).toMatch(
      /^line 2, column 1: /,
    );
    expect(problems('a: &x 1\nenv:\n  <<: *x\n').join('\n')).toContain('not allowed');
  });

  it('refuses a file that is not a map', () => {
    expect(problems('- node\n- --test\n')).toEqual([
      'line 1, column 1: must be a map of keys such as run: [node, --test] (see /docs/checks)',
    ]);
  });

  it("refuses the runner's own variables and other bad values, one problem each", () => {
    const text = [
      'timeout-seconds: 5000',
      'protected-paths: [/abs, ../up]',
      'env:',
      '  PATH: /x',
    ].join('\n');
    expect(problems(text)).toEqual([
      'line 1, column 18: timeout-seconds: must be at most 1800',
      'line 2, column 19: protected-paths[0]: is relative to the repository root: drop the /',
      'line 2, column 25: protected-paths[1]: must not contain .. (paths are inside the repository)',
      "line 4, column 3: env.PATH: is the runner's own (PATH, HOME, CI, GIT_*, LD_*, NODE_TEST*, BWRAP* are refused)",
    ]);
  });

  it('turns a valid config into the suite the runner runs', () => {
    const suite = suiteOf(
      config('run: [node, --no-warnings, --test, --test-concurrency=1, spec/]'),
    );
    expect(suite).toEqual({
      argv: ['node', '--no-warnings', '--test', '--test-concurrency=1', 'spec/'],
      files_argv: ['node', '--no-warnings', '--test', '--test-concurrency=1'],
      env: {},
      deps: null,
      timeout_seconds: 300,
      test_hint: 'Run `node --no-warnings --test --test-concurrency=1 spec/`.',
    });
    expect(RunSuite.parse(suite)).toEqual(suite);
  });

  it('always protects the checks themselves, in every name and format', () => {
    expect(protectedPatterns({ kind: 'missing' })).toEqual(ALWAYS_PROTECTED);
    expect(
      protectedChanges([...CHECKS_PATHS, 'src/a.ts'], protectedPatterns({ kind: 'missing' })),
    ).toEqual(CHECKS_PATHS);
    expect(CHECKS_PATHS).toEqual([
      '.gitstalk/checks.yml',
      '.gitstalk/checks.yaml',
      '.gitstalk/checks.toml',
      '.beanstalk/checks.yml',
      '.beanstalk/checks.yaml',
      '.beanstalk/checks.toml',
    ]);
  });

  it("leaves the rest of .gitstalk/ to ordinary beans: agents tick the backlog's tasks", () => {
    expect(
      protectedChanges(
        ['.gitstalk/backlog.md', '.beanstalk/backlog.md'],
        protectedPatterns({ kind: 'missing' }),
      ),
    ).toEqual([]);
  });
});

function read(files: Readonly<Record<string, string>>) {
  return readChecksFile((path) => Promise.resolve(files[path] ?? null));
}

function RUN(dir: string): string {
  return `run: [node, --test, ${dir}/]\n`;
}

function TOML(dir: string): string {
  return `command = ["node", "--test", "${dir}/"]\n`;
}

describe('which checks file a tree is read from', () => {
  it('reads .gitstalk/checks.yml, then .yaml, then .toml, then the same in .beanstalk/', async () => {
    const all: Record<string, string> = {
      '.gitstalk/checks.yml': RUN('a'),
      '.gitstalk/checks.yaml': RUN('b'),
      '.gitstalk/checks.toml': TOML('c'),
      '.beanstalk/checks.yml': RUN('d'),
      '.beanstalk/checks.yaml': RUN('e'),
      '.beanstalk/checks.toml': TOML('f'),
    };
    const order = Object.keys(all);
    for (const [index, path] of order.entries()) {
      const present = Object.fromEntries(order.slice(index).map((key) => [key, all[key] ?? '']));
      // oxlint-disable-next-line no-await-in-loop -- each tree is read on its own, in order
      const resolution = resolveChecksFile(await read(present));
      expect(resolution).toMatchObject({ kind: 'valid', path });
      if (resolution.kind === 'valid')
        expect(resolution.config.command.at(-1)).toBe(`${'abcdef'[index] ?? ''}/`);
    }
  });

  it('reads YAML over TOML, and the push is told to delete the TOML', async () => {
    const resolution = resolveChecksFile(
      await read({ '.gitstalk/checks.yml': RUN('new'), '.gitstalk/checks.toml': TOML('old') }),
    );
    expect(resolution).toMatchObject({
      kind: 'valid',
      path: '.gitstalk/checks.yml',
      shadowed: ['.gitstalk/checks.toml'],
    });
    expect(describeChecks(resolution)).toEqual([
      'checks from .gitstalk/checks.yml: node --test new/ (image node, timeout 300 s)',
      '.gitstalk/checks.toml is also on this tree and is not read (.gitstalk/checks.yml wins): delete it (git rm .gitstalk/checks.toml)',
    ]);
  });

  it('says so even when the YAML that wins is invalid', async () => {
    const resolution = resolveChecksFile(
      await read({
        '.gitstalk/checks.yml': 'run: npm test\n',
        '.beanstalk/checks.toml': TOML('x'),
      }),
    );
    expect(describeChecks(resolution).at(-1)).toBe(
      '.beanstalk/checks.toml is also on this tree and is not read (.gitstalk/checks.yml wins): delete it (git rm .beanstalk/checks.toml)',
    );
  });

  it('reads a lone TOML file, names it, and says YAML is the format now', async () => {
    const resolution = resolveChecksFile(await read({ '.beanstalk/checks.toml': TOML('spec') }));
    expect(resolution).toMatchObject({ kind: 'valid', path: '.beanstalk/checks.toml' });
    expect('shadowed' in resolution).toBe(false);
    expect(describeChecks(resolution)).toEqual([
      'checks from .beanstalk/checks.toml: node --test spec/ (image node, timeout 300 s)',
      'TOML still works; .gitstalk/checks.yml is the format now (Settings → Checks converts it in one click)',
    ]);
  });

  it('names the file it read when that file is invalid', () => {
    expect(
      describeChecks(readChecksConfig('command = "npm test"\n', '.beanstalk/checks.toml'))[0],
    ).toBe('.beanstalk/checks.toml is invalid:');
    expect(describeChecks(readChecksConfig('run: npm test\n', '.gitstalk/checks.yaml'))[0]).toBe(
      '.gitstalk/checks.yaml is invalid:',
    );
  });

  it('is null for a tree with none', async () => {
    expect(await read({})).toBeNull();
    expect(resolveChecksFile(null)).toEqual({ kind: 'missing' });
  });
});

describe('protected-path patterns', () => {
  it.each([
    ['migrations/0001.sql', 'migrations/**', true],
    ['migrations/a/b.sql', 'migrations/', true],
    ['migrations', 'migrations/**', true],
    ['src/migrations/x.sql', 'migrations/**', false],
    ['src/migrations/x.sql', '**/migrations/*.sql', true],
    ['db/schema.sql', '*.sql', false],
    ['schema.sql', '*.sql', true],
    ['LICENSE', 'LICENSE', true],
    ['LICENSE.md', 'LICENSE', false],
    ['a.b', 'a?b', true],
  ])('%s against %s is %s', (path, pattern, expected) => {
    expect(matchesPattern(path, pattern)).toBe(expected);
  });
});

const SEGMENT = fc.stringMatching(/^[a-z0-9_-][a-z0-9_.-]{0,11}$/);
const PATH = fc.array(SEGMENT, { minLength: 1, maxLength: 5 }).map((parts) => parts.join('/'));
const ARG = fc.stringMatching(/^[A-Za-z0-9_./=*-]{1,20}$/);
const ENV_NAME = fc
  .stringMatching(/^[A-Z][A-Z0-9_]{0,15}$/)
  .filter((name) => !['PATH', 'HOME', 'CI'].includes(name))
  .filter((name) => !['GIT_', 'LD_', 'NODE_TEST', 'BWRAP'].some((p) => name.startsWith(p)));
const VALID_CONFIG: fc.Arbitrary<ChecksConfig> = fc.record({
  image: fc.constant('node' as const),
  command: fc
    .tuple(fc.array(ARG, { maxLength: 4 }), fc.array(ARG, { maxLength: 4 }))
    .map(([before, after]) => ['node'].concat(before, ['--test'], after)),
  env: fc.dictionary(
    ENV_NAME,
    fc.string({ maxLength: 40 }).filter((v) => !v.includes('\0')),
    { maxKeys: 6 },
  ),
  timeout_seconds: fc.integer({ min: 1, max: 1800 }),
  protected_paths: fc.array(PATH, { maxLength: 6 }),
});

describe('properties', () => {
  it('reads back every valid config it is written as', () => {
    fc.assert(
      fc.property(VALID_CONFIG, (expected) => {
        expect(readChecksConfig(writeChecksYaml(expected))).toEqual({
          kind: 'valid',
          path: CHECKS_PATH,
          config: expected,
        });
        expect(readChecksConfig(stringify(yamlInput(expected)))).toEqual({
          kind: 'valid',
          path: CHECKS_PATH,
          config: expected,
        });
      }),
    );
  });

  it('never throws, and an invalid answer always says why', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.string({ unit: 'binary' })), (text) => {
        const resolution = readChecksConfig(text);
        if (resolution.kind === 'invalid') {
          expect(resolution.problems.length).toBeGreaterThan(0);
          for (const problem of resolution.problems) expect(problem.trim()).not.toBe('');
        } else {
          expect(resolution.kind).toBe('valid');
        }
      }),
    );
  });

  it('names any unknown key it refuses', () => {
    const taken = new Set([
      'image',
      'run',
      'timeout-minutes',
      'timeout-seconds',
      'env',
      'protected-paths',
      'null',
      'true',
      'false',
    ]);
    const unknown = fc.stringMatching(/^[a-z][a-z_-]{2,14}$/).filter((key) => !taken.has(key));
    fc.assert(
      fc.property(VALID_CONFIG, unknown, (valid, key) => {
        const found = problems(stringify({ ...yamlInput(valid), [key]: 1 }));
        expect(found.join('\n')).toContain(`"${key}"`);
      }),
    );
  });

  it("refuses every one of the runner's own variables by name", () => {
    const owned = fc.oneof(
      fc.constantFrom('PATH', 'HOME', 'CI'),
      fc
        .tuple(
          fc.constantFrom('GIT_', 'LD_', 'NODE_TEST', 'BWRAP'),
          fc.stringMatching(/^[A-Z0-9_]{0,8}$/),
        )
        .map(([prefix, rest]) => `${prefix}${rest}`),
    );
    fc.assert(
      fc.property(VALID_CONFIG, owned, (valid, name) => {
        const found = problems(
          stringify({ ...yamlInput(valid), env: { ...valid.env, [name]: 'x' } }),
        );
        expect(found.join('\n')).toContain(
          `env.${name}: is the runner's own (PATH, HOME, CI, GIT_*, LD_*, NODE_TEST*, BWRAP* are refused)`,
        );
      }),
    );
  });

  it('gives a suite the runner contract accepts for every valid config', () => {
    fc.assert(
      fc.property(VALID_CONFIG, (valid) => {
        const suite = suiteOf(valid);
        expect(RunSuite.safeParse(suite).success).toBe(true);
        expect(suite.files_argv.every((arg) => valid.command.includes(arg))).toBe(true);
      }),
    );
  });

  it('protects everything under a directory pattern and nothing beside it', () => {
    fc.assert(
      fc.property(SEGMENT, PATH, SEGMENT, (directory, inside, sibling) => {
        fc.pre(sibling !== directory);
        expect(matchesPattern(`${directory}/${inside}`, `${directory}/**`)).toBe(true);
        expect(matchesPattern(`${directory}/${inside}`, `${directory}/`)).toBe(true);
        expect(matchesPattern(`${sibling}/${inside}`, `${directory}/**`)).toBe(false);
      }),
    );
  });

  it('matches a path that is its own pattern, and * never crosses a /', () => {
    fc.assert(
      fc.property(PATH, (path) => {
        fc.pre(!/[*?]/.test(path));
        expect(matchesPattern(path, path)).toBe(true);
        expect(matchesPattern(path, '*')).toBe(!path.includes('/'));
      }),
    );
  });

  it('flags only changed files, and always every checks file', () => {
    fc.assert(
      fc.property(fc.array(PATH, { maxLength: 10 }), VALID_CONFIG, (files, valid) => {
        const patterns = protectedPatterns({ kind: 'valid', path: CHECKS_PATH, config: valid });
        const flagged = protectedChanges([...files, ...CHECKS_PATHS], patterns);
        expect(flagged.every((file) => CHECKS_PATHS.includes(file) || files.includes(file))).toBe(
          true,
        );
        for (const path of CHECKS_PATHS) expect(flagged).toContain(path);
      }),
    );
  });
});

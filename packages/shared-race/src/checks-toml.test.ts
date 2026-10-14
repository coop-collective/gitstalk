import * as fc from 'fast-check';
import { stringify } from 'smol-toml';
import { describe, expect, it } from 'vitest';

import type { ChecksConfig } from './checks-config';
import {
  ALWAYS_PROTECTED,
  describeChecks,
  protectedPatterns,
  readChecksConfig,
} from './checks-config';

/** The older format, still read wherever a tree has no checks.yml. */
const TOML_PATH = '.gitstalk/checks.toml';

function problems(text: string): readonly string[] {
  const resolution = readChecksConfig(text, TOML_PATH);
  if (resolution.kind !== 'invalid') throw new Error(`expected invalid, got ${resolution.kind}`);
  return resolution.problems;
}

function config(text: string): ChecksConfig {
  const resolution = readChecksConfig(text, TOML_PATH);
  if (resolution.kind !== 'valid') throw new Error(`expected valid: ${JSON.stringify(resolution)}`);
  return resolution.config;
}

describe('reading the older .gitstalk/checks.toml', () => {
  it('fills in the defaults for an empty file', () => {
    expect(config('')).toEqual({
      image: 'node',
      command: ['node', '--test'],
      env: {},
      timeout_seconds: 300,
      protected_paths: [],
    });
  });

  it('reads every key, exactly as before', () => {
    const text = [
      'image = "node"',
      'command = ["node", "--test", "spec/**/*.spec.mjs"]',
      'timeout_seconds = 90',
      'protected_paths = ["migrations/**", "LICENSE"]',
      '',
      '[env]',
      'TZ = "UTC"',
    ].join('\n');
    expect(config(text)).toEqual({
      image: 'node',
      command: ['node', '--test', 'spec/**/*.spec.mjs'],
      env: { TZ: 'UTC' },
      timeout_seconds: 90,
      protected_paths: ['migrations/**', 'LICENSE'],
    });
  });

  it('names the line and column of a syntax error', () => {
    expect(problems('image = "node"\ntimeout_seconds = = 3\n')).toEqual([
      'line 2, column 19: invalid value',
    ]);
  });

  it('refuses a shell string and says why', () => {
    expect(problems('command = "npm test"')).toEqual([
      'command: must be an argv array such as ["node", "--test"]; it never runs through a shell',
    ]);
  });

  it('refuses a command that does not run node --test', () => {
    expect(problems('command = ["cargo", "test"]')[0]).toMatch(/^command: must start with "node"/);
    expect(problems('command = ["node", "test.js"]')).toEqual(['command: must run node --test']);
  });

  it('suggests the key a misspelling meant', () => {
    expect(problems('comand = ["node", "--test"]')).toEqual([
      'unknown key "comand" (did you mean "command"?)',
    ]);
  });

  it("reads the starter's older [[check]] draft as the default suite, so it never turns red", () => {
    const starterDraft = [
      '# What a bean must pass before it lands: run on the exact merged tree.',
      '[[check]]',
      'name = "tests"',
      'command = "npm test"',
      'timeout_seconds = 120',
      '',
    ].join('\n');
    expect(readChecksConfig(starterDraft, TOML_PATH)).toEqual({ kind: 'legacy', path: TOML_PATH });
    expect(readChecksConfig('[[check]]\ncommand = "npm test"\n', TOML_PATH)).toEqual({
      kind: 'legacy',
      path: TOML_PATH,
    });
    expect(describeChecks({ kind: 'legacy', path: TOML_PATH })).toEqual([
      ".gitstalk/checks.toml is the older [[check]] draft, which does not choose the suite: the repository's default suite runs: node --test (timeout 300 s)",
      'to choose another, write .gitstalk/checks.yml with run: [node, --test, ...] (see /docs/checks)',
    ]);
    expect(protectedPatterns({ kind: 'legacy', path: TOML_PATH })).toEqual(ALWAYS_PROTECTED);
  });

  it('explains a [[check]] table mixed into the format', () => {
    expect(problems('timeout_seconds = 30\n[[check]]\ncommand = "npm test"\n')[0]).toMatch(
      /^unknown table \[\[check\]\]: write the keys at the top level/,
    );
  });

  it("refuses the runner's own variables and other bad values, one problem each", () => {
    const text =
      'timeout_seconds = 5000\nprotected_paths = ["/abs", "../up"]\n[env]\nPATH = "/x"\n';
    expect(problems(text)).toEqual([
      'timeout_seconds: must be at most 1800',
      'protected_paths[0]: is relative to the repository root: drop the /',
      'protected_paths[1]: must not contain .. (paths are inside the repository)',
      "env.PATH: is the runner's own (PATH, HOME, CI, GIT_*, LD_*, NODE_TEST*, BWRAP* are refused)",
    ]);
  });

  it('is never read as YAML: the format follows the file name', () => {
    expect(readChecksConfig('command = ["node", "--test"]', '.gitstalk/checks.yml').kind).toBe(
      'invalid',
    );
  });

  it('never throws on any text', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const resolution = readChecksConfig(text, TOML_PATH);
        expect(['valid', 'invalid', 'legacy']).toContain(resolution.kind);
      }),
    );
  });

  it('reads back any valid config written as TOML', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1800 }),
        fc.array(fc.stringMatching(/^[a-z0-9/*.-]{1,12}$/), { maxLength: 4 }),
        (timeout, globs) => {
          const expected: ChecksConfig = {
            image: 'node',
            command: ['node', '--test', ...globs],
            env: {},
            timeout_seconds: timeout,
            protected_paths: [],
          };
          expect(config(stringify(expected))).toEqual(expected);
        },
      ),
    );
  });
});

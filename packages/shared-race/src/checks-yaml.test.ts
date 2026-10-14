import * as fc from 'fast-check';
import { stringify } from 'smol-toml';
import { describe, expect, it } from 'vitest';

import type { ChecksConfig } from './checks-config';
import { readChecksConfig } from './checks-config';
import {
  CHECKS_JSON_SCHEMA,
  CHECKS_SCHEMA_URL,
  readChecksYaml,
  tomlChecksToYaml,
  writeChecksYaml,
} from './checks-yaml';

const SAMPLE: ChecksConfig = {
  image: 'node',
  command: ['node', '--test', 'test/*.test.ts'],
  env: { KV_LIMIT: '10' },
  timeout_seconds: 120,
  protected_paths: ['data/schema.json', '.github/**'],
};

describe('writeChecksYaml', () => {
  it('writes the schema line, minutes when they are whole, and run as one flow list', () => {
    expect(writeChecksYaml(SAMPLE)).toBe(
      [
        `# yaml-language-server: $schema=${CHECKS_SCHEMA_URL}`,
        'image: node',
        'timeout-minutes: 2',
        'env:',
        '  KV_LIMIT: "10"',
        'run: [ node, --test, test/*.test.ts ]',
        'protected-paths:',
        '  - data/schema.json',
        '  - .github/**',
        '',
      ].join('\n'),
    );
  });

  it('writes seconds when the minutes would not be whole, and leaves out empty defaults', () => {
    expect(writeChecksYaml({ ...SAMPLE, timeout_seconds: 45, env: {}, protected_paths: [] })).toBe(
      [
        `# yaml-language-server: $schema=${CHECKS_SCHEMA_URL}`,
        'image: node',
        'timeout-seconds: 45',
        'run: [ node, --test, test/*.test.ts ]',
        '',
      ].join('\n'),
    );
  });
});

describe('tomlChecksToYaml', () => {
  it('converts a checks.toml to the checks.yml that declares the same checks', () => {
    const toml = [
      '# comments are not carried over',
      'image = "node"',
      'command = ["node", "--test", "test/*.test.ts"]',
      'timeout_seconds = 120',
      'protected_paths = ["data/schema.json", ".github/**"]',
      '',
      '[env]',
      'KV_LIMIT = "10"',
    ].join('\n');
    const converted = tomlChecksToYaml(toml);
    expect(converted).toEqual({ ok: true, yaml: writeChecksYaml(SAMPLE) });
    if (converted.ok)
      expect(readChecksYaml(converted.yaml)).toEqual({ kind: 'valid', config: SAMPLE });
  });

  it('converts an empty file to the defaults written out', () => {
    const converted = tomlChecksToYaml('');
    expect(converted).toMatchObject({ ok: true });
    if (converted.ok) expect(converted.yaml).toContain('timeout-minutes: 5\nrun: [ node, --test ]');
  });

  it('refuses an invalid file, with its problems', () => {
    expect(tomlChecksToYaml('command = "npm test"')).toEqual({
      ok: false,
      problems: [
        'command: must be an argv array such as ["node", "--test"]; it never runs through a shell',
      ],
    });
  });

  it("refuses the starter's older draft, which chooses no suite to convert", () => {
    const converted = tomlChecksToYaml('[[check]]\nname = "tests"\ncommand = "npm test"\n');
    expect(converted).toMatchObject({ ok: false });
    if (!converted.ok) expect(converted.problems[0]).toContain('older [[check]] draft');
  });

  it('declares exactly what the TOML did, for any valid TOML', () => {
    const ARG = fc.stringMatching(/^[A-Za-z0-9_./=*-]{1,20}$/);
    const config: fc.Arbitrary<ChecksConfig> = fc.record({
      image: fc.constant('node' as const),
      command: fc.array(ARG, { maxLength: 4 }).map((rest) => ['node', '--test'].concat(rest)),
      env: fc.dictionary(fc.stringMatching(/^[A-Z][A-Z0-9]{0,8}$/), fc.string({ maxLength: 20 }), {
        maxKeys: 4,
      }),
      timeout_seconds: fc.integer({ min: 1, max: 1800 }),
      protected_paths: fc.array(fc.stringMatching(/^[a-z][a-z0-9*./]{0,15}$/), { maxLength: 4 }),
    });
    fc.assert(
      fc.property(config, (expected) => {
        const fromToml = readChecksConfig(stringify(expected), '.gitstalk/checks.toml');
        fc.pre(fromToml.kind === 'valid');
        const converted = tomlChecksToYaml(stringify(expected));
        if (!converted.ok) throw new Error(converted.problems.join('; '));
        const fromYaml = readChecksConfig(converted.yaml, '.gitstalk/checks.yml');
        expect(fromYaml).toEqual({ ...fromToml, path: '.gitstalk/checks.yml' });
      }),
    );
  });
});

describe('CHECKS_JSON_SCHEMA', () => {
  it('describes the file for editors', () => {
    expect(CHECKS_JSON_SCHEMA).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        image: { enum: ['node'] },
        run: { type: 'array', items: { type: 'string' } },
        'timeout-minutes': { type: 'number' },
        'timeout-seconds': { type: 'integer' },
        env: { type: 'object' },
        'protected-paths': { type: 'array' },
      },
    });
  });
});

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ApprovalPolicy, PolicyClass } from './policy-file';
import {
  BUILTIN_CLASSES,
  EMPTY_POLICY,
  POLICY_JSON_SCHEMA,
  POLICY_SCHEMA_URL,
  ROUTES,
  policyOf,
  policyView,
  readApprovalPolicy,
  writeApprovalPolicy,
} from './policy-file';

const SPEC = `# yaml-language-server: $schema=${POLICY_SCHEMA_URL}
groups:
  security: ["@alice", "agent:a1"]
classes:
  - name: comment-only
    match: { syntax: comments-and-whitespace }
    route: auto
  - name: migration
    match: { paths: ["src/db/migrations/**"] }
    route: card
    reviewers: ["@data"]
  - name: protected
    match:
      paths: ["src/auth/**"]
    route: card
    writers: ["@security"]
  - name: api
    match: { paths: ["src/api/**"] }
    route: triage
`;

function problems(text: string) {
  const resolution = readApprovalPolicy(text);
  return resolution.kind === 'invalid' ? resolution.problems : [];
}

describe('readApprovalPolicy', () => {
  it('reads the documented example', () => {
    const resolution = readApprovalPolicy(SPEC);
    expect(resolution.kind).toBe('valid');
    if (resolution.kind !== 'valid') return;
    expect(resolution.policy.classes.map((entry) => [entry.name, entry.route])).toEqual([
      ['comment-only', 'auto'],
      ['migration', 'card'],
      ['protected', 'card'],
      ['api', 'triage'],
    ]);
    expect(resolution.policy.classes[2]?.match).toEqual({ kind: 'paths', paths: ['src/auth/**'] });
    expect(resolution.policy.groups['security']).toEqual(['@alice', 'agent:a1']);
  });

  it('treats no file as no policy, and an empty file as an empty one', () => {
    expect(readApprovalPolicy(null)).toEqual({ kind: 'missing' });
    expect(policyOf({ kind: 'missing' })).toBe(EMPTY_POLICY);
    expect(readApprovalPolicy('')).toMatchObject({ kind: 'valid', policy: EMPTY_POLICY });
  });

  it('names the line, column and field of a bad route', () => {
    expect(problems(SPEC.replace('route: triage', 'route: later'))).toEqual([
      { line: 19, column: 12, field: 'classes[3].route', message: 'must be auto, triage or card' },
    ]);
  });

  it('names unknown keys where they are written', () => {
    expect(
      problems('classes:\n  - name: x\n    route: auto\n    match: { paths: [a] }\n    owner: 1\n'),
    ).toEqual([{ line: 5, column: 5, field: 'classes[0]', message: 'unknown key "owner"' }]);
    expect(problems('class: []\n')[0]).toMatchObject({
      line: 1,
      column: 1,
      message: 'unknown key "class"',
    });
  });

  it('keeps no, yes and on as strings (YAML 1.2 core schema)', () => {
    expect(problems('groups:\n  no: ["@a"]\n')).toEqual([]);
    expect(
      problems('classes:\n  - name: x\n    route: no\n    match: { paths: [a] }\n')[0]?.message,
    ).toBe('must be auto, triage or card');
  });

  it('refuses anchors, aliases, merge keys and duplicate keys', () => {
    const anchored = 'groups:\n  a: &team ["@x"]\n  b: *team\n';
    expect(problems(anchored).map((problem) => problem.message)).toEqual([
      'anchors (&name) are not allowed; write each value out',
      'aliases (*name) and merge keys are not allowed; write each value out',
    ]);
    expect(
      problems(
        'classes:\n  - &c { name: x, route: auto, match: { paths: [a] } }\n  - { <<: *c, name: y }\n',
      ).length,
    ).toBeGreaterThan(0);
    expect(problems('groups: {}\ngroups: {}\n')[0]?.line).toBe(2);
  });

  it('refuses the built-in class name and duplicate names', () => {
    expect(
      problems('classes:\n  - { name: policy-change, route: auto, match: { paths: [a] } }\n')[0]
        ?.message,
    ).toBe('"policy-change" is built in');
    expect(
      problems(
        'classes:\n  - { name: a, route: auto, match: { paths: [a] } }\n  - { name: a, route: card, match: { paths: [b] } }\n',
      ),
    ).toEqual([
      { line: 3, column: 13, field: 'classes[1].name', message: 'two classes are named "a"' },
    ]);
  });

  it('never throws, whatever the text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (text) => {
        expect(['valid', 'invalid']).toContain(readApprovalPolicy(text).kind);
      }),
    );
  });
});

const name = fc
  .stringMatching(/^[a-z][a-z0-9-]{0,10}$/u)
  .filter((value) => value !== 'policy-change');
const principal = fc.oneof(
  fc.stringMatching(/^@[a-z][a-z0-9]{0,8}$/u),
  fc.integer({ min: 0, max: 31 }).map((slot) => `agent:a${slot}`),
);
const pattern = fc.constantFrom('src/**', 'docs/', '*.md', 'src/auth/**', 'no', 'yes: x', '"q"');
const policyClass: fc.Arbitrary<Omit<PolicyClass, 'name'>> = fc.record({
  match: fc.oneof(
    fc
      .array(pattern, { minLength: 1, maxLength: 4 })
      .map((paths) => ({ kind: 'paths' as const, paths })),
    fc.constant({ kind: 'syntax' as const, syntax: 'comments-and-whitespace' as const }),
    fc
      .constantFrom(...BUILTIN_CLASSES)
      .map((builtin) => ({ kind: 'class' as const, class: builtin })),
  ),
  route: fc.constantFrom(...ROUTES),
  reviewers: fc.array(principal, { maxLength: 3 }),
  writers: fc.array(principal, { maxLength: 3 }),
});
const policy: fc.Arbitrary<ApprovalPolicy> = fc.record({
  groups: fc.dictionary(name, fc.array(principal, { maxLength: 3 }), { maxKeys: 3 }),
  classes: fc
    .uniqueArray(name, { maxLength: 6 })
    .chain((names) =>
      fc
        .tuple(...names.map(() => policyClass))
        .map((entries) => entries.map((entry, index) => ({ ...entry, name: names[index] ?? 'x' }))),
    ),
});

describe('writeApprovalPolicy', () => {
  it('writes every valid policy so it reads back equal', () => {
    fc.assert(
      fc.property(policy, (written) => {
        const text = writeApprovalPolicy(written);
        expect(text.startsWith(`# yaml-language-server: $schema=${POLICY_SCHEMA_URL}\n`)).toBe(
          true,
        );
        expect(readApprovalPolicy(text)).toEqual({
          kind: 'valid',
          path: '.gitstalk/policy.yml',
          policy: written,
        });
      }),
    );
  });
});

describe('POLICY_JSON_SCHEMA', () => {
  it('describes the file for editors', () => {
    expect(POLICY_JSON_SCHEMA).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: { groups: { type: 'object' }, classes: { type: 'array' } },
    });
  });
});

describe('policyView', () => {
  it('reports the source and the problems', () => {
    const source = { ref: 'stalk', sha: 'a'.repeat(40) };
    expect(policyView({ kind: 'missing' }, source)).toEqual({
      ...source,
      path: null,
      policy: null,
      problems: [],
    });
    const bad = readApprovalPolicy('classes: 1', '.beanstalk/policy.yml');
    expect(policyView(bad, source).problems.length).toBeGreaterThan(0);
    expect(policyView(bad, source).path).toBe('.beanstalk/policy.yml');
  });
});

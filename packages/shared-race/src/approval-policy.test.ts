import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ChangedFile } from './approval-policy';
import { brokenWriterLimits, builtinClasses, classifyChange } from './approval-policy';
import type { ApprovalPolicy } from './policy-file';
import { EMPTY_POLICY, readApprovalPolicy } from './policy-file';

const SPEC = `
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
    match: { paths: ["src/auth/**"] }
    route: card
    writers: ["@security"]
  - name: api
    match: { paths: ["src/api/**"] }
    route: triage
`;

function policy(text: string): ApprovalPolicy {
  const resolution = readApprovalPolicy(text);
  if (resolution.kind !== 'valid') throw new Error(JSON.stringify(resolution));
  return resolution.policy;
}

function code(...paths: string[]): ChangedFile[] {
  return paths.map((path) => ({ path, commentOnly: false }));
}

function comments(...paths: string[]): ChangedFile[] {
  return paths.map((path) => ({ path, commentOnly: true }));
}

describe('classifyChange', () => {
  const read = policy(SPEC);

  it('routes a bean no class matches to auto', () => {
    expect(classifyChange(read, code('src/app.ts'))).toMatchObject({
      route: 'auto',
      decidedBy: null,
      classes: [],
    });
  });

  it('takes the strictest route of the matched classes', () => {
    const result = classifyChange(read, code('src/api/a.ts', 'src/db/migrations/1.sql'));
    expect(result.route).toBe('card');
    expect(result.decidedBy).toBe('migration');
    expect(result.reviewers).toEqual(['@data']);
    expect(classifyChange(read, code('src/api/a.ts')).route).toBe('triage');
  });

  it('lets a comment-only change through even in a sensitive path, keeping writer limits', () => {
    const result = classifyChange(read, comments('src/auth/login.ts'));
    expect(result.route).toBe('auto');
    expect(result.decidedBy).toBe('comment-only');
    expect(result.classes).toEqual(['comment-only', 'protected']);
    expect(brokenWriterLimits(result, '@mallory')).toEqual([
      { class: 'protected', allowed: ['@alice', 'agent:a1'] },
    ]);
    expect(brokenWriterLimits(result, 'agent:a1')).toEqual([]);
  });

  it('always cards a change to the configuration directory', () => {
    for (const path of ['.beanstalk/policy.yml', '.gitstalk/policy.yml', '.gitstalk/x/y']) {
      const result = classifyChange(EMPTY_POLICY, comments(path));
      expect(result.route).toBe('card');
      expect(result.classes[0]).toBe('policy-change');
    }
  });

  it('computes the built-in classes only when every file has the kind', () => {
    expect(builtinClasses(code('README.md', 'docs/a.html'))).toEqual(['docs-only']);
    expect(builtinClasses(code('src/a.test.ts', 'tests/b.rs'))).toEqual(['tests-only']);
    expect(builtinClasses(code('pnpm-lock.yaml', 'crates/x/Cargo.lock'))).toEqual(['lockfile']);
    expect(builtinClasses(code('README.md', 'src/a.ts'))).toEqual([]);
    expect(builtinClasses([])).toEqual([]);
  });

  it('routes built-in classes a policy names', () => {
    const docs = policy(
      'classes:\n  - { name: docs, match: { class: docs-only }, route: triage }\n',
    );
    expect(classifyChange(docs, code('README.md')).route).toBe('triage');
    expect(classifyChange(docs, code('README.md', 'a.ts')).route).toBe('auto');
  });

  it('never routes a policy change below card, whatever the files', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('src/a.ts', 'README.md', 'src/auth/x.ts', 'pnpm-lock.yaml')),
        fc.boolean(),
        (paths, commentOnly) => {
          const files = [...paths, '.beanstalk/policy.yml'].map((path) => ({ path, commentOnly }));
          expect(classifyChange(read, files).route).toBe('card');
        },
      ),
    );
  });

  it('takes the own policy change of a person who decides as the decision', () => {
    const result = classifyChange(EMPTY_POLICY, code('.gitstalk/policy.yml'), 'decider');
    expect(result).toMatchObject({ route: 'auto', classes: ['policy-change'] });
  });

  it('lets agents tick the backlog without a person', () => {
    expect(classifyChange(EMPTY_POLICY, code('.gitstalk/backlog.md')).route).toBe('auto');
  });
});

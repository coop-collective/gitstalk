import { describe, expect, it } from 'vitest';

import { CHECKS_PATH, readChecksConfig } from '@gitstalk/shared-race/checks-config';
import type { SessionVia } from '@gitstalk/shared-race/collaborators';
import { RunId, Sha } from '@gitstalk/shared-race/ids';
import { DEFAULT_SUITE, RunSuite } from '@gitstalk/shared-race/suite';

import type { GitCredential } from '../auth/git-credential';
import { templateFiles } from '../repos/templates';
import type { LandingTree } from './check-store';
import { protectedAccessOf, pusherOf } from './protected-access';
import type { RepositoryChecksHost } from './repository-checks';
import { decide, planCheck, protectedGuard } from './repository-checks';

const SPROUT = Sha.parse('a'.repeat(40));
const MERGED = Sha.parse('b'.repeat(40));
const AGENT = { allowed: false, who: '@agent (write, with an agent session token)', pusher: null };
const OWNER = { allowed: true, who: '@coop (owner, with a personal token)', pusher: null };
/** An engine configured with another suite than the default, to tell the two apart. */
const ENGINE_SUITE = RunSuite.parse({ argv: ['node', '--test', 'test/'], timeout_seconds: 90 });
const NO_GUARD = { guard: null, engineSuite: DEFAULT_SUITE };

function landing(files: readonly string[]): LandingTree {
  return { sha: MERGED, task: 'bean-1', onto: SPROUT, files };
}

function host(input: {
  files: Readonly<Record<string, string | null>>;
  landing?: LandingTree;
  access?: typeof AGENT;
  path?: string;
}): RepositoryChecksHost & { recorded: Map<string, readonly string[]> } {
  const recorded = new Map<string, readonly string[]>();
  return {
    recorded,
    readChecks: async (sha) => {
      const text = input.files[sha] ?? null;
      return text === null ? null : { path: input.path ?? CHECKS_PATH, text };
    },
    saveLandingTree: () => undefined,
    landingTree: (sha) => (input.landing?.sha === sha ? input.landing : null),
    protectedAccess: () => input.access ?? AGENT,
    record: (sha, lines) => recorded.set(sha, lines),
  };
}

describe('deciding a check from the tree', () => {
  it("runs the engine's configured suite when the tree has no checks file, never no checks", () => {
    const { plan, lines } = decide(readChecksConfig(null), {
      guard: null,
      engineSuite: ENGINE_SUITE,
    });
    expect(plan).toEqual({ kind: 'run', suite: ENGINE_SUITE });
    expect(lines).toEqual([
      "gitstalk: no .gitstalk/checks.toml on this tree: the repository's default suite runs: node --test test/ (timeout 90 s)",
    ]);
  });

  it("runs the engine's suite for the starter's older [[check]] draft", () => {
    const draft = '[[check]]\nname = "tests"\ncommand = "npm test"\ntimeout_seconds = 120\n';
    const { plan, lines } = decide(readChecksConfig(draft), NO_GUARD);
    expect(plan).toEqual({ kind: 'run', suite: DEFAULT_SUITE });
    expect(lines[0]).toContain('older [[check]] draft');
  });

  it('still refuses a protected change by an agent on a tree without the file', () => {
    const guard = protectedGuard(landing(['.gitstalk/checks.toml']), readChecksConfig(null), AGENT);
    const { plan } = decide(readChecksConfig('command = ["node", "--test"]'), {
      guard,
      engineSuite: DEFAULT_SUITE,
    });
    expect(plan).toMatchObject({ kind: 'answer', result: { green: false } });
  });

  it('answers red with every problem when the file is invalid, and runs nothing', () => {
    const { plan, lines } = decide(readChecksConfig('image = "rust"\ncomand = []\n'), NO_GUARD);
    if (plan.kind !== 'answer') throw new Error('expected an answer');
    expect(plan.result).toMatchObject({
      green: false,
      failingFiles: ['.gitstalk/checks.toml'],
      failingTests: [{ file: '.gitstalk/checks.toml', name: 'the checks config is valid' }],
    });
    expect(plan.result.output).toContain('unknown key "comand" (did you mean "command"?)');
    expect(lines[0]).toBe('gitstalk: .gitstalk/checks.toml is invalid:');
  });

  it('runs the suite a valid file declares', () => {
    const { plan } = decide(readChecksConfig('command = ["node", "--test", "spec/"]'), NO_GUARD);
    expect(plan).toMatchObject({ kind: 'run', suite: { argv: ['node', '--test', 'spec/'] } });
  });

  it('refuses a protected change before reading anything else, naming the paths and the pusher', () => {
    const sprout = readChecksConfig('protected_paths = ["migrations/**"]');
    const guard = protectedGuard(landing(['migrations/1.sql', 'src/a.ts']), sprout, AGENT);
    const { plan, lines } = decide(readChecksConfig('command = ["node", "--test"]'), {
      guard,
      engineSuite: DEFAULT_SUITE,
    });
    if (plan.kind !== 'answer') throw new Error('expected an answer');
    expect(plan.result.failingTests).toEqual([
      { file: 'migrations/1.sql', name: 'changes a protected path', message: 'migrations/1.sql' },
    ]);
    expect(plan.result.output).toContain('this push was by @agent');
    expect(lines).toEqual([
      'gitstalk: changes protected paths (migrations/1.sql): refused for @agent (write, with an agent session token)',
    ]);
  });

  it("lets the owner change protected paths and then checks the owner's new config", () => {
    const guard = protectedGuard(landing(['.gitstalk/checks.toml']), readChecksConfig(null), OWNER);
    const { plan, lines } = decide(readChecksConfig('timeout_seconds = 30'), {
      guard,
      engineSuite: DEFAULT_SUITE,
    });
    expect(plan).toMatchObject({ kind: 'run', suite: { timeout_seconds: 30 } });
    expect(lines[0]).toBe(
      'gitstalk: changes protected paths (.gitstalk/checks.toml): allowed for @coop (owner, with a personal token)',
    );
  });

  it('takes protected paths from the sprout, so a bean cannot unprotect its own change', async () => {
    const checks = host({
      files: {
        [SPROUT]: 'protected_paths = ["LICENSE"]',
        [MERGED]: 'protected_paths = []',
      },
      landing: landing(['LICENSE', '.gitstalk/checks.toml']),
    });
    const plan = await planCheck(
      checks,
      {
        sha: MERGED,
        instance: { kind: 'sandbox', slot: 'a0' },
      },
      DEFAULT_SUITE,
    );
    expect(plan).toMatchObject({ kind: 'answer', result: { green: false } });
    expect(checks.recorded.get(MERGED)?.[0]).toContain('(LICENSE, .gitstalk/checks.toml): refused');
  });

  it('applies no protected paths to a validation of the sprout', async () => {
    const checks = host({
      files: { [MERGED]: 'command = ["node", "--test"]' },
      landing: landing(['.gitstalk/checks.toml']),
    });
    const plan = await planCheck(
      checks,
      { sha: MERGED, instance: { kind: 'ci', slot: 0 } },
      DEFAULT_SUITE,
    );
    expect(plan.kind).toBe('run');
  });

  it('reads a repository whose checks are still in .beanstalk/, and names that file', async () => {
    const checks = host({
      files: { [MERGED]: 'command = ["node", "--test", "spec/"]' },
      path: '.beanstalk/checks.toml',
    });
    const plan = await planCheck(
      checks,
      { sha: MERGED, instance: { kind: 'ci', slot: 0 } },
      DEFAULT_SUITE,
    );
    expect(plan).toMatchObject({ kind: 'run', suite: { argv: ['node', '--test', 'spec/'] } });
    expect(checks.recorded.get(MERGED)?.[0]).toMatch(
      /^gitstalk: checks from \.beanstalk\/checks\.toml: /,
    );
  });
});

describe('the TypeScript starter', () => {
  it('declares checks that read as valid: node --test, two minutes', () => {
    const file = templateFiles(
      'typescript-starter',
      { name: 'greeter', description: '' },
      'https://gitstalk.example',
    ).find((seed) => seed.path === '.gitstalk/checks.toml');
    expect(file?.content).toContain('# Format: https://gitstalk.example/docs/checks\n');
    expect(file?.content).not.toContain('docs/claude-opus');
    expect(readChecksConfig(file?.content ?? null)).toMatchObject({
      kind: 'valid',
      config: { command: ['node', '--test'], timeout_seconds: 120, protected_paths: [] },
    });
  });
});

function credential(via: SessionVia | null): GitCredential {
  return {
    user: { id: 'u1', handle: 'coop' },
    scopes: ['repo:read', 'bean:write'],
    engine: null,
    runPrincipal: null,
    session: via === null ? null : { via, id: 'c1' },
  };
}

describe('who may change protected paths', () => {
  it.each([
    ['personal-token', 'owner', true],
    ['ssh-key', 'maintain', true],
    ['personal-token', 'write', false],
    ['agent-session', 'owner', false],
    ['mcp', 'owner', false],
    ['deploy-token', null, false],
  ] as const)('%s with role %s: %s', (via, role, allowed) => {
    expect(protectedAccessOf(credential(via), role).allowed).toBe(allowed);
  });

  it('never lets an engine token change them', () => {
    expect(protectedAccessOf(credential(null), 'owner')).toEqual({
      allowed: false,
      who: '@coop (owner, with an engine token)',
      pusher: 'engine',
    });
  });

  it('records which credential pushed, an OAuth session by its client', () => {
    const minted = credential('agent-session');
    const session = minted.session === null ? null : { ...minted.session, client: 'claude-code' };
    expect(pusherOf({ ...minted, session })).toBe('oauth:claude-code');
    expect(pusherOf(credential('agent-session'))).toBe('agent-session:c1');
    expect(pusherOf(credential('ssh-key'))).toBe('ssh-key:c1');
    expect(pusherOf(credential(null))).toBe('engine');
  });

  it('names a deploy token as acting for the person who made it', () => {
    const deploy = { ...credential('deploy-token'), engine: RunId.parse('r0123456789abcdef012') };
    expect(protectedAccessOf(deploy, null)).toEqual({
      allowed: false,
      who: 'a deploy token acting for @coop',
      pusher: 'deploy-token:c1',
    });
  });
});

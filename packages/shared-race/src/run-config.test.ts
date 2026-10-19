import { describe, expect, it } from 'vitest';

import {
  DEMO_SETTINGS,
  RunConfig,
  V24_SETTINGS,
  V25_SETTINGS,
  V25_RULES_OFF,
  errorBudget,
  prelandSeconds,
  releasesOnCheck,
  protectTestsMode,
  snapshotMode,
  unionPaths,
  usesStructuralMerge,
  usesUnionMerge,
} from './run-config';

const task = (id: string) => ({
  id,
  title: `Task ${id}`,
  prompt: 'Do it.',
  acceptance_tests: { [`src/${id}.test.ts`]: 'test' },
});

describe('RunConfig', () => {
  it('keeps the test skipper off by default and permits opting into v2 only', () => {
    const base = { policy: 'beanstalk-v2', tasks: [task('t001')] };
    expect(RunConfig.parse(base).test_skipper).toBe(false);
    expect(RunConfig.parse({ ...base, test_skipper: true }).test_skipper).toBe(true);
    expect(RunConfig.safeParse({ ...base, policy: 'queue', test_skipper: true }).success).toBe(
      false,
    );
    expect(RunConfig.safeParse({ ...base, test_skipper: 'true' }).success).toBe(false);
  });
  it('applies the harness RaceConfig defaults', () => {
    const config = RunConfig.parse({ policy: 'queue', tasks: [task('t001')] });

    expect(config).toMatchObject({
      agent: 'replay',
      agents: 4,
      ci_seconds: 60,
      ci_slots: 2,
      batch: 4,
      batch_wait: 0,
      budget_usd: 25,
      max_invocation_usd: 3,
      max_turns: 40,
      agent_timeout: 900,
      seed: 0,
      merge_drivers: 'auto',
      queue_hold: true,
      max_rework: 3,
      max_fix_attempts: 2,
      max_wall_minutes: 360,
      infra_retry_seconds: 10,
      rework_resume: true,
      preland_mode: 'optimistic',
      preland_seconds: null,
      decision_seconds: 30,
      decision_oracle: 'landed',
      decision_mode: 'oracle',
      human_timeout_seconds: null,
      decision_outcome: 'reexecute',
      recheck: 'sampled',
      recheck_fallback: 'file',
      window: 'aimd',
      flake_confirm: true,
      inherited_reds: 'readset',
      early_tickets: true,
      start_order: 'fifo',
    });
    expect(releasesOnCheck(config)).toBe(false);
    expect(releasesOnCheck({ ...config, policy: 'beanstalk-v2' })).toBe(true);
    expect(releasesOnCheck({ policy: 'beanstalk-v2', release_on_check: false })).toBe(false);
    expect(protectTestsMode(config)).toBe('own');
    expect(snapshotMode(config)).toBe('green');
    expect(errorBudget(config)).toBe(3);
  });

  it('gives v2 its plan §6 settings: landed protection, sprout-head starts, fair pre-land checks', () => {
    const config = RunConfig.parse({
      policy: 'beanstalk-v2',
      ci_seconds: 60,
      tasks: [task('t001')],
    });

    expect(protectTestsMode(config)).toBe('landed');
    expect(snapshotMode(config)).toBe('head');
    expect(prelandSeconds(config)).toBe(60);
    expect(prelandSeconds({ ...config, preland_seconds: 0 })).toBe(0);
    expect(errorBudget(config)).toBe(999);
  });

  it('refuses v2 settings that contradict the policy', () => {
    const v2 = { policy: 'beanstalk-v2', tasks: [task('t001')] };

    expect(RunConfig.safeParse({ ...v2, protect_tests: 'own' }).success).toBe(false);
    expect(RunConfig.safeParse({ ...v2, snapshot: 'green' }).success).toBe(false);
    expect(RunConfig.safeParse({ ...v2, error_budget: 3 }).success).toBe(false);
    expect(RunConfig.safeParse({ ...v2, error_budget: 999 }).success).toBe(true);
  });

  it('rejects duplicate task ids', () => {
    const result = RunConfig.safeParse({ policy: 'queue', tasks: [task('t001'), task('t001')] });

    expect(result.success).toBe(false);
  });

  it('rejects footprints for tasks the run does not have', () => {
    const result = RunConfig.safeParse({
      policy: 'queue',
      tasks: [task('t001')],
      footprints: { t009: { method: 'predictor', selected: [], probs: {} } },
    });

    expect(result.success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(RunConfig.safeParse({ policy: 'queue', tasks: [task('t001')], agnets: 3 }).success).toBe(
      false,
    );
  });
});

describe('union merge driver', () => {
  it('is on for the beanstalk policies and off for the queue when left on auto', () => {
    expect(usesUnionMerge({ policy: 'queue', merge_drivers: 'auto' })).toBe(false);
    expect(usesUnionMerge({ policy: 'beanstalk', merge_drivers: 'auto' })).toBe(true);
    expect(usesUnionMerge({ policy: 'beanstalk-preland', merge_drivers: 'auto' })).toBe(true);
  });

  it('follows an explicit setting', () => {
    expect(unionPaths({ policy: 'queue', merge_drivers: 'union' })).toEqual([
      'CHANGELOG.md',
      'CHANGELOG*.md',
      '**/CHANGELOG.md',
    ]);
    expect(unionPaths({ policy: 'beanstalk', merge_drivers: 'none' })).toEqual([]);
  });
});

describe('structural merge tier', () => {
  it('is v2 only: on by default for v2, never for the queue', () => {
    const v2 = RunConfig.parse({ policy: 'beanstalk-v2', tasks: [task('t001')] });
    const queue = RunConfig.parse({ policy: 'queue', tasks: [task('t001')] });

    expect(usesStructuralMerge(v2)).toBe(true);
    expect(usesStructuralMerge({ ...v2, structural_merge: false })).toBe(false);
    expect(usesStructuralMerge(queue)).toBe(false);
    expect(usesStructuralMerge({ ...v2, ...V25_RULES_OFF })).toBe(false);
  });

  it('refuses it for the queue, which stays the harness baseline', () => {
    const result = RunConfig.safeParse({
      policy: 'queue',
      structural_merge: true,
      tasks: [task('t001')],
    });

    expect(result.success).toBe(false);
  });
});

describe('the demo preset', () => {
  it('pins v2.5 with dependency-aware starts, the tail bounds and parking whatever the defaults are', () => {
    const config = RunConfig.parse({
      policy: 'beanstalk-v2',
      preset: 'demo',
      tasks: [task('t001')],
    });

    expect(config).toMatchObject({ preset: 'demo', ...DEMO_SETTINGS });
    expect(config).toMatchObject({
      start_order: 'dependency',
      max_bean_invocations: 10,
      tail_guard_minutes: 3,
      park: true,
    });
  });

  it('pins the v2.5 rules at the values the defaults have today, parking, the reset and check reuse aside', () => {
    const defaults = RunConfig.parse({ policy: 'beanstalk-v2', tasks: [task('t001')] });

    expect({ ...defaults, structural_merge: usesStructuralMerge(defaults) }).toMatchObject({
      ...V25_SETTINGS,
      park: true,
      tail_guard_minutes: 3,
      red_reset: true,
      requeue_repair: true,
      reuse_checks: true,
    });
    expect(DEMO_SETTINGS).toMatchObject({
      red_reset: true,
      episode_tickets: false,
      repair_landing: false,
      requeue_repair: true,
      reuse_checks: true,
    });
    expect(V25_SETTINGS).toMatchObject({
      red_reset: false,
      requeue_repair: false,
      reuse_checks: false,
    });
  });

  it('accepts a pinned field repeated with its value and refuses a changed one', () => {
    const base = { policy: 'beanstalk-v2', preset: 'demo', tasks: [task('t001')] };

    expect(RunConfig.safeParse({ ...base, window_start: 8 }).success).toBe(true);
    const changed = RunConfig.safeParse({ ...base, start_order: 'fifo' });
    expect(changed.success).toBe(false);
    expect(changed.error?.issues[0]?.path).toEqual(['start_order']);
  });

  it('runs the queue without the v2-only structural merge', () => {
    const config = RunConfig.parse({ policy: 'queue', preset: 'demo', tasks: [task('t001')] });

    expect(usesStructuralMerge(config)).toBe(false);
    expect(config).toMatchObject({ preset: 'demo', rescue: true });
  });

  it('keeps v2.4 under the v24 preset', () => {
    const base = { policy: 'beanstalk-v2', preset: 'v24', tasks: [task('t001')] };

    expect(RunConfig.parse(base)).toMatchObject({ preset: 'v24', ...V24_SETTINGS });
    expect(RunConfig.safeParse({ ...base, rescue: true }).success).toBe(false);
  });

  it('leaves a run without a preset on the defaults, with the spend guard off and reaping on', () => {
    const config = RunConfig.parse({ policy: 'beanstalk-v2', tasks: [task('t001')] });

    expect(config).toMatchObject({ preset: null, rescue: true, max_usd: null, keep_repo: false });
  });
});

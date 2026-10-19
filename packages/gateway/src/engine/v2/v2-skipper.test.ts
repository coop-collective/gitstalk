import { describe, expect, it } from 'vitest';
import { eventsOf, runRace, soloTask } from '../testing/scenario';

describe('optional pre-land test skipping', () => {
  it.each([false, true])('with test_skipper=%s keeps CI and final checks full', (enabled) => {
    const run = runRace({
      config: { policy: 'beanstalk-v2', agents: 1, ci_seconds: 0, test_skipper: enabled },
      tasks: [soloTask('t001'), soloTask('t002')],
    });
    const checks = run.world.jobs.filter((job) => job.kind === 'check');
    const preland = checks.filter(
      (job) => job.instance.kind === 'sandbox' && job.only === undefined,
    );
    const ci = checks.filter((job) => job.instance.kind === 'ci');
    expect(preland.length).toBeGreaterThan(0);
    expect(preland.every((job) => (job.testSkipper === true) === enabled)).toBe(true);
    expect(ci.length).toBeGreaterThan(0);
    expect(ci.every((job) => job.testSkipper === undefined && job.only === undefined)).toBe(true);
    expect(eventsOf(run.events, 'final.check')[0]).toMatchObject({ correct: true });
  });
});

// A selected green must still take the validation path even when both older reuse options are on.
it('never promotes a selected check as full-suite evidence', () => {
  const run = runRace({
    config: {
      policy: 'beanstalk-v2',
      agents: 1,
      ci_seconds: 0,
      test_skipper: true,
      reuse_checks: true,
      evidence_promotion: true,
    },
    tasks: [soloTask('t001')],
    wrapWorld: (world) => ({
      ...world,
      runJob: (spec) => {
        const outcome = world.runJob(spec);
        if (
          spec.kind !== 'check' ||
          spec.testSkipper !== true ||
          !outcome.ok ||
          outcome.result.kind !== 'check'
        )
          return outcome;
        return {
          ...outcome,
          result: {
            ...outcome.result,
            check: {
              ...outcome.result.check,
              selection: {
                mode: 'selected',
                reason: 'unchanged-transitive-dependencies',
                baseline_sha: spec.sha,
                selected_files: ['tests/t001.test.ts'],
                skipped_files: ['tests/other.test.ts'],
              },
            },
          },
        };
      },
    }),
  });
  expect(eventsOf(run.events, 'check.reused')).toEqual([]);
  expect(eventsOf(run.events, 'promote.evidence')).toEqual([]);
  expect(eventsOf(run.events, 'ci.start', { purpose: 'validate' }).length).toBeGreaterThan(0);
  expect(eventsOf(run.events, 'preland.check')[0]).toHaveProperty('selection.mode', 'selected');
  expect(eventsOf(run.events, 'final.check')[0]).toMatchObject({ correct: true });
});

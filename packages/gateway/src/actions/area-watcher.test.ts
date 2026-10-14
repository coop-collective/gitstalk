import { describe, expect, it } from 'vitest';

import { readAutomationFile } from '@gitstalk/shared-race/automation-file';
import { templateOf } from '@gitstalk/shared-race/automation-templates';
import type { RepoEvent } from '@gitstalk/shared-race/repo-events';

import { compileAutomation } from './automation-job';
import { automationFires, needsChangedPaths, occurrenceOf } from './automation-triggers';
import { readWorkflowFile } from './workflow-file';

const LIMITS = { maxMatrixLegs: 16, maxTimeoutMinutes: 60 };
const PATH = '.gitstalk/automations/area-watcher.yml';
const ACTOR = 'area-watcher[automation]';
const AT = '2026-10-14T10:00:00.000Z';

function watcher() {
  const file = readAutomationFile(PATH, templateOf('area-watcher').source, LIMITS);
  if (file.info === null) throw new Error(file.problems[0]?.message ?? 'invalid template');
  return { ...file, info: file.info };
}

function landing(changedPaths: readonly string[] | null, actor = 'dana') {
  const event: RepoEvent = {
    seq: 9,
    at: AT,
    kind: 'bean.landed',
    bean: 'charge-retry',
    sha: 'c'.repeat(40),
    trunk_idx: 4,
    files: 1,
    actor,
  };
  return { ...occurrenceOf(event), changedPaths };
}

describe('the area watcher template', () => {
  it('is a valid automation that reviews landings under src/billing/ and can only push beans', () => {
    const file = watcher();
    expect(file.problems).toEqual([]);
    expect(file.triggers).toEqual([
      {
        kind: 'beanstalk',
        event: 'bean_landed',
        beans: [],
        authors: [],
        paths: ['src/billing/**'],
      },
      { kind: 'workflow_dispatch', inputs: [] },
    ]);
    expect(file.info).toMatchObject({ harness: 'agent', permissions: { beans: 'write' } });
    expect(file.notes).toEqual([
      expect.objectContaining({ feature: 'bean_landed paths', verdict: 'runs-differently' }),
    ]);
    for (const tool of ['why_lines', 'bean_status', 'repo_read', '$GITSTALK_TELEMETRY'])
      expect(file.info.prompt).toContain(tool);
  });

  it('starts for a landing that changes the area', () => {
    const { triggers } = watcher();
    expect(automationFires(triggers, landing(['src/billing/charge.ts', 'README.md']), ACTOR)).toBe(
      true,
    );
  });

  it('does not start for a landing outside the area, or another event', () => {
    const { triggers } = watcher();
    expect(
      automationFires(triggers, landing(['src/auth/login.ts', 'docs/billing.md']), ACTOR),
    ).toBe(false);
    expect(
      automationFires(
        triggers,
        occurrenceOf({ seq: 1, at: AT, kind: 'bean.rework', bean: 'x', reason: 'red' }),
        ACTOR,
      ),
    ).toBe(false);
  });

  it('starts when the landing’s files are unknown, and never on its own evidence beans', () => {
    const { triggers } = watcher();
    expect(automationFires(triggers, landing(null), ACTOR)).toBe(true);
    expect(automationFires(triggers, landing(['src/billing/a.ts'], ACTOR), ACTOR)).toBe(false);
  });

  it('asks for the commit’s files only when a paths filter needs them', () => {
    const { triggers } = watcher();
    expect(needsChangedPaths([triggers], landing(null))).toBe(true);
    expect(
      needsChangedPaths(
        [[{ kind: 'beanstalk', event: 'bean_landed', beans: [], authors: [] }]],
        landing(null),
      ),
    ).toBe(false);
  });

  it('compiles to one agent job the workflow parser reads back', async () => {
    const file = watcher();
    const source = compileAutomation({ name: file.name, info: file.info });
    const workflow = await readWorkflowFile(PATH, source, LIMITS);
    expect(workflow.problems).toEqual([]);
    expect(workflow.jobs.map((job) => job.key)).toEqual(['agent']);
    expect(workflow.jobs[0]?.contentsWrite).toBe(true);
  });
});

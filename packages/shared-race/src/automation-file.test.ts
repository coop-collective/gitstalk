import { describe, expect, it } from 'vitest';

import { readAutomationFile } from './automation-file';
import { DEFAULT_AUTOMATION_MODEL } from './automation-models';

const LIMITS = { maxTimeoutMinutes: 60 };

const FIX_RED = `name: Fix red beans
on:
  bean_red:
    beans: ['fix-*', '!fix-skip']
  schedule: [{ cron: '0 9 * * 1' }]
permissions:
  beans: write
secrets: [linear_key]
timeout-minutes: 90
max-cost-usd: 1.5
prompt: |
  Read why the bean went red and fix it.
`;

describe('reading an automation file', () => {
  it('reads triggers, the agent, permissions, secrets, memory and limits', () => {
    const file = readAutomationFile('.beanstalk/automations/fix-red.yml', FIX_RED, LIMITS);
    expect(file.problems).toEqual([]);
    expect(file.name).toBe('Fix red beans');
    expect(file.triggers).toEqual([
      { kind: 'beanstalk', event: 'bean_red', beans: ['fix-*', '!fix-skip'], authors: [] },
      { kind: 'schedule', crons: ['0 9 * * 1'] },
      { kind: 'workflow_dispatch', inputs: [] },
    ]);
    expect(file.info).toEqual({
      id: 'fix-red',
      harness: 'agent',
      model: DEFAULT_AUTOMATION_MODEL,
      prompt: 'Read why the bean went red and fix it.\n',
      permissions: { beans: 'write' },
      secrets: ['LINEAR_KEY'],
      timeoutMinutes: 60,
      maxTurns: 40,
      maxCostUsd: 1.5,
      memoryRef: 'refs/automations/fix-red/memory',
      actor: 'fix-red[automation]',
    });
    expect(file.notes).toEqual([
      {
        feature: 'timeout-minutes',
        verdict: 'runs-differently',
        detail: 'timeout-minutes is capped at 60',
      },
    ]);
  });

  it('takes the prompt from the body of a .md file with front matter', () => {
    const file = readAutomationFile(
      '.beanstalk/automations/Triage.md',
      '---\non: validation_red\nmemory: false\n---\n\nFind the failing test.\n',
      LIMITS,
    );
    expect(file.problems).toEqual([]);
    expect(file.info).toMatchObject({
      id: 'triage',
      prompt: 'Find the failing test.',
      memoryRef: null,
      permissions: { beans: 'read' },
    });
    expect(file.triggers[0]).toEqual({
      kind: 'beanstalk',
      event: 'validation_red',
      beans: [],
      authors: [],
    });
  });

  it('runs a shell script without a model', () => {
    const file = readAutomationFile(
      '.beanstalk/automations/note.yml',
      'on: [bean_landed, stalk_moved]\nharness: shell\nrun: echo hi >> "$BEANSTALK_MEMORY/log"\n',
      LIMITS,
    );
    expect(file.problems).toEqual([]);
    expect(file.info).toMatchObject({ harness: 'shell', model: null, prompt: expect.any(String) });
    expect(file.triggers.map((trigger) => trigger.kind)).toEqual([
      'beanstalk',
      'beanstalk',
      'workflow_dispatch',
    ]);
  });

  it('reports problems with their lines and does not run the file', () => {
    const file = readAutomationFile(
      '.beanstalk/automations/broken.yml',
      'name: Broken\non:\n  pull_request:\nharness: agent\nmodel: gpt-9\nfoo: 1\n',
      LIMITS,
    );
    expect(file.info).toBeNull();
    expect(file.problems.map((problem) => problem.message)).toEqual([
      expect.stringContaining('model: not a model automations may use'),
      expect.stringContaining('unknown key foo'),
    ]);
    expect(file.problems[0]?.line).toBe(5);
    expect(file.problems[1]?.line).toBe(6);
  });

  it('refuses an unknown event, a bad cron and an agent without a prompt', () => {
    const file = readAutomationFile(
      '.beanstalk/automations/bad.yml',
      'on:\n  pull_request:\n  schedule: [{ cron: "every day" }]\n',
      LIMITS,
    );
    expect(file.problems.map((problem) => problem.message)).toEqual([
      expect.stringContaining('on: pull_request is not an automation trigger'),
      expect.stringContaining('on: schedule every day is not valid'),
      'prompt: an agent automation needs a prompt',
    ]);
    expect(file.problems[0]?.line).toBe(1);
  });

  it('filters a landing by the files it changed, and says how in the compatibility report', () => {
    const file = readAutomationFile(
      '.gitstalk/automations/billing-watcher.yml',
      "on:\n  bean_landed:\n    paths: ['src/billing/**', '!src/billing/**/*.md']\nprompt: Review it.\n",
      LIMITS,
    );
    expect(file.problems).toEqual([]);
    expect(file.triggers[0]).toEqual({
      kind: 'beanstalk',
      event: 'bean_landed',
      beans: [],
      authors: [],
      paths: ['src/billing/**', '!src/billing/**/*.md'],
    });
    expect(file.notes).toEqual([
      expect.objectContaining({ feature: 'bean_landed paths', verdict: 'runs-differently' }),
    ]);
  });

  it('refuses paths: on an event that names no single commit, and a paths list of only !', () => {
    const red = readAutomationFile(
      '.gitstalk/automations/x.yml',
      "on:\n  bean_red:\n    paths: ['src/**']\nprompt: x\n",
      LIMITS,
    );
    expect(red.problems.map((problem) => problem.message)).toEqual([
      expect.stringContaining('bean_red has no single commit to filter by paths:'),
    ]);
    const negated = readAutomationFile(
      '.gitstalk/automations/x.yml',
      "on:\n  bean_landed:\n    paths: ['!docs/**']\nprompt: x\n",
      LIMITS,
    );
    expect(negated.problems[0]?.message).toContain('a filter of only ! patterns matches nothing');
  });

  it('reports YAML syntax errors with a line', () => {
    const file = readAutomationFile(
      '.beanstalk/automations/syntax.yml',
      'on: [bean_red\nprompt: x\n',
      LIMITS,
    );
    expect(file.info).toBeNull();
    expect(file.problems[0]?.line).not.toBeNull();
  });
});

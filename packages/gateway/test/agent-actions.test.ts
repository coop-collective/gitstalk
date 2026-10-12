import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import type { AgentPrincipal } from '@gitstalk/shared-race/agent-repos';
import type { RepositoryRecord } from '@gitstalk/shared-race/repos';
import type { RpcResult } from '@gitstalk/shared-race/rpc';
import { PersonalTokenInput, createPersonalToken } from '@gitstalk/shared-identity/user-tokens';
import { insertUser } from '@gitstalk/shared-identity/users';

import { call, pkt, sha } from './helpers';

/**
 * `AgentActionsRpc` end to end on Miniflare (doc 23 §5): an MCP session's view of Actions. A
 * bean lands, the stalk moves (a push to main), the push run runs on the stub executor; the
 * session follows it by the bean, reads the failing step's log, dispatches, cancels and
 * re-runs, and sets secrets and variables, each under the scope and role the web would ask.
 */
const gateway = exports.default;
const ZERO = '0'.repeat(40);
const SECRET_VALUE = 'cf-api-token-agent-9f3b2c';

const CI = `name: CI
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      who: { type: string, default: world }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Greet
        run: echo hello \${{ inputs.who }}
      - name: Deploy
        run: echo deploying with \${{ secrets.CLOUDFLARE_API_TOKEN }}
  broken:
    runs-on: ubuntu-latest
    steps:
      - name: Lint
        run: echo lint failed in src/a.ts
      - name: Fail
        run: exit 3
`;
const HANG = `name: Hang
on:
  workflow_dispatch:
jobs:
  wait:
    runs-on: ubuntu-latest
    steps:
      - run: sleep 600
`;
const BY_HAND = 'name: By hand\non:\n  workflow_dispatch:\nharness: shell\nrun: echo hi\n';
const ON_LAND =
  'name: On land\non:\n  bean_landed:\n    beans: [nothing-matches]\nharness: shell\nrun: echo landed\n';

type Person = { readonly id: string; readonly handle: string; readonly token: string };

let coop: Person;
let repo: RepositoryRecord;
let slugName: string;

beforeAll(async () => {
  coop = await signUp('aa-coop');
  repo = value(
    await gateway.createRepository(coop, {
      name: 'deploy-app',
      visibility: 'private',
      start: { kind: 'empty' },
    }),
  );
  slugName = `${coop.handle}/${repo.name}`;
  value(
    await gateway.agentPutSecret(agent(coop, ['read', 'secrets']), slugName, {
      name: 'cloudflare_api_token',
      value: SECRET_VALUE,
    }),
  );
  const pushed = await pushFiles(coop, 'bean/add-ci', {
    '.github/workflows/ci.yml': CI,
    '.github/workflows/hang.yml': HANG,
    '.gitstalk/automations/by-hand.yml': BY_HAND,
    '.gitstalk/automations/on-land.yml': ON_LAND,
  });
  expect(pushed.status).toBe(200);
});

describe('agent Actions: following a landing', () => {
  it('waits by bean for the push run its landing started, with the failing step and its log', async () => {
    const waited = value(
      await gateway.agentWaitRun(agent(coop, ['read']), slugName, { bean: 'add-ci', seconds: 60 }),
    );
    expect(waited).toMatchObject({
      outcome: 'completed',
      bean: { bean: 'add-ci', phase: 'green' },
    });
    expect(waited.runs).toHaveLength(1);
    const [run] = waited.runs;
    expect(run).toMatchObject({
      workflow: '.github/workflows/ci.yml',
      event: 'push',
      ref: 'refs/heads/main',
      conclusion: 'failure',
      beans: ['add-ci'],
    });
    expect(run?.failures).toEqual([
      { job: 'broken', step: 'Fail', log_tail: expect.stringContaining('[Lint] lint failed') },
    ]);
    expect(JSON.stringify(waited)).not.toContain(SECRET_VALUE);
  });

  it('lists workflows with triggers and dispatch inputs, and runs by workflow, bean and sha', async () => {
    const listed = value(await gateway.agentWorkflows(agent(coop, ['read']), slugName));
    const ci = listed.workflows.find((workflow) => workflow.path === '.github/workflows/ci.yml');
    expect(ci).toMatchObject({
      name: 'CI',
      kind: 'workflow',
      state: 'active',
      triggers: ['push (main)', 'workflow_dispatch'],
      jobs: ['build', 'broken'],
    });
    expect(ci?.dispatch_inputs?.[0]).toMatchObject({ name: 'who', default: 'world' });
    const byBean = value(
      await gateway.agentRuns(agent(coop, ['read']), slugName, { bean: 'add-ci' }),
    );
    expect(byBean.runs.map((run) => run.workflow)).toEqual(['.github/workflows/ci.yml']);
    const [first] = byBean.runs;
    const bySha = value(
      await gateway.agentRuns(agent(coop, ['read']), slugName, {
        workflow: 'ci.yml',
        sha: first?.sha.slice(0, 10) ?? '',
      }),
    );
    expect(bySha.runs.map((run) => run.id)).toEqual([first?.id]);
    expect(
      value(await gateway.agentRuns(agent(coop, ['read']), slugName, { branch: 'feature' })).runs,
    ).toEqual([]);
  });

  it('reads a job log by tail and grep, masked and bounded', async () => {
    const run = await firstPushRun();
    const build = value(
      await gateway.agentJobLog(agent(coop, ['read']), slugName, { run: run.id, job: 'build' }),
    );
    expect(build.text).toContain('[Deploy] deploying with ***');
    expect(build.text).not.toContain(SECRET_VALUE);
    const grepped = value(
      await gateway.agentJobLog(agent(coop, ['read']), slugName, {
        run: run.id,
        job: 'build',
        grep: 'WITH ***',
      }),
    );
    expect(grepped).toMatchObject({
      matched: 1,
      lines_shown: 1,
      text: '[Deploy] deploying with ***',
    });
    const tail = value(
      await gateway.agentJobLog(agent(coop, ['read']), slugName, {
        run: run.id,
        job: 'build',
        tail: 1,
      }),
    );
    expect(tail).toMatchObject({ lines_shown: 1, truncated: true });
    const failed = value(
      await gateway.agentJobLog(agent(coop, ['read']), slugName, { run: run.id }),
    );
    expect(failed.job.name).toBe('broken');
  });

  it('describes a run with its jobs, steps, durations and the beans that triggered it', async () => {
    const run = value(
      await gateway.agentRun(agent(coop, ['read']), slugName, (await firstPushRun()).id),
    );
    expect(run.beans).toEqual(['add-ci']);
    const broken = run.jobs.find((job) => job.key === 'broken');
    expect(broken).toMatchObject({ conclusion: 'failure', failed_step: 'Fail' });
    expect(broken?.steps.map((step) => step.name)).toEqual(['Lint', 'Fail']);
  });
});

describe('agent Actions: runs need the maintain role and the write scope', () => {
  it('dispatches with inputs, cancels and re-runs; waiting is bounded', async () => {
    const owner = agent(coop, ['read', 'write']);
    const started = value(
      await gateway.agentDispatch(owner, slugName, { workflow: 'CI', inputs: { who: 'agents' } }),
    );
    expect(started).toMatchObject({
      event: 'workflow_dispatch',
      workflow: '.github/workflows/ci.yml',
    });
    const done = value(
      await gateway.agentWaitRun(owner, slugName, { run: started.id, seconds: 30 }),
    );
    expect(done.outcome).toBe('completed');
    expect(
      value(
        await gateway.agentJobLog(owner, slugName, {
          run: started.id,
          job: 'build',
          grep: 'hello agents',
        }),
      ).text,
    ).toBe('[Greet] hello agents');

    const again = value(await gateway.agentRerun(owner, slugName, started.id));
    expect(again).toMatchObject({
      event: 'workflow_dispatch',
      sha: started.sha,
      actor: coop.handle,
    });
    expect(again.id).not.toBe(started.id);
    const rerunDone = value(
      await gateway.agentWaitRun(owner, slugName, { run: again.id, seconds: 30 }),
    );
    expect(rerunDone.runs[0]?.inputs).toEqual({ who: 'agents' });

    const hang = value(await gateway.agentDispatch(owner, slugName, { workflow: 'hang.yml' }));
    const before = Date.now();
    const bounded = value(
      await gateway.agentWaitRun(owner, slugName, { run: hang.id, seconds: 2 }),
    );
    expect(bounded.outcome).toBe('running');
    expect(Date.now() - before).toBeLessThan(8000);
    expect((await gateway.agentRerun(owner, slugName, hang.id)).ok).toBe(false);
    value(await gateway.agentCancel(owner, slugName, hang.id));
    const cancelled = value(
      await gateway.agentWaitRun(owner, slugName, { run: hang.id, seconds: 30 }),
    );
    expect(cancelled.runs[0]?.conclusion).toBe('cancelled');
  });

  it('re-runs a push run as a push of the same commit and beans', async () => {
    const run = await firstPushRun();
    const again = value(await gateway.agentRerun(agent(coop, ['read', 'write']), slugName, run.id));
    expect(again).toMatchObject({ event: 'push', sha: run.sha });
    const detail = value(await gateway.agentRun(agent(coop, ['read']), slugName, again.id));
    expect(detail.beans).toEqual(['add-ci']);
  });

  it('refuses a read-only session, a write collaborator, and strangers', async () => {
    const readOnly = await gateway.agentDispatch(agent(coop, ['read']), slugName, {
      workflow: 'CI',
    });
    expect(error(readOnly)).toMatchObject({ code: 'insufficient_scope', status: 403 });
    const writer = await collaborator(repo, 'write');
    const asWriter = await gateway.agentDispatch(agent(writer, ['read', 'write']), slugName, {
      workflow: 'CI',
    });
    expect(error(asWriter)).toMatchObject({ code: 'forbidden', status: 403 });
    expect(error(asWriter).message).toContain('maintain role');
    const run = await firstPushRun();
    expect(
      error(await gateway.agentRerun(agent(writer, ['read', 'write']), slugName, run.id)).code,
    ).toBe('forbidden');
    expect(
      error(await gateway.agentCancel(agent(writer, ['read', 'write']), slugName, run.id)).code,
    ).toBe('forbidden');
    // A writer still reads runs and logs.
    expect((await gateway.agentRun(agent(writer, ['read']), slugName, run.id)).ok).toBe(true);
    const stranger = await signUp('aa-stranger');
    expect(error(await gateway.agentRuns(agent(stranger, ['read']), slugName, {})).status).toBe(
      404,
    );
    expect(error(await gateway.agentRun(agent(stranger, ['read']), slugName, run.id)).status).toBe(
      404,
    );
  });

  it('a maintainer runs workflows', async () => {
    const maintainer = await collaborator(repo, 'maintain');
    const started = value(
      await gateway.agentDispatch(agent(maintainer, ['read', 'write']), slugName, {
        workflow: 'ci.yml',
      }),
    );
    expect(started.actor).toBe(maintainer.handle);
  });
});

describe('agent Actions: secrets and variables', () => {
  it('lists secret names only, to anyone with a role', async () => {
    const reader = await collaborator(repo, 'read');
    const listed = value(await gateway.agentActionsEntries(agent(reader, ['read']), slugName));
    expect(listed.secrets).toEqual([
      expect.objectContaining({
        name: 'CLOUDFLARE_API_TOKEN',
        level: 'repository',
        preland_allowed: false,
        updated_by: coop.handle,
      }),
    ]);
    expect(listed.can_manage).toBe(false);
    expect(JSON.stringify(listed)).not.toContain(SECRET_VALUE);
  });

  it('sets secrets only with the secrets scope and the maintain role, never returning the value', async () => {
    const withoutScope = await gateway.agentPutSecret(agent(coop, ['read', 'write']), slugName, {
      name: 'NEXT',
      value: 'v-1',
    });
    expect(error(withoutScope)).toMatchObject({ code: 'insufficient_scope', status: 403 });
    expect(error(withoutScope).message).toContain('secrets scope');
    const writer = await collaborator(repo, 'write');
    expect(
      error(
        await gateway.agentPutSecret(agent(writer, ['read', 'write', 'secrets']), slugName, {
          name: 'NEXT',
          value: 'v-2',
        }),
      ).code,
    ).toBe('forbidden');
    const saved = value(
      await gateway.agentPutSecret(agent(coop, ['read', 'secrets']), slugName, {
        name: 'next',
        value: 'value-that-stays-hidden',
      }),
    );
    expect(saved).toMatchObject({ name: 'NEXT', level: 'repository', updated_by: coop.handle });
    expect(JSON.stringify(saved)).not.toContain('value-that-stays-hidden');
    const people = value(await gateway.repositoryPeople(repo.id, coop.id));
    expect(people.audit).toContainEqual(
      expect.objectContaining({
        action: 'actions-secret-set',
        detail: 'NEXT · via Claude Code (MCP)',
      }),
    );
    expect(JSON.stringify(people)).not.toContain('value-that-stays-hidden');
    const deleted = value(
      await gateway.agentDeleteSecret(agent(coop, ['read', 'secrets']), slugName, { name: 'next' }),
    );
    expect(deleted).toMatchObject({ name: 'NEXT', deleted: true });
    const org = await gateway.agentPutSecret(agent(coop, ['read', 'secrets']), slugName, {
      name: 'ORG_ONE',
      value: 'x',
      level: 'organization',
    });
    expect(error(org).message).toContain('belongs to a person');
  });

  it('sets and deletes variables, readable by any role', async () => {
    const owner = agent(coop, ['read', 'secrets']);
    value(
      await gateway.agentPutVariable(owner, slugName, { name: 'account_id', value: 'acc-123' }),
    );
    const listed = value(await gateway.agentActionsEntries(agent(coop, ['read']), slugName));
    expect(listed.variables).toEqual([
      expect.objectContaining({ name: 'ACCOUNT_ID', value: 'acc-123', level: 'repository' }),
    ]);
    expect(
      error(
        await gateway.agentPutVariable(agent(coop, ['read', 'write']), slugName, {
          name: 'X',
          value: 'y',
        }),
      ).code,
    ).toBe('insufficient_scope');
    expect(
      value(await gateway.agentDeleteVariable(owner, slugName, { name: 'ACCOUNT_ID' })).deleted,
    ).toBe(true);
  });
});

describe('agent Actions: automations', () => {
  it('reads an automation with its file and runs, and runs it now', async () => {
    const reader = agent(coop, ['read']);
    const byHand = value(await gateway.agentAutomation(reader, slugName, 'by-hand'));
    expect(byHand).toMatchObject({
      path: '.gitstalk/automations/by-hand.yml',
      harness: 'shell',
      file: BY_HAND,
    });
    const onLand = value(await gateway.agentAutomation(reader, slugName, 'on-land.yml'));
    expect(onLand.events).toEqual(['bean_landed']);
    const owner = agent(coop, ['read', 'write']);
    const started = value(await gateway.agentRunAutomation(owner, slugName, 'On land'));
    expect(started).toMatchObject({
      automation: '.gitstalk/automations/on-land.yml',
      run: { kind: 'automation', event: 'workflow_dispatch' },
    });
    const waited = value(
      await gateway.agentWaitRun(owner, slugName, { run: started.run.id, seconds: 30 }),
    );
    expect(waited.runs[0]?.conclusion).toBe('success');
    const runs = value(await gateway.agentAutomation(reader, slugName, 'on-land')).runs;
    expect(runs.map((run) => run.id)).toContain(started.run.id);
    expect(error(await gateway.agentRunAutomation(reader, slugName, 'on-land')).code).toBe(
      'insufficient_scope',
    );
    expect(error(await gateway.agentAutomation(reader, slugName, 'missing')).status).toBe(404);
  });
});

function agent(
  person: { readonly id: string; readonly handle: string },
  scopes: readonly string[],
): AgentPrincipal {
  return { user: { id: person.id, handle: person.handle }, scopes, label: 'Claude Code' };
}

async function firstPushRun() {
  const runs = value(
    await gateway.agentRuns(agent(coop, ['read']), slugName, { bean: 'add-ci' }),
  ).runs;
  const run = runs.at(-1);
  if (run === undefined) throw new Error('no push run');
  return run;
}

let people = 0;

async function collaborator(record: RepositoryRecord, role: 'read' | 'write' | 'maintain') {
  people += 1;
  const member = await signUp(`aa-${role}-${people}`);
  const invitation = value(
    await gateway.inviteCollaborator(coop, record.id, { handle: member.handle, role }),
  );
  value(await gateway.answerInvitation(member, invitation.id, 'accept'));
  return member;
}

/** Pushes one bean carrying `files` (the fake remote reads the JSON pack). */
async function pushFiles(
  person: Person,
  branch: string,
  files: Record<string, string>,
): Promise<Response> {
  const head = await sha(`${repo.id}:${branch}`);
  const commits = { [head]: { message: `Add ${branch}`, parents: [], files } };
  const body = `${pkt(`${ZERO} ${head} refs/heads/${branch}\0report-status side-band-64k\n`)}0000PACK${JSON.stringify({ commits })}`;
  return call('POST', `/git/${repo.owner.handle}/${repo.name}.git/git-receive-pack`, {
    token: person.token,
    body,
    headers: {
      'content-type': 'application/x-git-receive-pack-request',
      accept: 'application/x-git-receive-pack-result',
    },
  });
}

async function signUp(handle: string): Promise<Person> {
  const id = `u_${handle.replace(/-/g, '_')}`;
  await insertUser(env, { id, handle, email: null }, Date.now()).run();
  const pat = await createPersonalToken(env, {
    userId: id,
    request: PersonalTokenInput.parse({ name: 'laptop', scopes: ['read', 'write'], days: 7 }),
  });
  return { id, handle, token: pat.token };
}

function value<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function error<T>(result: RpcResult<T>) {
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
}

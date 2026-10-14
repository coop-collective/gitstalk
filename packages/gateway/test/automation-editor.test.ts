import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { AutomationBeanStatus } from '@gitstalk/shared-race/automation-editor';
import type { RepositoryRecord } from '@gitstalk/shared-race/repos';
import type { RpcResult } from '@gitstalk/shared-race/rpc';
import { PersonalTokenInput, createPersonalToken } from '@gitstalk/shared-identity/user-tokens';
import { insertUser } from '@gitstalk/shared-identity/users';

import { call, pkt, sha } from './helpers';

/**
 * The automation builder end to end on Miniflare (doc 25 §7.13): opening a file at the latest
 * landed commit, a save that is a bean built in the Worker (its real pack read by the fake) and
 * lands through the engine, a save refused as stale when the file changed meanwhile, deleting,
 * validation with the shared parser, who may save (write; maintain for a protected path), and
 * a test run of a draft.
 */
const gateway = exports.default;
const actions = exports.Actions;
const ZERO = '0'.repeat(40);
const HEARTBEAT = '.beanstalk/automations/heartbeat.yml';
const NIGHTLY = '.beanstalk/automations/nightly.yml';

const HEARTBEAT_FILE = `# Beats every hour.
name: Heartbeat
on:
  schedule: [{ cron: "0 * * * *" }]
harness: shell
run: echo beat >> "$GITSTALK_MEMORY/beats.log"
`;
const NIGHTLY_FILE = `name: Nightly notes
on:
  bean_landed:
    beans: ['*']
prompt: |
  Note what landed today.
`;

type Person = { readonly id: string; readonly handle: string; readonly token: string };

let coop: Person;
let dana: Person;
let erin: Person;
let repo: RepositoryRecord;
let nightlyBean: string;

beforeAll(async () => {
  [coop, dana, erin] = await Promise.all([signUp('ed-coop'), signUp('ed-dana'), signUp('ed-erin')]);
  repo = await createRepo('editor-e2e');
  await Promise.all([invite(repo, dana, 'read'), invite(repo, erin, 'write')]);
  expect(
    (await pushFiles(repo, 'bean/seed', { [HEARTBEAT]: HEARTBEAT_FILE, 'src/a.ts': 'export {}\n' }))
      .status,
  ).toBe(200);
  await waitForLanded(repo, HEARTBEAT, HEARTBEAT_FILE);
}, 40_000);

describe('opening an automation', () => {
  it('reads the file, its blob and the commit at the latest landed commit', async () => {
    const source = value(await gateway.automationSource(coop.id, repo.id, HEARTBEAT));
    expect(source.content).toBe(HEARTBEAT_FILE);
    expect(source.base.blob).toMatch(/^[0-9a-f]{40}$/);
    expect(source.save).toEqual({ kind: 'allowed' });
    expect(source.canTestRun).toBe(true);
    expect(source.protectedBy).toBeNull();
  });

  it('opens a new file as absent', async () => {
    const source = value(await gateway.automationSource(coop.id, repo.id, NIGHTLY));
    expect(source).toMatchObject({ content: null, base: { blob: null } });
  });
});

describe('saving is a bean', () => {
  it('pushes a new automation as bean/automation-<slug>-<short>, which lands', async () => {
    const source = value(await gateway.automationSource(coop.id, repo.id, NIGHTLY));
    const saved = value(
      await gateway.saveAutomation(coop.id, repo.id, {
        path: NIGHTLY,
        base: source.base,
        content: NIGHTLY_FILE,
      }),
    );
    if (saved.kind !== 'pushed') throw new Error('expected a pushed bean');
    expect(saved.bean).toMatch(/^automation-nightly-[0-9a-f]{6}$/);
    nightlyBean = saved.bean;
    const status = await waitForBean(repo, saved.bean);
    expect(['landed', 'green']).toContain(status.phase);
    await waitForLanded(repo, NIGHTLY, NIGHTLY_FILE);
    await vi.waitFor(
      async () => {
        const listed = value(await actions.listWorkflows(coop.id, repo.id));
        const nightly = listed.find((workflow) => workflow.path === NIGHTLY);
        if (nightly === undefined) throw new Error('not indexed yet');
        expect(nightly.name).toBe('Nightly notes');
      },
      { timeout: 20_000, interval: 100 },
    );
  }, 60_000);

  it("counts the bean's files in its history: the commit step names what the push changed", async () => {
    const page = value(await gateway.runEvents(repo.engine_id, 0, 1000));
    const commits = page.events
      .map((line): unknown => JSON.parse(line))
      .filter(
        (event) =>
          typeof event === 'object' &&
          event !== null &&
          Reflect.get(event, 'type') === 'task.commit' &&
          Reflect.get(event, 'task') === nightlyBean,
      );
    expect(commits).toEqual([expect.objectContaining({ files: [NIGHTLY] })]);
  });

  it('authors the commit as the person, with the default message', async () => {
    const log = value(await gateway.repoLog(repo.engine_id, 'sprout', [NIGHTLY], 5));
    expect(log.commits.some((commit) => commit.message.includes('nightly.yml'))).toBe(true);
  });

  it('refuses a file the shared validator rejects, with its line', async () => {
    const source = value(await gateway.automationSource(coop.id, repo.id, NIGHTLY));
    const refused = await gateway.saveAutomation(coop.id, repo.id, {
      path: NIGHTLY,
      base: source.base,
      content: 'name: Broken\non:\n  pull_request:\nprompt: x\n',
    });
    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    if (refused.ok) return;
    expect(refused.error.message).toContain('nightly.yml:2');
  });

  it('answers stale with the newer version when the file changed since it was opened', async () => {
    const opened = value(await gateway.automationSource(coop.id, repo.id, HEARTBEAT));
    const theirs = HEARTBEAT_FILE.replace('0 * * * *', '30 * * * *');
    expect((await pushFiles(repo, 'bean/their-edit', { [HEARTBEAT]: theirs })).status).toBe(200);
    await waitForLanded(repo, HEARTBEAT, theirs);
    const mine = HEARTBEAT_FILE.replace('name: Heartbeat', 'name: Pulse');
    const stale = value(
      await gateway.saveAutomation(coop.id, repo.id, {
        path: HEARTBEAT,
        base: opened.base,
        content: mine,
      }),
    );
    if (stale.kind !== 'stale') throw new Error('expected stale');
    expect(stale.theirs.content).toBe(theirs);
    expect(stale.theirs.base.blob).not.toBe(opened.base.blob);
    const merged = mine.replace('0 * * * *', '30 * * * *');
    const saved = value(
      await gateway.saveAutomation(coop.id, repo.id, {
        path: HEARTBEAT,
        base: stale.theirs.base,
        content: merged,
      }),
    );
    expect(saved.kind).toBe('pushed');
    await waitForLanded(repo, HEARTBEAT, merged);
  }, 60_000);

  it('deletes with a bean whose commit no longer has the file', async () => {
    const source = value(await gateway.automationSource(coop.id, repo.id, NIGHTLY));
    const saved = value(
      await gateway.saveAutomation(coop.id, repo.id, {
        path: NIGHTLY,
        base: source.base,
        content: null,
      }),
    );
    if (saved.kind !== 'pushed') throw new Error('expected a pushed bean');
    const file = await gateway.repoFile(repo.engine_id, saved.commit, NIGHTLY);
    expect(file.ok).toBe(false);
    const kept = value(await gateway.repoFile(repo.engine_id, saved.commit, HEARTBEAT));
    expect(kept.content).toContain('Pulse');
  });
});

const RETRY = '.gitstalk/automations/retry.yml';
const RETRY_FILE = HEARTBEAT_FILE.replace('name: Heartbeat', 'name: Retry');

describe('a save goes through the server-side commit flow', () => {
  it('makes one bean of a double-clicked save, and answers a retry after it landed with it', async () => {
    const source = value(await gateway.automationSource(coop.id, repo.id, RETRY));
    const save = { path: RETRY, base: source.base, content: RETRY_FILE, idempotencyKey: 'retry-1' };
    const [first, second] = await Promise.all([
      gateway.saveAutomation(coop.id, repo.id, save),
      gateway.saveAutomation(coop.id, repo.id, save),
    ]);
    const saved = value(first);
    if (saved.kind !== 'pushed') throw new Error('expected a pushed bean');
    expect(value(second)).toEqual(saved);
    await waitForBean(repo, saved.bean);
    await waitForLanded(repo, RETRY, RETRY_FILE);
    expect(value(await gateway.saveAutomation(coop.id, repo.id, save))).toEqual(saved);
  }, 60_000);

  it('refuses a key used before with other text', async () => {
    const source = value(await gateway.automationSource(coop.id, repo.id, RETRY));
    const refused = await gateway.saveAutomation(coop.id, repo.id, {
      path: RETRY,
      base: source.base,
      content: RETRY_FILE.replace('Retry', 'Retried'),
      idempotencyKey: 'retry-1',
    });
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'conflict', message: expect.stringContaining('idempotency key') },
    });
  });

  it("applies bean_commit's size cap to an editor's file", async () => {
    const source = value(await gateway.automationSource(coop.id, repo.id, RETRY));
    const refused = await gateway.saveAutomation(coop.id, repo.id, {
      path: RETRY,
      base: source.base,
      // 50,000 characters, 150,000 bytes: within the editor's length, over the commit's cap.
      content: `${RETRY_FILE}# ${'€'.repeat(50_000)}\n`,
    });
    expect(refused).toMatchObject({
      ok: false,
      error: { status: 400, message: expect.stringContaining('at most') },
    });
  });
});

describe('who may save', () => {
  it('refuses a reader: saving pushes a bean, which needs write', async () => {
    const source = value(await gateway.automationSource(dana.id, repo.id, HEARTBEAT));
    expect(source.save).toMatchObject({ kind: 'refused' });
    const refused = await gateway.saveAutomation(dana.id, repo.id, {
      path: HEARTBEAT,
      base: source.base,
      content: HEARTBEAT_FILE,
    });
    expect(refused).toMatchObject({ ok: false, error: { status: 403 } });
  });

  it('lets a writer save an unprotected file but not start a test run', async () => {
    const source = value(await gateway.automationSource(erin.id, repo.id, HEARTBEAT));
    expect(source).toMatchObject({ save: { kind: 'allowed' }, canTestRun: false });
    const refused = await gateway.testAutomation(erin.id, repo.id, {
      path: HEARTBEAT,
      content: HEARTBEAT_FILE,
    });
    expect(refused).toMatchObject({ ok: false, error: { status: 403 } });
  });

  it('needs maintain when checks.toml protects the automations folder', async () => {
    const guarded = await createRepo('editor-guarded');
    await invite(guarded, erin, 'write');
    const checks = 'protected_paths = [".beanstalk/**"]\n';
    expect(
      (await pushFiles(guarded, 'bean/protect', { '.beanstalk/checks.toml': checks })).status,
    ).toBe(200);
    await waitForLanded(guarded, '.beanstalk/checks.toml', checks);
    const writer = value(await gateway.automationSource(erin.id, guarded.id, NIGHTLY));
    expect(writer.protectedBy).toBe('.beanstalk/**');
    expect(writer.save).toMatchObject({
      kind: 'refused',
      reason: expect.stringContaining('only maintainers and the owner'),
    });
    const refused = await gateway.saveAutomation(erin.id, guarded.id, {
      path: NIGHTLY,
      base: writer.base,
      content: NIGHTLY_FILE,
    });
    expect(refused).toMatchObject({ ok: false, error: { status: 403 } });
    const owner = value(await gateway.automationSource(coop.id, guarded.id, NIGHTLY));
    expect(owner.save).toEqual({ kind: 'allowed' });
  }, 60_000);
});

describe('a test run of a draft', () => {
  it('runs the draft once by hand without saving it, and never writes its memory', async () => {
    const draft = `name: Draft check\non: bean_red\nharness: shell\nrun: echo draft\n`;
    const path = '.beanstalk/automations/draft-check.yml';
    const started = value(await gateway.testAutomation(coop.id, repo.id, { path, content: draft }));
    const run = await vi.waitFor(
      async () => {
        const detail = value(await actions.getRun(coop.id, started.runId));
        if (detail.status !== 'completed') throw new Error(`run is ${detail.status}`);
        return detail;
      },
      { timeout: 20_000, interval: 50 },
    );
    expect(run).toMatchObject({ workflowPath: path, event: 'workflow_dispatch', actor: 'ed-coop' });
    expect(run.jobs[0]?.steps.map((step) => step.name)).not.toContain('Save memory');
    const source = value(await gateway.automationSource(coop.id, repo.id, path));
    expect(source.content).toBeNull();
  }, 40_000);
});

// Helpers ----------------------------------------------------------------------------------

const RULES = `# yaml-language-server: $schema=https://gitstalk.dev/schemas/policy.json
classes:
  - name: auth
    match: { paths: ["src/auth/**"] }
    route: card
`;

describe('Settings → Rules', () => {
  it('saves the rules as a bean authored by the owner, which lands without a card', async () => {
    const source = value(await gateway.rulesSource(coop.id, repo.id));
    expect(source).toMatchObject({
      path: '.gitstalk/policy.yml',
      content: null,
      save: { kind: 'allowed' },
    });
    const saved = value(
      await gateway.saveRules(coop.id, repo.id, { base: source.base, content: RULES }),
    );
    if (saved.kind !== 'pushed') throw new Error('expected a pushed bean');
    expect(saved.bean).toMatch(/^rules-[0-9a-f]{6}$/);
    const status = await waitForBean(repo, saved.bean);
    expect(['landed', 'green']).toContain(status.phase);
    const route = value(await gateway.beanRoute(repo.engine_id, saved.bean));
    expect(route?.route).toBe('auto');
  });

  it('refuses rules the engine would reject, with the line', async () => {
    const source = value(await gateway.rulesSource(coop.id, repo.id));
    const refused = await gateway.saveRules(coop.id, repo.id, {
      base: source.base,
      content: 'classes:\n  - name: x\n    route: later\n    match: { paths: [a] }\n',
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toBe('.gitstalk/policy.yml:3: must be auto, triage or card');
  });

  it('makes one bean of a rules save sent twice with the same key', async () => {
    const source = value(await gateway.rulesSource(coop.id, repo.id));
    const save = {
      base: source.base,
      content: RULES.replace('route: card', 'route: triage'),
      idempotencyKey: 'rules-twice',
    };
    const first = value(await gateway.saveRules(coop.id, repo.id, save));
    expect(first.kind).toBe('pushed');
    expect(value(await gateway.saveRules(coop.id, repo.id, save))).toEqual(first);
  });

  it('lets a writer read the rules but not save them', async () => {
    const source = value(await gateway.rulesSource(erin.id, repo.id));
    expect(source.save).toMatchObject({ kind: 'refused' });
    const refused = await gateway.saveRules(erin.id, repo.id, {
      base: source.base,
      content: RULES,
    });
    expect(refused.ok === false && refused.error.status).toBe(403);
  });
});

async function waitForBean(on: RepositoryRecord, bean: string): Promise<AutomationBeanStatus> {
  return vi.waitFor(
    async () => {
      const status = value(await gateway.automationBean(coop.id, on.id, bean));
      if (status.phase === 'checking' || status.phase === 'waiting')
        throw new Error(`bean is ${status.phase}`);
      return status;
    },
    { timeout: 20_000, interval: 100 },
  );
}

async function waitForLanded(on: RepositoryRecord, path: string, content: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const file = await gateway.repoFile(on.engine_id, 'sprout', path);
      if (!file.ok || file.value.content !== content) throw new Error(`${path} not landed yet`);
    },
    { timeout: 20_000, interval: 100 },
  );
}

async function createRepo(name: string): Promise<RepositoryRecord> {
  return value(
    await gateway.createRepository(coop, { name, visibility: 'private', start: { kind: 'empty' } }),
  );
}

async function invite(on: RepositoryRecord, who: Person, role: 'read' | 'write'): Promise<void> {
  const invitation = value(
    await gateway.inviteCollaborator(coop, on.id, { handle: who.handle, role }),
  );
  value(await gateway.answerInvitation(who, invitation.id, 'accept'));
}

async function pushFiles(
  on: RepositoryRecord,
  branch: string,
  files: Record<string, string>,
): Promise<Response> {
  const head = await sha(`${on.id}:${branch}`);
  const commits = { [head]: { message: `Add ${branch}`, parents: [], files } };
  const body = `${pkt(`${ZERO} ${head} refs/heads/${branch}\0report-status side-band-64k\n`)}0000PACK${JSON.stringify({ commits })}`;
  return call('POST', `/git/${on.owner.handle}/${on.name}.git/git-receive-pack`, {
    token: coop.token,
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

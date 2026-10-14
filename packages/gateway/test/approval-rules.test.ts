import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { PersonalTokenInput, createPersonalToken } from '@gitstalk/shared-identity/user-tokens';
import { insertUser } from '@gitstalk/shared-identity/users';

import type { Opened } from './git-push-helpers';
import { ZERO, gitResponse, openRepo, push, until } from './git-push-helpers';
import { pkt, sha } from './helpers';

/**
 * Approval rules end to end (`docs/claude-opus/32-approval-rules.md`): a repository engine with
 * `approval_rules` on, its policy pushed and promoted to the stalk, then beans the policy
 * routes. The real Worker and engine Durable Object, the fake Artifacts remote and runner;
 * Workers AI is not bound in tests, so a triage falls back to its rule.
 */

const gateway = exports.default;

const POLICY = `groups:
  security: ["@coop"]
classes:
  - name: protected
    match: { paths: ["src/auth/**"] }
    route: card
    writers: ["@security"]
    reviewers: ["@acme"]
  - name: billing
    match: { paths: ["src/billing/**"] }
    route: auto
    writers: ["@alice"]
  - name: api
    match: { paths: ["src/api/**"] }
    route: triage
`;

/** `git push -o wait` of one commit carrying `files` to `bean/<name>`; the `remote:` lines. */
async function pushFiles(
  opened: Opened,
  token: string,
  bean: { readonly name: string; readonly files: Record<string, string> },
): Promise<string> {
  const head = await sha(`${opened.engineId}:${bean.name}:${JSON.stringify(bean.files)}`);
  const caps = 'report-status side-band-64k push-options agent=git/2.47.0';
  const command = pkt(`${ZERO} ${head} refs/heads/bean/${bean.name}\0${caps}\n`);
  const commits = { [head]: { message: `Change ${bean.name}`, parents: [], files: bean.files } };
  const response = await push(
    opened.git_path,
    token,
    `${command}0000${pkt('wait\n')}0000PACK${JSON.stringify({ commits })}`,
  );
  expect(response.status).toBe(200);
  return (await gitResponse(response)).remote;
}

/** The owner's personal token (the repository's owner is u1, @acme): a person's own credential. */
async function ownerToken(): Promise<string> {
  const user = { id: 'u1', handle: 'acme' };
  await insertUser(env, { ...user, email: null }, Date.now())
    .run()
    .catch(() => undefined);
  const pat = await createPersonalToken(env, {
    userId: user.id,
    request: PersonalTokenInput.parse({ name: 'laptop', scopes: ['read', 'write'], days: 7 }),
  });
  return pat.token;
}

async function withPolicy(repo: string): Promise<{ opened: Opened; token: string }> {
  const repository = await openRepo(repo, { approval_rules: true });
  const remote = await pushFiles(repository.opened, repository.token, {
    name: 'rules',
    files: { '.gitstalk/policy.yml': POLICY },
  });
  // No policy on the stalk yet: the first one lands as every bean did before the rules.
  expect(remote).toContain('LANDED: rules');
  await until(repository.opened.engineId, 'rules', ['green']);
  return repository;
}

describe('approval rules', () => {
  it('reads the policy from the stalk, with its commit', async () => {
    const { opened } = await withPolicy('rules-read');
    const view = await gateway.policyGet(opened.engineId);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.value.path).toBe('.gitstalk/policy.yml');
    expect(view.value.sha).toMatch(/^[0-9a-f]{40}$/u);
    expect(view.value.problems).toEqual([]);
    expect(view.value.policy?.classes.map((entry) => entry.name)).toEqual([
      'protected',
      'billing',
      'api',
    ]);
  });

  it('holds a card bean for a person, with a receipt (approving it: bean-approval.test.ts)', async () => {
    const { opened, token } = await withPolicy('rules-card');
    const remote = await pushFiles(opened, token, {
      name: 'login',
      files: { 'src/auth/login.ts': 'export const login = () => true;\n' },
    });
    expect(remote).toContain('approval rules: protected -> card (policy)');
    expect(remote).toContain("awaiting a person's approval");
    expect(remote).toContain('RED: login was not landed');
    await until(opened.engineId, 'login', ['red']);

    const held = await gateway.beanRoute(opened.engineId, 'login');
    expect(held.ok && held.value).toMatchObject({
      route: 'card',
      class: 'protected',
      by: 'policy',
      principal: '@coop',
      reviewers: ['@acme'],
      approval: { state: 'awaiting', actor: null },
      policy: { path: '.gitstalk/policy.yml', valid: true },
    });

    const pushed = await gateway.pushedBeans(opened.engineId);
    const login = pushed.ok ? pushed.value.find((bean) => bean.bean === 'login') : undefined;
    expect(login?.hold).toMatchObject({ state: 'held', class: 'protected', reviewers: ['@acme'] });
    // An engine with no repository record (opened by an operator) has nobody to approve it.
    const refusal = await gateway.approveBean(opened.engineId, 'login', {
      approver: 'u1',
      client: { kind: 'web' },
    });
    expect(refusal).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('spends no rework round on a hold: the bean waits for a person, not a fix', async () => {
    const { opened, token } = await withPolicy('rules-rounds');
    for (const version of [1, 2]) {
      // oxlint-disable-next-line no-await-in-loop -- the author pushes again after each hold
      const remote = await pushFiles(opened, token, {
        name: 'session',
        files: { 'src/auth/session.ts': `export const session = ${version};\n` },
      });
      expect(remote).toContain("awaiting a person's approval");
      // oxlint-disable-next-line no-await-in-loop -- each hold settles before the next push
      await until(opened.engineId, 'session', ['red']);
    }
    const page = await gateway.runEvents(opened.engineId, 0, 1000);
    expect(page.ok).toBe(true);
    const reworks = (page.ok ? page.value.events : [])
      .map((line): unknown => JSON.parse(line))
      .filter(
        (event) =>
          typeof event === 'object' &&
          event !== null &&
          Reflect.get(event, 'type') === 'rework.start' &&
          Reflect.get(event, 'task') === 'session',
      );
    expect(reworks.map((event) => Reflect.get(Object(event), 'attempt'))).toEqual([0, 0]);
  });

  it('refuses a bean from outside the writers of a class', async () => {
    const { opened, token } = await withPolicy('rules-writers');
    const remote = await pushFiles(opened, token, {
      name: 'pay',
      files: { 'src/billing/pay.ts': 'export const pay = 1;\n' },
    });
    expect(remote).toContain('refused: @coop may not change class billing');
    expect(remote).toContain('changes a class it may not write');
    const route = await gateway.beanRoute(opened.engineId, 'pay');
    expect(route.ok && route.value?.refused).toBe('@coop may not change class billing');
    const pushed = await gateway.pushedBeans(opened.engineId);
    expect(pushed.ok && pushed.value.find((bean) => bean.bean === 'pay')?.hold).toBeNull();
  });

  it('triages by rule when Clef cannot answer, and always cards a policy change', async () => {
    const { opened, token } = await withPolicy('rules-triage');
    await pushFiles(opened, token, {
      name: 'endpoint',
      files: { 'src/api/orders.ts': 'export const orders = [];\n' },
    });
    const triaged = await gateway.beanRoute(opened.engineId, 'endpoint');
    expect(triaged.ok && triaged.value).toMatchObject({ route: 'card', by: 'rules', class: 'api' });

    const loosen = await pushFiles(opened, token, {
      name: 'loosen',
      files: { '.gitstalk/policy.yml': '' },
    });
    expect(loosen).toContain('policy-change');
    const detail = await gateway.beanDetail(opened.engineId, 'loosen');
    expect(detail.ok && detail.value.route).toMatchObject({
      route: 'card',
      class: 'policy-change',
    });
  });

  it("takes the owner's own push of a rule change as the decision", async () => {
    const { opened } = await withPolicy('rules-owner');
    const remote = await pushFiles(opened, await ownerToken(), {
      name: 'tighten',
      files: { '.gitstalk/policy.yml': POLICY.replace('route: auto', 'route: card') },
    });
    expect(remote).toContain('LANDED: tighten');
    const route = await gateway.beanRoute(opened.engineId, 'tighten');
    expect(route.ok && route.value).toMatchObject({ route: 'auto', principal: '@acme' });
    expect(route.ok && route.value?.classes).toContain('policy-change');
  });

  it('routes every bean auto, with no receipt lines, while the stalk has no policy', async () => {
    const { opened, token } = await openRepo('rules-none', { approval_rules: true });
    const remote = await pushFiles(opened, token, {
      name: 'plain',
      files: { 'src/auth/login.ts': 'export const login = 1;\n' },
    });
    expect(remote).toContain('LANDED: plain');
    expect(remote).not.toContain('approval rules');
    const route = await gateway.beanRoute(opened.engineId, 'plain');
    expect(route.ok && route.value).toMatchObject({ route: 'auto', class: null, by: 'policy' });
  });
});

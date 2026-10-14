import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { PersonalTokenInput, createPersonalToken } from '@gitstalk/shared-identity/user-tokens';
import { insertUser } from '@gitstalk/shared-identity/users';

import { ADMIN, call, json, pkt, sha } from './helpers';

/**
 * A repository's own checks (`.gitstalk/checks.yml`, backlog 2.3) end to end: real Worker
 * and engine Durable Object, the fake Artifacts remote, and the fake runner, whose squashes are
 * recorded in the trunk repo with the pushed files on top of the sprout's, so the engine reads
 * the config from the exact merged tree as it does on Cloudflare.
 */

const GIT_UA = { 'user-agent': 'git/2.47.0' };
const ZERO = '0'.repeat(40);
const OWNER = 'checks-owner';

type Opened = { engineId: string; git_path: string };

async function openRepo(repo: string): Promise<{ opened: Opened; agentToken: string }> {
  const response = await call('POST', '/v1/repos', {
    token: ADMIN,
    body: {
      repoName: repo,
      artifactsRepo: `repo-${repo}`,
      owner: { id: `u_${OWNER}`, handle: OWNER },
      create_artifacts_repo: true,
    },
  });
  expect(response.status).toBe(201);
  const opened = await json<Opened>(response);
  const minted = await call('POST', `/v1/repos/${opened.engineId}/git-token`, {
    token: ADMIN,
    body: { user: { id: 'u_agent', handle: 'agent' } },
  });
  return { opened, agentToken: (await json<{ token: string }>(minted)).token };
}

/** The owner's personal token: a person's own credential, which may change protected paths. */
async function ownerToken(): Promise<string> {
  const user = { id: `u_${OWNER}`, handle: OWNER };
  await insertUser(env, { ...user, email: null }, Date.now())
    .run()
    .catch(() => undefined);
  const pat = await createPersonalToken(env, {
    userId: user.id,
    request: PersonalTokenInput.parse({ name: 'laptop', scopes: ['read', 'write'], days: 7 }),
  });
  return pat.token;
}

/** `git push -o wait` of one commit carrying `files` to `bean/<name>`; the remote lines. */
async function pushBean(
  opened: Opened,
  token: string,
  bean: { name: string; files: Record<string, string>; oldSha?: string },
): Promise<{ remote: string; head: string }> {
  const head = await sha(`${opened.engineId}:${bean.name}:${JSON.stringify(bean.files)}`);
  const ref = `refs/heads/bean/${bean.name}`;
  const caps = 'report-status side-band-64k push-options agent=git/2.47.0';
  const command = pkt(`${bean.oldSha ?? ZERO} ${head} ${ref}\0${caps}\n`);
  const commits = { [head]: { message: `Change ${bean.name}`, parents: [], files: bean.files } };
  const response = await call('POST', `${opened.git_path}/git-receive-pack`, {
    body: `${command}0000${pkt('wait\n')}0000PACK${JSON.stringify({ commits })}`,
    headers: {
      ...GIT_UA,
      authorization: `Basic ${btoa(`x:${token}`)}`,
      'content-type': 'application/x-git-receive-pack-request',
      accept: 'application/x-git-receive-pack-result',
    },
  });
  expect(response.status).toBe(200);
  return { remote: sidebandRemote(await response.text()), head };
}

/** Band 2 of a side-band response: the `remote:` lines git prints. */
function sidebandRemote(text: string): string {
  let remote = '';
  let offset = 0;
  while (offset + 4 <= text.length) {
    const length = Number.parseInt(text.slice(offset, offset + 4), 16);
    if (length === 0) {
      offset += 4;
      continue;
    }
    if (text.charCodeAt(offset + 4) === 2) remote += text.slice(offset + 5, offset + length);
    offset += length;
  }
  return remote;
}

type CheckRequest = {
  path: string;
  body: {
    sha: string;
    cmd?: string[];
    env?: Record<string, string>;
    suite_timeout_seconds?: number;
  };
};

/** Every suite the engine's sandboxes asked the fake runner for. */
async function suitesRun(engine: string): Promise<CheckRequest['body'][]> {
  const perInstance = await Promise.all(
    [0, 1, 2, 3].map(async (index) =>
      json<CheckRequest[]>(
        await env.RUNNER.getByName(`run-${engine}-sandbox-${index}`).fetch(
          'http://runner/__requests',
        ),
      ),
    ),
  );
  return perInstance
    .flat()
    .filter((request) => request.path === '/v1/check')
    .map((r) => r.body);
}

const CHECKS = [
  'run: [node, --test, spec/]',
  'timeout-minutes: 1',
  'protected-paths: [migrations/**]',
  'env:',
  '  TZ: UTC',
  '',
].join('\n');

describe("a repository's own checks", () => {
  it("runs the repository's default suite when the tree has no checks file, as before the file was read", async () => {
    const { opened, agentToken } = await openRepo('checks-none');
    const { remote } = await pushBean(opened, agentToken, {
      name: 'plain',
      files: { 'src/a.ts': 'export {};\n' },
    });
    expect(remote).toContain(
      "no .gitstalk/checks.yml on this tree: the repository's default suite runs: node --test (timeout 300 s)",
    );
    expect(remote).toContain('LANDED: plain');
    const suites = await suitesRun(opened.engineId);
    expect(suites).toHaveLength(1);
    expect(suites[0]).toMatchObject({ cmd: ['node', '--test'], suite_timeout_seconds: 300 });
  });

  it("keeps landing beans on a repository holding the starter's older [[check]] draft", async () => {
    const { opened, agentToken } = await openRepo('checks-legacy');
    const draft = [
      '# What a bean must pass before it lands: run on the exact merged tree.',
      '[[check]]',
      'name = "tests"',
      'command = "npm test"',
      'timeout_seconds = 120',
      '',
    ].join('\n');
    const seeded = await pushBean(opened, await ownerToken(), {
      name: 'old-starter',
      files: { '.gitstalk/checks.toml': draft },
    });
    expect(seeded.remote).toContain('LANDED: old-starter');
    const later = await pushBean(opened, agentToken, {
      name: 'after-draft',
      files: { 'src/b.ts': 'export const b = 1;\n' },
    });
    expect(later.remote).toContain(
      ".gitstalk/checks.toml is the older [[check]] draft, which does not choose the suite: the repository's default suite runs: node --test",
    );
    expect(later.remote).toContain('LANDED: after-draft');
    expect(later.remote).not.toContain('RED');
    const suites = await suitesRun(opened.engineId);
    expect(suites).toHaveLength(2);
    for (const suite of suites) expect(suite).toMatchObject({ cmd: ['node', '--test'] });
  });

  it("refuses an agent's change to the checks themselves and says who may make it", async () => {
    const { opened, agentToken } = await openRepo('checks-agent');
    const { remote } = await pushBean(opened, agentToken, {
      name: 'weaken',
      files: { '.gitstalk/checks.yml': 'run: [node, --test, nothing/]\n' },
    });
    expect(remote).toContain(
      'changes protected paths (.gitstalk/checks.yml): refused for an engine token acting for @agent',
    );
    expect(remote).toContain('RED: weaken was not landed');
    expect(remote).toContain('.gitstalk/checks.yml > changes a protected path');
    expect(remote).toContain('Only the owner or a maintainer, pushing with a personal token');
    expect(await suitesRun(opened.engineId)).toEqual([]);
  });

  it("runs the suite the merged tree declares, once the owner pushed it, and protects the owner's paths", async () => {
    const { opened, agentToken } = await openRepo('checks-owned');
    const setup = await pushBean(opened, await ownerToken(), {
      name: 'setup-checks',
      files: { '.gitstalk/checks.yml': CHECKS },
    });
    expect(setup.remote).toContain(
      `changes protected paths (.gitstalk/checks.yml): allowed for @${OWNER} (owner, with a personal token)`,
    );
    expect(setup.remote).toContain(
      'checks from .gitstalk/checks.yml: node --test spec/ (image node, timeout 60 s, env TZ)',
    );
    expect(setup.remote).toContain('LANDED: setup-checks');

    const feature = await pushBean(opened, agentToken, {
      name: 'feature',
      files: { 'src/feature.ts': 'export const on = true;\n' },
    });
    expect(feature.remote).toContain('LANDED: feature');
    const suites = await suitesRun(opened.engineId);
    expect(suites).toHaveLength(2);
    for (const suite of suites) {
      expect(suite).toMatchObject({
        cmd: ['node', '--test', 'spec/'],
        env: { TZ: 'UTC' },
        suite_timeout_seconds: 60,
      });
    }

    const migration = await pushBean(opened, agentToken, {
      name: 'migrate',
      files: { 'migrations/0002.sql': 'select 1;\n' },
    });
    expect(migration.remote).toContain(
      'changes protected paths (migrations/0002.sql): refused for an engine token acting for @agent',
    );
    expect(migration.remote).toContain('RED: migrate was not landed');
    expect(migration.remote).toContain(
      'The sprout protects .gitstalk/checks.yml, .gitstalk/checks.yaml, .gitstalk/checks.toml, .beanstalk/checks.yml, .beanstalk/checks.yaml, .beanstalk/checks.toml, .gitstalk/policy.yml, .beanstalk/policy.yml, migrations/**',
    );
    expect(await suitesRun(opened.engineId)).toHaveLength(2);
  });

  it('answers an invalid file with a red that names every problem, and runs no suite (here the older .beanstalk/ file, still read)', async () => {
    const { opened } = await openRepo('checks-invalid');
    const { remote } = await pushBean(opened, await ownerToken(), {
      name: 'bad-checks',
      files: { '.beanstalk/checks.toml': 'command = "npm test"\nimage = "rust"\n' },
    });
    expect(remote).toContain('.beanstalk/checks.toml is invalid:');
    expect(remote).toContain(
      'command: must be an argv array such as ["node", "--test"]; it never runs through a shell',
    );
    expect(remote).toContain('image: "rust" is not available');
    expect(remote).toContain('RED: bad-checks was not landed');
    expect(remote).toContain('.beanstalk/checks.toml > the checks config is valid');
    expect(await suitesRun(opened.engineId)).toEqual([]);
  });

  it('runs checks.yml over a checks.toml still on the tree, and tells the push to delete the TOML', async () => {
    const { opened } = await openRepo('checks-both');
    const toml = await pushBean(opened, await ownerToken(), {
      name: 'toml-checks',
      files: { '.gitstalk/checks.toml': 'command = ["node", "--test", "old/"]\n' },
    });
    expect(toml.remote).toContain('checks from .gitstalk/checks.toml: node --test old/');
    expect(toml.remote).toContain('TOML still works; .gitstalk/checks.yml is the format now');
    const yaml = await pushBean(opened, await ownerToken(), {
      name: 'yaml-checks',
      files: { '.gitstalk/checks.yml': 'run: [node, --test, new/]\n' },
    });
    expect(yaml.remote).toContain('checks from .gitstalk/checks.yml: node --test new/');
    expect(yaml.remote).toContain(
      '.gitstalk/checks.toml is also on this tree and is not read (.gitstalk/checks.yml wins): delete it (git rm .gitstalk/checks.toml)',
    );
    expect(yaml.remote).toContain('LANDED: yaml-checks');
    const suites = await suitesRun(opened.engineId);
    expect(suites.at(-1)).toMatchObject({ cmd: ['node', '--test', 'new/'] });
  });
});

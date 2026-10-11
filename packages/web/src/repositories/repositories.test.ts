import { describe, expect, it } from 'vitest';

import type { RpcResult } from '@gitstalk/shared-race/rpc';
import type {
  CreateRepositoryInput,
  RepoOwner,
  RepositoriesRpc,
  RepositoryRecord,
  UpdateRepositoryInput,
} from '@gitstalk/shared-race/repos';

import { readCreateForm } from './create-form';
import { growthFromIndex, growthFromView, growthText } from './engine-summary';
import {
  archiveFlow,
  createFlow,
  deleteFlow,
  hasGrown,
  lookupRepository,
  updateFlow,
} from './flows';
import { envVarsBlock, isOldAddress, isReservedOwner, sshEndpoint, startGuide } from './paths';
import { registryClient } from './registry-client';
import { PLUGIN_MCP_URL, agentInstall } from '../setup/agent-installs';

const coop = { id: 'u_dev_coop', handle: 'coop', email: 'coop@dev.beanstalk.invalid' };
const dana = { id: 'u_dana', handle: 'dana', email: 'dana@example.test' };

const fail = (code: string, message: string) => ({
  ok: false as const,
  error: { code, status: code === 'not_found' ? 404 : 409, message },
});
const ok = <T>(value: T): RpcResult<T> => ({ ok: true, value });

/** The registry RPC in memory, with the gateway's rules for names, owners and visibility. */
function fakeGateway(): RepositoriesRpc & { readonly calls: string[] } {
  const records = new Map<string, RepositoryRecord>();
  const calls: string[] = [];
  const taken = (owner: string, name: string, except = '') =>
    [...records.values()].some(
      (r) => r.owner.id === owner && r.name.toLowerCase() === name.toLowerCase() && r.id !== except,
    );
  return {
    calls,
    async createRepository(owner: RepoOwner, input: CreateRepositoryInput) {
      calls.push(`create ${input.name}`);
      if (taken(owner.id, input.name))
        return fail('name_taken', `${owner.handle} already has a repository named ${input.name}`);
      const id = `r${records.size + 1}`.padEnd(12, '0');
      const record: RepositoryRecord = {
        id,
        owner,
        owner_kind: 'user',
        name: input.name,
        description: input.description ?? '',
        visibility: input.visibility,
        origin: input.start,
        artifacts_repo: `repo-${id}`,
        engine_id: id,
        default_branch: 'stalk',
        created_at: '2026-10-07T00:00:00.000Z',
        updated_at: '2026-10-07T00:00:00.000Z',
        archived_at: null,
      };
      records.set(id, record);
      return ok(record);
    },
    async listRepositories(ownerId, viewer, listing = 'active') {
      return ok(
        [...records.values()].filter(
          (r) =>
            r.owner.id === ownerId &&
            (r.visibility === 'public' || viewer === ownerId) &&
            (r.archived_at === null) === (listing === 'active'),
        ),
      );
    },
    async archiveRepository(actorId, repoId, to) {
      calls.push(`archive ${repoId} ${to}`);
      const found = records.get(repoId);
      if (found === undefined || found.owner.id !== actorId)
        return fail('forbidden', 'only the owner can change this');
      const changed: RepositoryRecord = {
        ...found,
        archived_at: to === 'archived' ? '2026-10-07T12:00:00.000Z' : null,
      };
      records.set(repoId, changed);
      return ok(changed);
    },
    async getRepository(handle, name, viewer) {
      const found = [...records.values()].find(
        (r) => r.owner.handle === handle && r.name.toLowerCase() === name.toLowerCase(),
      );
      if (found === undefined || (found.visibility === 'private' && found.owner.id !== viewer))
        return fail('not_found', 'repository not found');
      return ok({ ...found, viewer_role: found.owner.id === viewer ? 'owner' : null });
    },
    async updateRepository(ownerId, repoId, patch: UpdateRepositoryInput) {
      const found = records.get(repoId);
      if (found === undefined || found.owner.id !== ownerId)
        return fail('forbidden', 'only the owner can change this');
      if (patch.name !== undefined && taken(ownerId, patch.name, repoId))
        return fail(
          'name_taken',
          `${found.owner.handle} already has a repository named ${patch.name}`,
        );
      const updated: RepositoryRecord = {
        ...found,
        name: patch.name ?? found.name,
        description: patch.description ?? found.description,
        visibility: patch.visibility ?? found.visibility,
        ...(patch.website === undefined ? {} : { website: patch.website }),
        ...(patch.topics === undefined ? {} : { topics: patch.topics }),
      };
      records.set(repoId, updated);
      return ok(updated);
    },
    async deleteRepository(ownerId, repoId) {
      const found = records.get(repoId);
      if (found === undefined || found.owner.id !== ownerId)
        return fail('forbidden', 'only the owner can change this');
      records.delete(repoId);
      return ok({ deleted: true as const });
    },
    async repositoryActivity() {
      return ok([]);
    },
    async transferRepository() {
      return fail('not_found', 'not in this fake');
    },
    async repositoryFiles() {
      return ok({
        ref: 'stalk',
        sha: null,
        files: [],
        readme: null,
        checks: null,
        checksPath: null,
        truncated: false,
      });
    },
  };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const starter = {
  name: 'notes',
  description: '',
  visibility: 'private',
  start: 'template:typescript-starter',
};

describe('the New repository form', () => {
  it('reads a template start', () => {
    expect(readCreateForm(form(starter))).toEqual({
      ok: true,
      input: {
        name: 'notes',
        description: '',
        visibility: 'private',
        start: { kind: 'template', template: 'typescript-starter' },
      },
    });
  });

  it('puts each problem beside its field and keeps what was typed', () => {
    const read = readCreateForm(
      form({ ...starter, name: 'my notes', start: 'import', importUrl: 'http://x' }),
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.errors.name).toMatch(/letters, digits/i);
    expect(read.errors.importUrl).toMatch(/https/);
    expect(read.values.name).toBe('my notes');
  });

  it('reads internal, and names all three visibilities when the choice is missing', () => {
    const internal = readCreateForm(form({ ...starter, owner: 'acme', visibility: 'internal' }));
    expect(internal).toMatchObject({ ok: true, input: { owner: 'acme', visibility: 'internal' } });
    const missing = readCreateForm(form({ ...starter, visibility: 'secret' }));
    expect(missing.ok ? null : missing.errors.visibility).toBe(
      'Choose public, private or internal.',
    );
  });

  it('refuses import URLs that carry credentials', () => {
    const read = readCreateForm(
      form({ ...starter, start: 'import', importUrl: 'https://me:pw@github.com/a/b.git' }),
    );
    expect(read.ok).toBe(false);
  });
});

describe('creating a repository from the web', () => {
  it('lands on the new repository', async () => {
    const gateway = fakeGateway();
    const outcome = await createFlow(form(starter), coop, registryClient(gateway));
    expect(outcome).toEqual({ kind: 'redirect', to: '/coop/notes' });
  });

  it('shows a taken name beside the name field', async () => {
    const registry = registryClient(fakeGateway());
    await createFlow(form(starter), coop, registry);
    const again = await createFlow(form({ ...starter, name: 'Notes' }), coop, registry);
    expect(again).toMatchObject({
      kind: 'show',
      state: {
        errors: { name: 'You already have a repository named Notes.' },
        values: { name: 'Notes' },
      },
    });
  });

  it('never calls the gateway with an invalid form', async () => {
    const gateway = fakeGateway();
    await createFlow(form({ ...starter, name: '' }), coop, registryClient(gateway));
    expect(gateway.calls).toEqual([]);
  });

  it('says so when the deployment has no registry', async () => {
    const outcome = await createFlow(form(starter), coop, registryClient({}));
    expect(outcome).toMatchObject({
      kind: 'show',
      state: { errors: { form: expect.stringMatching(/not reachable/) } },
    });
  });
});

async function created() {
  const registry = registryClient(fakeGateway());
  await createFlow(form(starter), coop, registry);
  const record = await registry.get('coop', 'notes', coop.id);
  if (!record.ok) throw new Error('not created');
  return { registry, id: record.value.id };
}

describe('settings', () => {
  it('renames and goes to the settings at the new address', async () => {
    const { registry, id } = await created();
    const outcome = await updateFlow(
      form({ repoId: id, currentName: 'notes', name: 'journal', description: '' }),
      coop,
      registry,
    );
    expect(outcome).toEqual({
      kind: 'redirect',
      to: '/coop/journal/settings/general?saved=renamed',
    });
  });

  it('saves a visibility change in place', async () => {
    const { registry, id } = await created();
    const outcome = await updateFlow(
      form({ repoId: id, currentName: 'notes', visibility: 'public' }),
      coop,
      registry,
    );
    expect(outcome).toEqual({ kind: 'show', state: { saved: 'Saved.', error: null } });
    expect(await registry.get('coop', 'notes', null)).toMatchObject({ ok: true });
  });

  it('saves a website (https:// added) and topics typed with commas, spaces and #', async () => {
    const { registry, id } = await created();
    const outcome = await updateFlow(
      form({
        repoId: id,
        currentName: 'notes',
        website: 'notes.example',
        topics: '#TypeScript, workers  cli',
      }),
      coop,
      registry,
    );
    expect(outcome).toEqual({ kind: 'show', state: { saved: 'Saved.', error: null } });
    expect(await registry.get('coop', 'notes', coop.id)).toMatchObject({
      ok: true,
      value: { website: 'https://notes.example', topics: ['typescript', 'workers', 'cli'] },
    });
  });

  it('refuses a topic the URL cannot carry and a website that is not one', async () => {
    const { registry, id } = await created();
    const badTopic = await updateFlow(
      form({ repoId: id, currentName: 'notes', topics: 'ok, no_underscores' }),
      coop,
      registry,
    );
    expect(badTopic).toMatchObject({
      kind: 'show',
      state: { error: expect.stringMatching(/Topics are/) },
    });
    const badSite = await updateFlow(
      form({ repoId: id, currentName: 'notes', website: 'javascript:alert(1)' }),
      coop,
      registry,
    );
    expect(badSite).toMatchObject({
      kind: 'show',
      state: { error: expect.stringMatching(/web address/) },
    });
  });

  it('refuses a change by someone else', async () => {
    const { registry, id } = await created();
    const outcome = await updateFlow(
      form({ repoId: id, currentName: 'notes', visibility: 'public' }),
      dana,
      registry,
    );
    expect(outcome).toMatchObject({
      kind: 'show',
      state: { error: 'Only the owner can change this.' },
    });
  });

  it('deletes only after the full name is typed', async () => {
    const { registry, id } = await created();
    const fields = { repoId: id, fullName: 'coop/notes' };
    expect(await deleteFlow(form({ ...fields, confirm: 'notes' }), coop, registry)).toMatchObject({
      kind: 'show',
      state: { error: 'Type coop/notes to confirm the deletion.' },
    });
    expect(await deleteFlow(form({ ...fields, confirm: 'coop/notes' }), coop, registry)).toEqual({
      kind: 'redirect',
      to: '/?deleted=coop%2Fnotes',
    });
    expect(await registry.get('coop', 'notes', coop.id)).toMatchObject({ ok: false });
  });
});

describe('the repository route', () => {
  it('finds a private repository for its owner only, and never under a reserved name', async () => {
    const registry = registryClient(fakeGateway());
    await createFlow(form(starter), coop, registry);
    expect(await lookupRepository('coop', 'notes', coop, registry)).toMatchObject({
      kind: 'found',
      isOwner: true,
    });
    expect(await lookupRepository('coop', 'notes', dana, registry)).toEqual({ kind: 'not-found' });
    expect(await lookupRepository('coop', 'notes', null, registry)).toEqual({ kind: 'not-found' });
    expect(isReservedOwner('Runs')).toBe(true);
    expect(await lookupRepository('runs', 'notes', coop, registry)).toEqual({ kind: 'not-found' });
  });

  it('sends an old address (a rename or a transfer) to the current one, ignoring case', () => {
    const record = { owner: { handle: 'acme' }, name: 'notes' };
    expect(isOldAddress('acme', 'notes', record)).toBe(false);
    expect(isOldAddress('Acme', 'Notes.git', record)).toBe(false);
    expect(isOldAddress('coop', 'notes', record)).toBe(true);
    expect(isOldAddress('acme', 'old-notes', record)).toBe(true);
  });

  it('shows the start page until a bean has started', () => {
    expect(hasGrown([])).toBe(false);
    expect(hasGrown([{ type: 'race.start' }])).toBe(false);
    expect(hasGrown([{ type: 'race.start' }, { type: 'task.start' }])).toBe(true);
  });
});

describe('the start page', () => {
  it('prints the clone URL, a bean push with -o wait and the agent lines', () => {
    const guide = startGuide(
      {
        gitOrigin: 'https://git.example.test/',
        mcpUrl: 'https://mcp.example.test/mcp',
        webOrigin: 'https://web.example.test',
      },
      'coop',
      'notes',
    );
    expect(guide.plugin.claude).toBe(
      'claude plugin marketplace add coop-collective/gitstalk-plugin && claude plugin install gitstalk@gitstalk && claude "/gitstalk:setup coop/notes"',
    );
    expect(guide.plugin.codexPrompt).toContain(
      'curl -fsSL https://web.example.test/setup.sh | sh -s -- detect',
    );
    expect(guide.https.urlWithToken).toBe('https://x:<token>@git.example.test/coop/notes.git');
    expect(guide.cloneUrl).toBe('https://git.example.test/coop/notes.git');
    expect(guide.gitSteps).toContain('git push -o wait origin bean/first-change');
    expect(guide.gitSteps[0]).toBe('git clone https://git.example.test/coop/notes.git');
    expect(guide.agents.map((agent) => agent.harness)).toEqual([
      'Claude Code',
      'Codex',
      'Any MCP client',
    ]);
    // The same install text /signup/agent prints, for this deployment's MCP address.
    expect(guide.plugin.codex).toBe(agentInstall('https://mcp.example.test/mcp', 'codex').code);
    expect(guide.agents[1]?.line).toBe(guide.plugin.codex);
    expect(guide.agents[0]?.line).toBe(
      agentInstall('https://mcp.example.test/mcp', 'claude-code').code,
    );
    const hosted = startGuide(
      {
        gitOrigin: 'https://git.example.test',
        mcpUrl: PLUGIN_MCP_URL,
        webOrigin: 'https://w.test',
      },
      'coop',
      'notes',
    );
    expect(hosted.plugin.codex).toContain('codex plugin add gitstalk@gitstalk');
    expect(guide.prompt).toContain('coop/notes');
    expect(guide.ssh).toBeNull();
  });

  it('adds the SSH clone URL and the host key fingerprint once the deployment serves SSH', () => {
    const ssh = sshEndpoint({
      SSH_HOST: ' ssh.example.test ',
      SSH_HOST_KEY_FINGERPRINT: 'SHA256:abc',
    });
    expect(sshEndpoint({ SSH_HOST: '', SSH_HOST_KEY_FINGERPRINT: 'SHA256:abc' })).toBeUndefined();
    const config = {
      gitOrigin: 'https://git.example.test',
      mcpUrl: 'https://mcp.example.test/mcp',
      webOrigin: 'https://web.example.test',
    };
    const guide = startGuide(ssh === undefined ? config : { ...config, ssh }, 'coop', 'notes');
    expect(guide.ssh).toEqual({
      cloneUrl: 'ssh://git@ssh.example.test/coop/notes.git',
      hostKeyFingerprint: 'SHA256:abc',
    });
  });
});

describe('the Env vars tab', () => {
  it('scopes git to the gateway host and reads the token from GITSTALK_TOKEN', () => {
    const block = envVarsBlock('https://git.example.test/', null);
    expect(block.helper.split('\n')).toEqual([
      'export GITSTALK_TOKEN=<deploy token>',
      'export GIT_TERMINAL_PROMPT=0',
      'export GIT_CONFIG_COUNT=1',
      "export GIT_CONFIG_KEY_0='credential.https://git.example.test.helper'",
      `export GIT_CONFIG_VALUE_0='!f() { echo "username=x"; echo "password=$GITSTALK_TOKEN"; }; f'`,
    ]);
    expect(block.header).toContain(
      "export GIT_CONFIG_KEY_0='http.https://git.example.test/.extraheader'",
    );
    expect(block.header).toContain(
      'export GIT_CONFIG_VALUE_0="Authorization: Bearer $GITSTALK_TOKEN"',
    );
  });

  it('fills in a token that was just made', () => {
    expect(envVarsBlock('https://git.example.test', 'bsd_abc').helper).toContain(
      'export GITSTALK_TOKEN=bsd_abc',
    );
  });
});

describe("a repository's growth line", () => {
  it('counts landed and growing beans, and reads a missing engine as nothing grown', () => {
    const view = {
      ok: true,
      value: { tasks: { landed: 3, green: 2, running: 1, testing: 1, pending: 4 } },
    };
    expect(growthText(growthFromView(view))).toBe('5 beans landed, 2 growing');
    expect(growthFromView({ ok: false, error: { code: 'not_found' } })).toEqual({ kind: 'none' });
    expect(growthText({ kind: 'none' })).toBe('Nothing grown yet');
  });
});

describe('archive', () => {
  it('archives from Settings, leaves the default list, and unarchives', async () => {
    const gateway = fakeGateway();
    const registry = registryClient(gateway);
    const made = await registry.create(coop, {
      name: 'old-notes',
      visibility: 'private',
      start: { kind: 'empty' },
    });
    if (!made.ok) throw new Error(made.error.message);
    const repoId = made.value.id;
    expect(await archiveFlow(form({ repoId, to: 'archived' }), coop, registry)).toEqual({
      kind: 'redirect',
      to: '/coop/old-notes/settings/danger?saved=archived',
    });
    expect(await registry.list(coop.id, coop.id)).toEqual({ ok: true, value: [] });
    const archived = await registry.list(coop.id, coop.id, 'archived');
    expect(archived.ok && archived.value.map((record) => record.name)).toEqual(['old-notes']);
    expect(await archiveFlow(form({ repoId, to: 'active' }), coop, registry)).toMatchObject({
      to: '/coop/old-notes/settings/danger?saved=unarchived',
    });
  });

  it('says why when someone else tries, and refuses an unknown choice', async () => {
    const registry = registryClient(fakeGateway());
    const made = await registry.create(coop, {
      name: 'mine',
      visibility: 'public',
      start: { kind: 'empty' },
    });
    if (!made.ok) throw new Error(made.error.message);
    expect(
      await archiveFlow(form({ repoId: made.value.id, to: 'archived' }), dana, registry),
    ).toEqual({ kind: 'show', state: { saved: null, error: 'Only the owner can change this.' } });
    expect(await archiveFlow(form({ repoId: made.value.id, to: 'gone' }), coop, registry)).toEqual({
      kind: 'show',
      state: { saved: null, error: 'Choose archive or unarchive.' },
    });
  });

  it('reads records from a gateway that predates archive as never archived', async () => {
    const older = Object.fromEntries(
      Object.entries(fakeGateway()).filter(([method]) => method !== 'archiveRepository'),
    );
    const registry = registryClient(older);
    const made = await registry.create(coop, {
      name: 'x',
      visibility: 'public',
      start: { kind: 'empty' },
    });
    expect(made.ok && made.value.archived_at).toBeNull();
    expect(await registry.list(coop.id, coop.id, 'archived')).toEqual({ ok: true, value: [] });
    expect(await registry.archive(coop.id, 'r1', 'archived')).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
  });
});

describe('growth from the repo-events index', () => {
  it('says what landed and what is growing, or nothing yet', () => {
    expect(growthText(growthFromIndex({ landed: 3, growing: 1 }))).toBe(
      '3 beans landed, 1 growing',
    );
    expect(growthFromIndex({ landed: 0, growing: 0 })).toEqual({ kind: 'none' });
  });
});

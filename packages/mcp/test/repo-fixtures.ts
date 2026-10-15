/**
 * Repositories for the MCP tests, on the real gateway (an auxiliary Worker with the fake
 * Artifacts and runner): made through its registry RPC, a backlog planted on the sprout, and
 * pushes through its git proxy as git sends them.
 */
import { env } from 'cloudflare:test';
import { z } from 'zod';

import { PersonalTokenInput, createPersonalToken } from '@gitstalk/shared-identity/user-tokens';
import { insertUser } from '@gitstalk/shared-identity/users';

const GATEWAY_ORIGIN = 'https://gateway.example.test';
const ARTIFACTS_HOST = 'https://acct.artifacts.test';
const ZERO = '0'.repeat(40);

export type Person = { readonly id: string; readonly handle: string };

export const Repository = z.object({
  id: z.string(),
  name: z.string(),
  engine_id: z.string(),
  artifacts_repo: z.string(),
  owner: z.object({ id: z.string(), handle: z.string() }),
});
export type Repository = z.infer<typeof Repository>;

let people = 0;

export async function person(prefix = 'mcp-agent'): Promise<Person> {
  people += 1;
  const suffix = crypto.randomUUID().slice(0, 6);
  const user = {
    id: `u_${prefix.replace(/-/g, '')}_${people}_${suffix}`,
    handle: `${prefix}-${people}-${suffix}`,
  };
  await insertUser(env, { ...user, email: null }, Date.now()).run();
  return user;
}

/** A personal token for `/mcp` (a bearer) and git. */
export async function personalToken(user: Person, scopes: readonly string[]): Promise<string> {
  const issued = await createPersonalToken(env, {
    userId: user.id,
    request: PersonalTokenInput.parse({ name: 'mcp test', scopes, days: 7 }),
  });
  return issued.token;
}

export async function repository(
  owner: Person,
  options: { readonly name?: string; readonly visibility?: 'public' | 'private' } = {},
): Promise<Repository> {
  const created = await gatewayCall('createRepository', owner, {
    name: options.name ?? 'shop',
    visibility: options.visibility ?? 'private',
    start: { kind: 'empty' },
  });
  return Repository.parse(okValue(created));
}

/** A person invited to `repo` with `role`, who accepted. */
export async function collaborator(
  owner: Person,
  repo: Repository,
  role: 'read' | 'write' | 'maintain',
): Promise<Person> {
  const member = await person('mcp-member');
  const invited = await gatewayCall('inviteCollaborator', owner, repo.id, {
    handle: member.handle,
    role,
  });
  const invitation = z.object({ id: z.string() }).parse(okValue(invited));
  okValue(await gatewayCall('answerInvitation', member, invitation.id, 'accept'));
  return member;
}

export async function deployToken(owner: Person, repo: Repository): Promise<string> {
  const issued = await gatewayCall('createDeployToken', owner, repo.id, {
    name: 'ci',
    access: 'write',
    days: 7,
  });
  return z.object({ token: z.string() }).parse(okValue(issued)).token;
}

/**
 * Puts `files` on the repository's sprout in the fake Artifacts (the fake runner moves no
 * refs), then lands a bean so the engine forgets the heads it read moments ago.
 */
export async function plantOnSprout(
  repo: Repository,
  files: Record<string, string>,
  token: string,
): Promise<void> {
  const fake: unknown = Reflect.get(env, 'FAKE_REPOS');
  const handle: unknown = await Reflect.apply(Reflect.get(Object(fake), 'get'), fake, [
    repo.artifacts_repo,
  ]);
  const created: unknown = await Reflect.apply(Reflect.get(Object(handle), 'createToken'), handle, [
    'write',
    600,
  ]);
  const { plaintext } = z.object({ plaintext: z.string() }).parse(created);
  const sha = await digest(JSON.stringify(files));
  const body = `${pkt(`${ZERO} ${sha} refs/heads/sprout\0report-status\n`)}${pkt(`${ZERO} ${sha} refs/heads/stalk\n`)}0000PACK${JSON.stringify({ commits: { [sha]: { message: 'Plant', parents: [], files } } })}`;
  const git: unknown = Reflect.get(env, 'FAKE_GIT');
  const response: unknown = await Reflect.apply(Reflect.get(Object(git), 'fetch'), git, [
    `${ARTIFACTS_HOST}/git/gitstalk-repos/${repo.artifacts_repo}.git/git-receive-pack`,
    { method: 'POST', headers: { authorization: `Bearer ${plaintext}` }, body },
  ]);
  if (!(response instanceof Response) || !response.ok) throw new Error('planting failed');
  const landed = await gitPush(slug(repo), token, {
    bean: `plant-${sha.slice(0, 8)}`,
    newSha: await digest(`plant:${sha}`),
    options: ['wait'],
  });
  if (!landed.remote.includes('LANDED')) throw new Error(`planting bean: ${landed.remote}`);
}

/** One bean pushed to `/git/<owner>/<repo>.git` with `token` as git's password. */
export async function gitPush(
  repo: string,
  token: string,
  push: {
    readonly bean: string;
    readonly newSha: string;
    readonly message?: string;
    readonly options?: readonly string[];
    /** The pushed commit's files (the fake runner's squash lays them over the sprout's). */
    readonly files?: Readonly<Record<string, string>>;
  },
): Promise<{ readonly status: number; readonly remote: string }> {
  const options = push.options ?? [];
  const caps = `report-status side-band-64k${options.length > 0 ? ' push-options' : ''} agent=git/2.47.0`;
  const command = pkt(`${ZERO} ${push.newSha} refs/heads/bean/${push.bean}\0${caps}\n`);
  const optionSection =
    options.length > 0 ? `${options.map((option) => pkt(`${option}\n`)).join('')}0000` : '';
  const commits = {
    [push.newSha]: { message: push.message ?? 'Change', parents: [], files: push.files ?? {} },
  };
  const response = await env.GATEWAY.fetch(`${GATEWAY_ORIGIN}/git/${repo}.git/git-receive-pack`, {
    method: 'POST',
    headers: {
      'user-agent': 'git/2.47.0',
      authorization: `Basic ${btoa(`x:${token}`)}`,
      'content-type': 'application/x-git-receive-pack-request',
      accept: 'application/x-git-receive-pack-result',
    },
    body: `${command}0000${optionSection}PACK${JSON.stringify({ commits })}`,
  });
  return { status: response.status, remote: remoteText(await response.text()) };
}

/**
 * Lands `.gitstalk/checks.yml` as the repository's owner (`token` is the owner's personal
 * token, which may change the checks), so later beans run the fake runner's suite.
 */
export async function requireChecks(repo: Repository, token: string): Promise<void> {
  const landed = await gitPush(slug(repo), token, {
    bean: 'require-checks',
    newSha: await digest(`checks:${repo.id}`),
    options: ['wait'],
    files: { '.gitstalk/checks.yml': 'run: [node, --test]\n' },
  });
  if (!landed.remote.includes('LANDED')) throw new Error(`checks bean: ${landed.remote}`);
}

export function slug(repo: Repository): string {
  return `${repo.owner.handle}/${repo.name}`;
}

export async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function pkt(line: string): string {
  return `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
}

/** Band 2 of a side-band response: what git prints as `remote:` lines. */
function remoteText(text: string): string {
  let remote = '';
  let offset = 0;
  while (offset + 4 <= text.length) {
    const length = Number.parseInt(text.slice(offset, offset + 4), 16);
    if (Number.isNaN(length)) return text;
    if (length === 0) {
      offset += 4;
      continue;
    }
    if (text.charCodeAt(offset + 4) === 2) remote += text.slice(offset + 5, offset + length);
    offset += length;
  }
  return remote;
}

/** Calls a method of the gateway's entrypoint over the service binding. */
async function gatewayCall(method: string, ...args: readonly unknown[]): Promise<unknown> {
  const binding: unknown = env.GATEWAY;
  const call: unknown = Reflect.get(Object(binding), method);
  if (typeof call !== 'function') throw new Error(`the gateway has no ${method}`);
  const result: unknown = await Reflect.apply(call, binding, args);
  return result;
}

function okValue(result: unknown): unknown {
  const parsed = z
    .union([
      z.object({ ok: z.literal(true), value: z.unknown() }),
      z.object({ ok: z.literal(false), error: z.object({ message: z.string() }) }),
    ])
    .parse(result);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

/**
 * Helpers for the agent-repository tests: a repository made through the registry RPC, a
 * backlog planted on its sprout (in the fake Artifacts remote), and pushes as git sends them.
 */
import { env } from 'cloudflare:test';

import type { RepositoryRecord } from '@gitstalk/shared-race/repos';
import type { RpcResult } from '@gitstalk/shared-race/rpc';

import { call, pkt, pushRefsBody } from './helpers';

const GIT_UA = { 'user-agent': 'git/2.47.0' };
const ZERO = '0'.repeat(40);
const ARTIFACTS_HOST = 'https://acct.artifacts.test';

export function value<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

/**
 * Moves the sprout and the stalk of a repository's Artifacts repo to a commit holding
 * `files` (the fake runner moves no Artifacts refs), then lands a bean with `token` so the
 * engine forgets the line heads it read moments ago, as a real landing would.
 */
export async function plantOnSprout(
  record: RepositoryRecord,
  files: Record<string, string>,
  token: string,
): Promise<void> {
  using repo = await env.REPOS.get(record.artifacts_repo);
  const { plaintext } = await repo.createToken('write', 600);
  const sha = (await digest(JSON.stringify(files))).slice(0, 40);
  const refs = ['refs/heads/sprout', 'refs/heads/stalk'].map((ref) => ({ ref, newSha: sha }));
  const commits = { [sha]: { message: 'Plant files', parents: [], files } };
  const response = await fetch(
    `${ARTIFACTS_HOST}/git/gitstalk-repos/${record.artifacts_repo}.git/git-receive-pack`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${plaintext}` },
      body: `${pushRefsBody(refs)}${JSON.stringify({ commits })}`,
    },
  );
  if (!response.ok) throw new Error(`planting failed: ${response.status}`);
  const repoPath = `${record.owner.handle}/${record.name}`;
  const landed = await gitPush(
    repoPath,
    token,
    beanPush({
      bean: `plant-${sha.slice(0, 8)}`,
      newSha: await digest(`plant:${sha}`),
      options: ['wait'],
    }),
  );
  if (!landed.remote.includes('LANDED')) throw new Error(`planting bean: ${landed.remote}`);
}

/** What `git push` sends for one bean: the command, push options, then the (test) pack. */
export function beanPush(input: {
  bean: string;
  newSha: string;
  oldSha?: string;
  message?: string;
  options?: readonly string[];
  /** The pushed commit's files (the fake remote stores them; the runner's squash merges them). */
  files?: Readonly<Record<string, string>>;
}): string {
  const options = input.options ?? [];
  const caps = `report-status side-band-64k${options.length > 0 ? ' push-options' : ''} agent=git/2.47.0`;
  const ref = `refs/heads/bean/${input.bean}`;
  const command = pkt(`${input.oldSha ?? ZERO} ${input.newSha} ${ref}\0${caps}\n`);
  const optionSection =
    options.length > 0 ? `${options.map((option) => pkt(`${option}\n`)).join('')}0000` : '';
  const commits = {
    [input.newSha]: { message: input.message ?? 'Change', parents: [], files: input.files ?? {} },
  };
  return `${command}0000${optionSection}PACK${JSON.stringify({ commits })}`;
}

/** Pushes to `/git/<repo>.git` with `token` as git's Basic password; the `remote:` text and report. */
export async function gitPush(
  repo: string,
  token: string,
  body: string,
): Promise<{ status: number; remote: string; report: string }> {
  const response = await call('POST', `/git/${repo}.git/git-receive-pack`, {
    body,
    headers: {
      ...GIT_UA,
      authorization: `Basic ${btoa(`x:${token}`)}`,
      'content-type': 'application/x-git-receive-pack-request',
      accept: 'application/x-git-receive-pack-result',
    },
  });
  const text = await response.text();
  let remote = '';
  let report = '';
  let offset = 0;
  while (offset + 4 <= text.length) {
    const length = Number.parseInt(text.slice(offset, offset + 4), 16);
    if (Number.isNaN(length)) break;
    if (length === 0) {
      offset += 4;
      continue;
    }
    const payload = text.slice(offset + 5, offset + length);
    if (text.charCodeAt(offset + 4) === 2) remote += payload;
    else if (text.charCodeAt(offset + 4) === 1) report += payload;
    offset += length;
  }
  return { status: response.status, remote, report: report === '' ? text : report };
}

export async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The checks `requireChecks` lands: the fake runner's suite. */
export const NODE_CHECKS = 'run: [node, --test]\n';

/**
 * Lands `.gitstalk/checks.yml` as the repository's owner (a personal token may change the
 * checks), so later beans run the fake runner's suite instead of no checks at all.
 */
export async function requireChecks(record: RepositoryRecord, ownerToken: string): Promise<void> {
  const repoPath = `${record.owner.handle}/${record.name}`;
  const landed = await gitPush(
    repoPath,
    ownerToken,
    beanPush({
      bean: 'require-checks',
      newSha: await digest(`checks:${repoPath}`),
      options: ['wait'],
      files: { '.gitstalk/checks.yml': NODE_CHECKS },
    }),
  );
  if (!landed.remote.includes('LANDED')) throw new Error(`checks bean: ${landed.remote}`);
}

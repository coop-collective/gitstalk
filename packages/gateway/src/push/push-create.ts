/**
 * Push-to-create (`docs/claude-opus/20-repositories.md` §10), GitLab's rule: a push to an
 * address where nothing is, from a credential with the `create` scope, into a namespace where
 * its person may create repositories, creates a private repository there. The pushed commit
 * becomes the stalk's and the sprout's first, like an import: one branch per push, `main`,
 * `master`, `stalk` or `bean/<name>`, and no bean is opened (no stalk existed to protect, and
 * every later push is an ordinary bean push). An address an old repository left still
 * resolves to it (its redirect), so a push there reaches that repository and creates nothing.
 *
 * The same rule serves the first push to a repository `repo_create` or the API created empty
 * (`firstPush`): that commit replaces the README seed, so an existing project keeps its history.
 */
import { logIdentity, recordProductEvent } from '@gitstalk/shared-identity/product-events';
import type { RepositoryRecord } from '@gitstalk/shared-race/repos';
import type { RpcResult } from '@gitstalk/shared-race/rpc';

import type { GitCredential } from '../auth/git-credential';
import { GatewayError } from '../errors';
import type { GitPath } from '../git/git-path';
import { concatBytes, pktLine, FLUSH_PKT } from '../git/pkt-line';
import type { PushRequest } from '../git/push-request';
import { readPushRequest } from '../git/push-request';
import type { ReportMode } from '../git/receive-pack-report';
import { acceptedResponse, reportMode, withRemoteLines } from '../git/receive-pack-report';
import type { RepositoriesDeps } from '../repos/repositories-deps';
import type { Created } from '../repos/repository-creation';
import {
  adoptFirstPush,
  awaitsFirstPush,
  createFromPush,
  namespaceFor,
  pushedName,
} from '../repos/repository-creation';
import type { RunDO } from '../run/run-do';
import { beanOfPushedRef } from './bean-refs';
import type { RepoGitRequest } from './push-proxy';
import { bytesResponse, refused, text } from './push-responses';
import { repoEngineId } from './repo-engine';

/** Branches whose push may start a repository, besides `bean/<name>`. */
const STARTING_BRANCHES: ReadonlySet<string> = new Set(['main', 'master', 'stalk']);
const ZERO_SHA = '0'.repeat(40);
const HEADS = 'refs/heads/';
const CAPABILITIES = 'report-status side-band-64k ofs-delta push-options agent=gitstalk';

type Start = {
  readonly ref: string;
  /** Without `refs/heads/`. */
  readonly branch: string;
  readonly commit: string;
};

/**
 * Serves a push to an address where nothing is: created (or the empty advertisement git asks
 * for first), refused, or null when something is there and the ordinary flow takes it.
 */
export async function pushToCreate(
  input: RepoGitRequest,
  credential: GitCredential,
): Promise<Response | null> {
  const { path, deps } = input;
  if (path.service !== 'git-receive-pack' || (await isTaken(input))) return null;
  const missing = text(404, missingForPush(path, deps.config.webUrl));
  const repositories = input.repositories;
  if (repositories === undefined || !mayCreate(credential)) return missing;
  const name = pushedName(path.repo);
  if (!name.ok) return text(422, `${path.repo} cannot be a repository name: ${name.error.message}`);
  // A namespace the person may not create in answers as a hidden repository does: nothing told.
  const namespace = await namespaceFor(repositories, credential.user, path.namespace);
  if (!namespace.ok) return missing;
  if (path.rest === 'info/refs') return emptyAdvertisement();
  return createdByPush(input, { credential, repositories });
}

/**
 * The first push to a repository created empty by `repo_create` or the API (nothing pushed
 * yet): served as push-to-create serves a new address. Null when it is not such a push.
 */
export async function firstPush(
  input: RepoGitRequest,
  target: { readonly record: RepositoryRecord; readonly engine: DurableObjectStub<RunDO> },
): Promise<Response | null> {
  const repositories = input.repositories;
  if (repositories === undefined || !awaitsFirstPush(target.record)) return null;
  if ((await target.engine.pushedBeans()).length > 0) return null;
  const heads = await repositories.storage.lineHeads(target.record.artifacts_repo);
  if (heads.stalk === null || heads.stalk !== heads.sprout) return null;
  const from = heads.stalk;
  return served(input, async (request, start) => {
    const adopted = await adoptFirstPush(repositories, {
      record: target.record,
      ref: start.branch,
      start: { commit: start.commit, pack: request.pack, from },
    });
    return { result: adopted, lead: 'was empty: your push became its stalk' };
  });
}

/** What git prints when a push names a repository that is not there for this credential. */
export function missingForPush(path: GitPath, webUrl: string): string {
  const web = webUrl.replace(/\/+$/, '');
  return [
    `no repository ${path.namespace}/${path.repo} (or you may not see it).`,
    `To create it: ${web}/new, the repo_create tool, or push again with a credential that has the create scope`,
    `(/gitstalk:setup, or a token with create from ${web}/settings/tokens), into your own namespace or an organization that lets you create.`,
  ].join('\n');
}

/** Whether a registry record, an old address or an admin-opened engine is at the path. */
async function isTaken(input: RepoGitRequest): Promise<boolean> {
  const { deps, path } = input;
  if ((await deps.registry.resolve(path.namespace, path.repo)) !== null) return true;
  const derived = await repoEngineId(path.namespace, path.repo);
  return (await deps.run(derived).repoEngine()) !== null;
}

/** A person's credential with `repo:create` (bound tokens and run tokens never create). */
function mayCreate(credential: GitCredential): boolean {
  return (
    credential.scopes.includes('repo:create') &&
    credential.engine === null &&
    credential.runPrincipal === null
  );
}

/** The receive-pack advertisement of a repository with no refs yet. */
function emptyAdvertisement(): Response {
  const body = concatBytes([
    pktLine('# service=git-receive-pack\n'),
    FLUSH_PKT,
    pktLine(`${ZERO_SHA} capabilities^{}\0${CAPABILITIES}\n`),
    FLUSH_PKT,
  ]);
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/x-git-receive-pack-advertisement',
      'cache-control': 'no-cache',
    },
  });
}

async function createdByPush(
  input: RepoGitRequest,
  target: { readonly credential: GitCredential; readonly repositories: RepositoriesDeps },
): Promise<Response> {
  const { path, deps } = input;
  const response = await served(input, async (request, start) => {
    const made = await createFromPush(target.repositories, {
      creator: target.credential.user,
      namespace: path.namespace,
      name: path.repo,
      ref: start.branch,
      commit: start.commit,
      pack: request.pack,
    });
    if (made.ok) input.ctx.waitUntil(recordCreation(input, target.credential));
    return { result: made, lead: 'was created, private, from your push' };
  });
  deps.log.info('push to create served', { namespace: path.namespace, status: response.status });
  return response;
}

type Outcome = { readonly result: RpcResult<Created>; readonly lead: string };

/** Reads the push, checks its one starting branch, runs `make` and answers git. */
async function served(
  input: RepoGitRequest,
  make: (request: PushRequest, start: Start) => Promise<Outcome>,
): Promise<Response> {
  if (input.request.headers.get('content-encoding') !== null)
    return text(415, 'compressed pushes are not supported');
  const read = await readPushRequest(input.request.body);
  if (!read.ok) return text(400, read.reason);
  const { request } = read;
  const mode = reportMode(request.capabilities);
  const start = startOf(request);
  if (!start.ok) return refusedAfter(request, mode, start.error.message);
  const outcome = await make(request, start.value).catch((error: unknown): Outcome => {
    if (!(error instanceof GatewayError)) throw error;
    input.deps.log.warn('push to create failed', { error });
    const { code, status, message } = error;
    return { result: { ok: false, error: { code, status, message } }, lead: '' };
  });
  if (!outcome.result.ok) return refusedAfter(request, mode, outcome.result.error.message);
  const lines = createdLines(outcome.result.value, {
    start: start.value,
    lead: outcome.lead,
    webUrl: input.deps.config.webUrl,
  });
  return bytesResponse(
    withRemoteLines(acceptedResponse(start.value.ref, mode), mode, lines),
    new Headers(),
  );
}

/** The one branch a starting push may carry, or why not. */
function startOf(request: PushRequest): RpcResult<Start> {
  const [command] = request.commands;
  if (command === undefined || request.commands.length > 1)
    return refusal('push one branch to start a repository: main, master, stalk or bean/<name>');
  if (command.newSha === ZERO_SHA) return refusal('nothing to start from: that push deletes');
  const branch = command.ref.startsWith(HEADS) ? command.ref.slice(HEADS.length) : '';
  if (!STARTING_BRANCHES.has(branch) && beanOfPushedRef(command.ref) === null)
    return refusal(
      `a repository starts from main, master, stalk or bean/<name>, not ${command.ref}`,
    );
  return { ok: true, value: { ref: command.ref, branch, commit: command.newSha } };
}

function refusal(message: string): RpcResult<Start> {
  return { ok: false, error: { code: 'invalid_request', status: 400, message } };
}

/** Says what was made, where it is, and that from now on changes are beans. */
function createdLines(
  created: Created,
  input: { readonly start: Start; readonly lead: string; readonly webUrl: string },
): string[] {
  const { record } = created;
  const fullName = `${record.owner.handle}/${record.name}`;
  const web = input.webUrl.replace(/\/+$/, '');
  const sha = input.start.commit.slice(0, 7);
  return [
    `gitstalk: ${fullName} ${input.lead} (${record.visibility}).`,
    `gitstalk: its stalk and sprout start at ${sha} (${input.start.branch}); no bean was opened and ${input.start.branch} is not kept as a branch.`,
    `gitstalk: open it: ${web}/${fullName}`,
    `gitstalk: from now on push changes as beans: git switch -c bean/<name> && git push origin bean/<name>`,
  ];
}

async function refusedAfter(
  request: PushRequest,
  mode: ReportMode,
  reason: string,
): Promise<Response> {
  await request.pack.cancel().catch(() => undefined);
  return refused(request, mode, reason);
}

/** The product event and log line for a repository a push created (hashed ids only). */
async function recordCreation(input: RepoGitRequest, credential: GitCredential): Promise<void> {
  const userId = credential.user.id;
  await recordProductEvent(input.deps.productEvents, 'repo_create', { userId, detail: 'push' });
  input.deps.log.info('repository push-created', await logIdentity({ userId }));
}

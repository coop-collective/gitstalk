/**
 * The git-native flow's proxy (`docs/claude-opus/18-git-native-flow.md`): `/git/<owner>/<repo>.git`
 * of a repository's continuous engine. Clone and fetch pass through. A push to
 * `refs/heads/bean/<name>` is a submit: the gateway checks the refs before anything moves,
 * forwards the push to Artifacts, hands the new head to the engine, and answers with `remote:`
 * lines (received, check started; with `-o wait`, the verdict). Pushes to the lines, other
 * branches and deletions are refused in the protocol, so git prints why.
 */
import { logIdentity, recordProductEvent } from '@gitstalk/shared-identity/product-events';
import type { TaskId } from '@gitstalk/shared-race/ids';
import { RunId, Sha } from '@gitstalk/shared-race/ids';

import type { GitCredential, RepositoryAccess, RepositoryPrincipal } from '../auth/git-credential';
import { mayUseEngine, refusedByArchive, roleOf } from '../auth/git-credential';
import { notConnected } from '../auth/connect-hint';
import type { Deps } from '../deps';
import { withCapabilities } from '../git/advertisement';
import { forwardGit } from '../git/forward';
import type { GitPath } from '../git/git-path';
import { accessFor } from '../git/git-path';
import { FLUSH_PKT, concatBytes, remoteLines } from '../git/pkt-line';
import type { PushRequest } from '../git/push-request';
import { readPushRequest } from '../git/push-request';
import type { ReportMode } from '../git/receive-pack-report';
import { forwardPush, refMoved } from '../git/push-forward';
import {
  acceptedResponse,
  reportMode,
  withRemoteLines,
  withoutFinalFlush,
} from '../git/receive-pack-report';
import type { ProtectedAccess } from '../checks/protected-access';
import { protectedAccessOf } from '../checks/protected-access';
import { accessFacts, archivedMessage } from '../repos/access';
import type { SessionUse } from '../repos/collaborators';
import type { RunDO } from '../run/run-do';
import { PROTECTED_BRANCHES, beanOfPushedRef } from './bean-refs';
import { WAIT_REF_PREFIX, waitModeOfRef } from './bean-wait';
import { DEFAULT_WAIT_REF_SECONDS, parsePushOptions } from './push-intent';
import { checkStartedLines, receivedLines, statusHint } from './push-messages';
import { repoEngineId } from './repo-engine';
import { writeBeanWait, writePushVerdict } from './wait-stream';
import type { RepositoriesDeps } from '../repos/repositories-deps';
import type { RepositoryRecord } from '@gitstalk/shared-race/repos';
import { firstPush, missingForPush, pushToCreate } from './push-create';
import { bytesResponse, refused, resultHeaders, text } from './push-responses';

const ADVERTISED = ['push-options'];
const ZERO_SHA = '0'.repeat(40);
/** What git prints when Artifacts stayed busy with other pushes through every retry. */
const BUSY_MESSAGE = 'the repository is busy with other pushes; push again in a few seconds';

export type RepoGitRequest = {
  readonly request: Request;
  readonly path: GitPath;
  /** Null when git sent no credential: a public repository is cloned anonymously. */
  readonly credential: GitCredential | null;
  readonly deps: Deps;
  readonly ctx: Pick<ExecutionContext, 'waitUntil'>;
  /** The creation path, for push-to-create; absent: a push to a missing address is a 404. */
  readonly repositories?: RepositoriesDeps;
};

type Engine = DurableObjectStub<RunDO>;

/** Serves one smart-HTTP request of a repository engine. */
export async function repoGit(input: RepoGitRequest): Promise<Response> {
  const { path, credential, deps } = input;
  const principal: RepositoryPrincipal =
    credential === null ? { kind: 'anonymous' } : { kind: 'credential', credential };
  if (credential?.address !== undefined && credential.address !== addressOf(path))
    return text(404, missingForPush(path, deps.config.webUrl));
  if (credential !== null) {
    const created = await pushToCreate(input, credential);
    if (created !== null) return created;
  }
  const repository = await repositoryAt(deps, path, principal);
  const access = accessFor(path.service);
  // A repository the credential may not use is answered as missing: its existence is not
  // told. Without a credential git is asked for one instead, as for a missing repository.
  const missing =
    credential === null
      ? notConnected('missing', deps.config.webUrl)
      : text(404, missingText(path, deps.config.webUrl));
  if (repository === null) return missing;
  const verdict = mayUseEngine(principal, repository.access, access);
  if (verdict !== 'allowed') {
    if (verdict === 'not-found' || credential === null) return missing;
    if (refusedByArchive(principal, repository.access, access))
      return text(403, archivedMessage(`${path.namespace}/${path.repo}`, access));
    return text(403, refusalText(credential, repository.access, access));
  }
  const engineId = repository.access.engine;
  const engine = deps.run(engineId);
  if ((await engine.repoEngine()) === null) return missing;
  const use = credential === null ? null : sessionUse(credential, repository.repoId);
  const movedTo = movedFrom(path, repository.fullName);
  if (path.rest === 'git-receive-pack')
    // Pushing is never allowed without a credential, so `credential` is set here.
    return credential === null
      ? missing
      : push(input, {
          engine,
          engineId,
          use,
          credential,
          movedTo,
          record: repository.record,
          protectedAccess: protectedAccessOf(
            credential,
            roleOf({ kind: 'credential', credential }, repository.access),
          ),
        });
  if (use !== null) input.ctx.waitUntil(recordUse(deps, use, 'read'));
  const grant = await engine.repoGitGrant(access);
  if (!grant.ok) return text(grant.status, grant.message);
  const response = await forwardGit(input.request, {
    upstream: grant.upstream,
    path,
    token: grant.token,
    body: input.request.body,
  });
  if (path.rest !== 'info/refs' || path.service !== 'git-receive-pack' || !response.ok)
    return response;
  const advertisement = new Uint8Array(await response.arrayBuffer());
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(withCapabilities(advertisement, ADVERTISED), { status: 200, headers });
}

/**
 * The repository a path names: the registry's record at that address or at an old one (a
 * rename or a transfer leaves a redirect, `Registry.resolve`, so old remotes keep cloning and
 * pushing without following anything), or for an engine opened without one (the admin route)
 * the engine derived from the path, private. A derived engine that now belongs to a record
 * under another name names nothing.
 */
async function repositoryAt(
  deps: Deps,
  path: GitPath,
  principal: RepositoryPrincipal,
): Promise<{
  readonly access: RepositoryAccess;
  readonly repoId: string | null;
  /** The registry's record; null for an engine opened without one. */
  readonly record: RepositoryRecord | null;
  /** The record's `owner/name` now (it differs from the path at an old address). */
  readonly fullName: string | null;
} | null> {
  const record = await deps.registry.resolve(path.namespace, path.repo);
  if (record !== null && RunId.safeParse(record.engine_id).success)
    return {
      access: await accessFacts(deps.collaborators, record, principal),
      repoId: record.id,
      record,
      fullName: `${record.owner.handle}/${record.name}`,
    };
  const derived = await repoEngineId(path.namespace, path.repo);
  if ((await deps.registry.byEngine(derived)) !== null) return null;
  return {
    access: {
      engine: derived,
      owner: { id: null, handle: path.namespace },
      visibility: 'private',
      collaboratorRole: null,
      org: null,
      archived: false,
    },
    repoId: null,
    record: null,
    fullName: null,
  };
}

/** What git prints for a repository that is not there for this credential. */
function missingText(path: GitPath, webUrl: string): string {
  return path.service === 'git-receive-pack'
    ? missingForPush(path, webUrl)
    : `no repository ${path.namespace}/${path.repo}`;
}

/** `owner/name` of a git path, lower case. */
function addressOf(path: GitPath): string {
  return `${path.namespace}/${path.repo}`.toLowerCase();
}

/** The current `owner/name` when the request used an old address (a rename or a transfer). */
function movedFrom(path: GitPath, fullName: string | null): string | null {
  if (fullName === null) return null;
  return fullName.toLowerCase() === `${path.namespace}/${path.repo}`.toLowerCase()
    ? null
    : fullName;
}

/** What a push to an old address prints: it worked, and where the repository is now. */
function movedLines(fullName: string, webUrl: string): string[] {
  return [
    `gitstalk: this repository moved to ${fullName}; the old address keeps working.`,
    `gitstalk: to use the new one: git remote set-url origin ${webUrl}/${fullName}.git`,
  ];
}

/** What git prints when someone who can see the repository may not do this. */
function refusalText(
  credential: GitCredential,
  repository: RepositoryAccess,
  access: 'read' | 'write',
): string {
  const role = roleOf({ kind: 'credential', credential }, repository);
  const needs = access === 'write' ? 'push beans' : 'read';
  if (credential.engine !== null) return `this token may not ${needs} here (read-only access)`;
  if (role === null)
    return `${repository.owner.handle}'s repository is public to read; to ${needs} ask its owner for the write role`;
  if (role === 'read' && access === 'write')
    return `your role on this repository is read; to push beans you need the write role`;
  return `this credential may not ${needs} (its scopes do not include it)`;
}

type Use = Omit<SessionUse, 'action'>;

/** A person's credential on a registry repository, for its sessions list; null otherwise. */
function sessionUse(credential: GitCredential, repoId: string | null): Use | null {
  if (repoId === null || credential.session === null) return null;
  return {
    repoId,
    user: credential.user,
    via: credential.session.via,
    credentialId: credential.session.id,
    label: '',
  };
}

async function recordUse(deps: Deps, use: Use, action: 'read' | 'push'): Promise<void> {
  await deps.collaborators.recordUse({ ...use, action }).catch((error: unknown) => {
    deps.log.warn('session use not recorded', { repo: use.repoId, error });
  });
}

/** The product event and log line for a bean a person pushed (hashed ids only). */
async function recordPush(deps: Deps, credential: GitCredential): Promise<void> {
  const userId = credential.user.id;
  await recordProductEvent(deps.productEvents, 'bean_push', {
    userId,
    detail: credential.session?.via ?? '',
  });
  deps.log.info(
    'bean pushed',
    await logIdentity({ userId, sessionId: credential.session?.id ?? null }),
  );
}

async function push(
  input: RepoGitRequest,
  target: {
    engine: Engine;
    engineId: RunId;
    use: Use | null;
    credential: GitCredential;
    /** The repository's current `owner/name` when the push used an old address. */
    movedTo: string | null;
    record: RepositoryRecord | null;
    protectedAccess: ProtectedAccess;
  },
): Promise<Response> {
  if (input.request.headers.get('content-encoding') !== null)
    return text(415, 'compressed pushes are not supported');
  if (target.record !== null) {
    const first = await firstPush(input, { record: target.record, engine: target.engine });
    if (first !== null) return first;
  }
  const read = await readPushRequest(input.request.body);
  if (!read.ok) return text(400, read.reason);
  const { request } = read;
  const mode = reportMode(request.capabilities);
  const actor = target.credential.user.handle;
  if (request.commands.some((command) => command.ref.startsWith(WAIT_REF_PREFIX)))
    return waitPush(input, { request, engine: target.engine, actor, mode });
  const memoryRef = target.credential.memoryRef;
  if (memoryRef !== undefined && request.commands.some((command) => command.ref === memoryRef))
    return memoryPush(input, { request, mode, engine: target.engine, memoryRef });
  const options = parsePushOptions(request.options);
  if (target.credential.beanPushAllowed === false) {
    await request.upstreamBody.cancel();
    return refused(
      request,
      mode,
      'this automation may not push beans (its file says permissions: beans: read)',
    );
  }
  const checked = await checkCommands(request, {
    engine: target.engine,
    actor,
  });
  if (!checked.ok) {
    await request.upstreamBody.cancel();
    return refused(request, mode, checked.reason);
  }
  const grant = await target.engine.repoGitGrant('write');
  if (!grant.ok) return text(grant.status, grant.message);
  const forwarded = await forwardPush(input.request, {
    upstream: grant.upstream,
    path: input.path,
    token: grant.token,
    body: request.upstreamBody,
    ref: checked.ref,
    mode,
    log: input.deps.log,
  });
  if (forwarded.kind === 'busy') return refused(request, mode, BUSY_MESSAGE);
  const upstream = forwarded.answer;
  const { bytes } = upstream;
  if (!refMoved(upstream, checked.ref, mode))
    return bytesResponse(bytes, upstream.headers, upstream.status);
  const submitted = await target.engine.submitPush({
    bean: checked.bean,
    head: checked.head,
    actor,
    protectedAccess: target.protectedAccess,
    options,
  });
  if (submitted.ok && target.use !== null)
    input.ctx.waitUntil(recordUse(input.deps, target.use, 'push'));
  if (submitted.ok) input.ctx.waitUntil(recordPush(input.deps, target.credential));
  if (!submitted.ok) {
    const lines = [
      `gitstalk: the bean's branch moved, but the engine did not take it: ${submitted.reason}`,
    ];
    return bytesResponse(withRemoteLines(bytes, mode, lines), upstream.headers);
  }
  const lines = [
    ...receivedLines({
      ...submitted.received,
      unknownOptions: [...options.unknown, ...options.beans.map((bean) => `bean=${bean}`)],
    }),
    ...checkStartedLines(checked.bean, options.waitSeconds),
    ...(options.waitSeconds === null ? statusHint(checked.bean) : []),
    ...(target.movedTo === null ? [] : movedLines(target.movedTo, input.deps.config.webUrl)),
  ];
  const waitSeconds = options.waitSeconds;
  if (waitSeconds === null || !mode.sideband)
    return bytesResponse(withRemoteLines(bytes, mode, lines), upstream.headers);
  const wait = { engine: target.engine, bean: checked.bean, push: submitted.push };
  return streamedResponse({
    report: bytes,
    headers: upstream.headers,
    lines,
    body: (write) => writePushVerdict(write, { ...wait, seconds: waitSeconds }),
    ctx: input.ctx,
  });
}

/**
 * An automation's memory push (doc 25 §7.3): one update of its own `refs/automations/<id>/
 * memory`, forwarded to the repository as it is. The engine never sees it: memory is not code
 * and never lands. Deleting it and pushing anything else with it are refused.
 */
async function memoryPush(
  input: RepoGitRequest,
  target: { request: PushRequest; mode: ReportMode; engine: Engine; memoryRef: string },
): Promise<Response> {
  const { request, mode } = target;
  const [command] = request.commands;
  if (request.commands.length !== 1 || command?.ref !== target.memoryRef) {
    await request.upstreamBody.cancel();
    return refused(request, mode, `push ${target.memoryRef} on its own`);
  }
  if (command.newSha === ZERO_SHA) {
    await request.upstreamBody.cancel();
    return refused(request, mode, 'an automation cannot delete its memory');
  }
  const grant = await target.engine.repoGitGrant('write');
  if (!grant.ok) return text(grant.status, grant.message);
  const forwarded = await forwardPush(input.request, {
    upstream: grant.upstream,
    path: input.path,
    token: grant.token,
    body: request.upstreamBody,
    ref: command.ref,
    mode,
    log: input.deps.log,
  });
  if (forwarded.kind === 'busy') return refused(request, mode, BUSY_MESSAGE);
  const { answer } = forwarded;
  return bytesResponse(answer.bytes, answer.headers, answer.status);
}

/**
 * A push to `refs/wait/any|all`: nothing reaches the repository; the push is answered `ok` and
 * holds until the first (any) or every (all) verdict of the pusher's beans in flight, or of
 * the beans `-o bean=` names.
 */
async function waitPush(
  input: RepoGitRequest,
  target: { request: PushRequest; engine: Engine; actor: string; mode: ReportMode },
): Promise<Response> {
  const { request, mode } = target;
  await request.upstreamBody.cancel();
  const [command] = request.commands;
  const waitMode = command === undefined ? null : waitModeOfRef(command.ref);
  if (command === undefined || request.commands.length > 1 || waitMode === null)
    return refused(
      request,
      mode,
      'a wait is one push to refs/wait/any (the first verdict) or refs/wait/all (every verdict), with -o bean=<name> to name beans',
    );
  const options = parsePushOptions(request.options);
  const report = acceptedResponse(command.ref, mode);
  const unknown = options.unknown.map((option) => `gitstalk:   ignored push option: ${option}`);
  if (!mode.sideband) return bytesResponse(report, new Headers());
  return streamedResponse({
    report,
    headers: new Headers(),
    lines: unknown,
    body: (write) =>
      writeBeanWait(write, {
        engine: target.engine,
        actor: target.actor,
        mode: waitMode,
        beans: options.beans.length === 0 ? null : options.beans,
        seconds: options.waitSeconds ?? DEFAULT_WAIT_REF_SECONDS,
      }),
    ctx: input.ctx,
  });
}

type Checked =
  | { readonly ok: true; readonly ref: string; readonly bean: TaskId; readonly head: Sha }
  | { readonly ok: false; readonly reason: string };

/**
 * One bean per push, a branch under `refs/heads/bean/`, never a line, never a deletion, and
 * not a name someone else reserved.
 */
async function checkCommands(
  request: PushRequest,
  target: { readonly engine: Engine; readonly actor: string },
): Promise<Checked> {
  const { commands } = request;
  const lines = commands.find((command) => PROTECTED_BRANCHES.includes(command.ref));
  if (lines !== undefined) {
    return {
      ok: false,
      reason: `${lines.ref} is the engine's: landing is never a push. Push your work to refs/heads/bean/<name>; it lands when its pre-land check is green`,
    };
  }
  if (commands.some((command) => command.newSha === ZERO_SHA))
    return { ok: false, reason: 'deleting refs is not allowed' };
  const command = commands[0];
  if (command === undefined) return { ok: false, reason: 'nothing to push' };
  if (commands.length > 1)
    return { ok: false, reason: 'push one bean at a time (one refs/heads/bean/<name> per push)' };
  const bean = beanOfPushedRef(command.ref);
  if (bean === null) {
    return {
      ok: false,
      reason: `only beans are pushed: refs/heads/bean/<name> (letters, digits, . _ -; up to 32), not ${command.ref}`,
    };
  }
  const refusal = await target.engine.pushRefusal(bean, target.actor);
  if (refusal !== null) return { ok: false, reason: refusal };
  return { ok: true, ref: command.ref, bean, head: Sha.parse(command.newSha) };
}

/**
 * A streamed answer: the report (the upstream's, or the gateway's own for a wait ref), the
 * lines so far, then what `body` writes as it happens, then the closing flush.
 */
function streamedResponse(input: {
  report: Uint8Array;
  headers: Headers;
  lines: readonly string[];
  body: (write: (lines: readonly string[]) => Promise<void>) => Promise<void>;
  ctx: Pick<ExecutionContext, 'waitUntil'>;
}): Response {
  const head = withoutFinalFlush(input.report);
  if (head === null) return bytesResponse(input.report, input.headers);
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const write = async (lines: readonly string[]): Promise<void> => {
    if (lines.length > 0) await writer.write(remoteLines(lines));
  };
  const work = (async () => {
    try {
      await writer.write(concatBytes([head, remoteLines(input.lines)]));
      await input.body(write).catch(async () => {
        await write([
          `gitstalk: lost the engine while waiting; the verdicts will be on refs/beans/<name>/status`,
        ]);
      });
      await writer.write(FLUSH_PKT);
      await writer.close();
    } catch {
      // The client went away: nothing is left to tell it.
      await writer.abort().catch(() => undefined);
    }
  })();
  input.ctx.waitUntil(work);
  return new Response(readable, { status: 200, headers: resultHeaders(input.headers) });
}

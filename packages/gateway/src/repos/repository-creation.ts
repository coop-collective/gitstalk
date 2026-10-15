/**
 * The one way a repository is created (`docs/claude-opus/20-repositories.md` §2 and §10),
 * whoever asks: the web form (`createRepository`), the MCP tool `repo_create` and
 * `POST /api/repos` (`createRepositoryAs`), and a push to an address that does not exist
 * (`createFromPush`). Each reserves the name in the namespace's registry, provisions the
 * Artifacts repo, puts the first commit on the stalk and the sprout, opens the engine, lists
 * it, writes the audit (`Via: <client>`) and counts towards the creation limit. A failure on the
 * way removes what was made, so the name is free again.
 */
import { recordOrgAudit } from '@gitstalk/shared-identity/org-audit';
import type { RepositoryOwnerRef } from '@gitstalk/shared-identity/orgs';
import { findOrgByHandle, mayCreateRepository, orgRole } from '@gitstalk/shared-identity/orgs';
import type { AgentPrincipal } from '@gitstalk/shared-race/collaborators';
import type { CreatedRepository, CreationVia } from '@gitstalk/shared-race/repo-create';
import {
  MAX_CREATIONS_PER_HOUR,
  RepoCreateRequest,
  createInputOf,
  createdRepository,
} from '@gitstalk/shared-race/repo-create';
import type {
  CreateRepositoryInput,
  RepoOrigin,
  RepoOwner,
  RepoVisibility,
  RepositoryRecord,
} from '@gitstalk/shared-race/repos';
import { RepoName, RepoOwner as RepoOwnerSchema } from '@gitstalk/shared-race/repos';
import { CreateRepositoryInput as CreateRepositoryInputSchema } from '@gitstalk/shared-race/repos';
import type { RpcError, RpcResult } from '@gitstalk/shared-race/rpc';

import { artifactsCode } from '../adapters/artifacts';
import type { PushedStart } from '../adapters/repository-storage';
import { assertNever } from '../engine/errors';
import { GatewayError } from '../errors';
import type { RepositoriesDeps } from './repositories-deps';
import { emptyStart, templateFiles } from './templates';

/** A repository and its stalk's first commit, as the creation path leaves them. */
export type Created = { readonly record: RepositoryRecord; readonly stalk: string | null };

/** What a push to a missing address brings: the branch it named, its commit and its pack. */
export type PushedRepository = {
  readonly creator: RepoOwner;
  readonly namespace: string;
  readonly name: string;
  /** The pushed branch without `refs/heads/`: `main`, `master`, `stalk` or `bean/<name>`. */
  readonly ref: string;
  readonly commit: string;
  readonly pack: ReadableStream<Uint8Array>;
};

const HOUR_MS = 3600_000;
/** Artifacts' answers that mean the URL is not a public git repository. */
const IMPORT_REFUSALS: ReadonlySet<string> = new Set([
  'REMOTE_AUTH_REQUIRED',
  'NOT_FOUND',
  'INVALID_URL',
]);
/** Why a person's repository cannot be internal. */
export const INTERNAL_NEEDS_ORG =
  "only an organization's repository can be internal (readable by its members); choose public or private";
const SEED_AUTHOR = { name: 'Gitstalk', email: 'seed@gitstalk.invalid' };

/** The web form's creation: the person signed in on the web, any start the form offers. */
export async function createRepository(
  deps: RepositoriesDeps,
  rawOwner: RepoOwner,
  rawInput: CreateRepositoryInput,
): Promise<RpcResult<RepositoryRecord>> {
  const owner = RepoOwnerSchema.safeParse(rawOwner);
  if (!owner.success) return invalid('the owner is not a valid user');
  const parsed = CreateRepositoryInputSchema.safeParse(rawInput);
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'invalid repository');
  const created = await create(deps, {
    creator: owner.data,
    ownerHandle: parsed.data.owner,
    name: parsed.data.name,
    description: parsed.data.description,
    visibility: parsed.data.visibility,
    origin: parsed.data.start,
    via: 'web',
  });
  return created.ok ? ok(created.value.record) : created;
}

/**
 * `repo_create` and `POST /api/repos`: a person's agent session or token with the `create`
 * scope. Private and empty unless asked; the empty start keeps its README only until the
 * first push, which becomes the stalk (an existing project keeps its history).
 */
export async function createRepositoryAs(
  deps: RepositoriesDeps,
  principal: AgentPrincipal,
  rawRequest: unknown,
  via: 'repo_create' | 'api',
): Promise<RpcResult<CreatedRepository>> {
  if (!principal.scopes.includes('create'))
    return failure({
      code: 'insufficient_scope',
      status: 403,
      message: `creating repositories needs the create scope: reconnect and tick create, use a token with create, or create it at ${deps.webUrl}/new`,
    });
  const request = RepoCreateRequest.safeParse(rawRequest);
  if (!request.success)
    return failure({
      code: 'invalid_request',
      status: 422,
      message: request.error.issues[0]?.message ?? 'invalid repository',
    });
  const input = createInputOf(request.data);
  const created = await create(deps, {
    creator: principal.user,
    ownerHandle: input.owner,
    name: request.data.name,
    description: request.data.description,
    visibility: request.data.visibility,
    origin:
      input.start.kind === 'empty' ? { kind: 'empty', first_push: 'becomes-stalk' } : input.start,
    via,
  });
  if (!created.ok) return { ok: false, error: clientError(created.error, deps.webUrl) };
  return ok(
    createdRepository(created.value.record, { stalk: created.value.stalk, webUrl: deps.webUrl }),
  );
}

/**
 * Push-to-create: the pushed commit becomes the stalk's and the sprout's first (like an
 * import), in a private repository. The caller checked the credential's `create` scope and
 * that nothing is at the address.
 */
export function createFromPush(
  deps: RepositoriesDeps,
  pushed: PushedRepository,
): Promise<RpcResult<Created>> {
  return create(deps, {
    creator: pushed.creator,
    ownerHandle: pushed.namespace,
    name: pushed.name,
    description: '',
    visibility: 'private',
    origin: { kind: 'push', ref: pushed.ref },
    pushed: { commit: pushed.commit, pack: pushed.pack, from: null },
    via: 'push',
  });
}

/**
 * Whose namespace a new repository goes in: the creator's own (no handle, or theirs), or an
 * org whose repository setting lets the creator's role create there. Outsiders get 404.
 */
export async function namespaceFor(
  deps: RepositoriesDeps,
  creator: RepoOwner,
  handle: string | undefined,
): Promise<RpcResult<RepositoryOwnerRef>> {
  if (
    handle === undefined ||
    handle === '' ||
    handle.toLowerCase() === creator.handle.toLowerCase()
  )
    return ok({ kind: 'user', id: creator.id, handle: creator.handle });
  const org = await findOrgByHandle(deps.identity, handle);
  const role = org === null ? null : await orgRole(deps.identity, org.id, creator.id);
  if (org === null || role === null)
    return failure({ code: 'not_found', status: 404, message: `no organization named ${handle}` });
  if (!mayCreateRepository(role, org.repoCreation))
    return failure({
      code: 'forbidden',
      status: 403,
      message: `in ${org.handle} only owners and admins create repositories; you are a ${role}`,
    });
  return ok({ kind: 'org', id: org.id, handle: org.handle });
}

/** A repository name a push may create, or why not. */
export function pushedName(name: string): RpcResult<string> {
  const parsed = RepoName.safeParse(name);
  return parsed.success
    ? ok(parsed.data)
    : invalid(parsed.error.issues[0]?.message ?? 'not a repository name');
}

type Creation = {
  readonly creator: RepoOwner;
  readonly ownerHandle: string | undefined;
  readonly name: string;
  readonly description: string;
  readonly visibility: RepoVisibility;
  readonly origin: RepoOrigin;
  readonly pushed?: PushedStart;
  readonly via: CreationVia;
};

async function create(deps: RepositoriesDeps, creation: Creation): Promise<RpcResult<Created>> {
  const namespace = await namespaceFor(deps, creation.creator, creation.ownerHandle);
  if (!namespace.ok) return namespace;
  if (creation.visibility === 'internal' && namespace.value.kind !== 'org')
    return invalid(INTERNAL_NEEDS_ORG);
  const limited = await rateLimited(deps, creation.creator);
  if (limited !== null) return limited;
  const id = deps.newId();
  const artifactsRepo = artifactsRepoName(id);
  const owner = { id: namespace.value.id, handle: namespace.value.handle };
  const reserved = await deps.registry.reserve(
    {
      id,
      owner,
      ownerKind: namespace.value.kind,
      name: creation.name,
      description: creation.description,
      visibility: creation.visibility,
      origin: creation.origin,
      artifactsRepo,
      engineId: id,
    },
    deps.now(),
  );
  if (!reserved) return taken(namespace.value.handle, creation.name);
  try {
    const stalk = await provision(deps, { ...creation, artifactsRepo });
    const { engineId } = await deps.engine.open({ repoName: creation.name, artifactsRepo, owner });
    const record = await deps.registry.markReady(id, engineId, deps.now());
    if (record === null) throw new GatewayError(`repository ${id} vanished`, 'conflict', 409);
    deps.log.info('repository created', {
      repo: id,
      origin: creation.origin.kind,
      engine: engineId,
      owner: namespace.value.kind,
      via: creation.via,
    });
    await audit(deps, {
      record,
      creator: creation.creator,
      namespace: namespace.value,
      via: creation.via,
    });
    return ok({ record, stalk });
  } catch (error: unknown) {
    await undo(deps, id, artifactsRepo);
    throw error;
  }
}

/** Refuses a creator who made `MAX_CREATIONS_PER_HOUR` repositories in the last hour. */
async function rateLimited(
  deps: RepositoriesDeps,
  creator: RepoOwner,
): Promise<{ ok: false; error: RpcError } | null> {
  const recent = await deps.creations.countSince(creator.id, deps.now() - HOUR_MS);
  if (recent < MAX_CREATIONS_PER_HOUR) return null;
  return failure({
    code: 'rate_limited',
    status: 429,
    message: `you created ${MAX_CREATIONS_PER_HOUR} repositories in the last hour, the limit; try again later`,
  });
}

/** The repository's audit line, the org's when an org owns it, and the creation log. */
async function audit(
  deps: RepositoriesDeps,
  input: {
    readonly record: RepositoryRecord;
    readonly creator: RepoOwner;
    readonly namespace: RepositoryOwnerRef;
    readonly via: CreationVia;
  },
): Promise<void> {
  const { record, creator, via } = input;
  const detail = `Via: ${via}, ${record.visibility}`;
  const writes: Promise<unknown>[] = [
    deps.collaborators
      .auditStatement({ repoId: record.id, actor: creator, action: 'repository.create', detail })
      .run(),
    deps.creations.record({ actorId: creator.id, repoId: record.id, via }, deps.now()),
  ];
  if (input.namespace.kind === 'org')
    writes.push(
      recordOrgAudit(
        deps.identity,
        {
          orgId: input.namespace.id,
          actor: creator,
          action: 'repository.create',
          detail: `${record.name} (Via: ${via})`,
        },
        deps.now(),
      ),
    );
  await Promise.all(writes);
}

/** Makes the Artifacts repo and its first commit; the stalk's head, null when unknown. */
async function provision(
  deps: RepositoriesDeps,
  repo: Creation & { readonly artifactsRepo: string },
): Promise<string | null> {
  const { storage } = deps;
  const description = repo.description === '' ? repo.name : repo.description;
  switch (repo.origin.kind) {
    case 'import':
      return imported(deps, {
        artifactsRepo: repo.artifactsRepo,
        url: repo.origin.url,
        description,
      });
    case 'push': {
      if (repo.pushed === undefined) throw new Error('a push origin without its push');
      await storage.create(repo.artifactsRepo, description);
      await storage.seedFromPush(repo.artifactsRepo, repo.pushed);
      return repo.pushed.commit;
    }
    case 'template':
    case 'empty': {
      await storage.create(repo.artifactsRepo, description);
      const isTemplate = repo.origin.kind === 'template';
      return storage.seed(repo.artifactsRepo, {
        files: isTemplate
          ? templateFiles('typescript-starter', repo, deps.webUrl)
          : emptyStart(repo.name, repo.description),
        message: isTemplate ? 'Start from the TypeScript starter' : 'Initial commit',
        author: SEED_AUTHOR,
        time: Math.floor(deps.now() / 1000),
      });
    }
    default:
      return assertNever(repo.origin);
  }
}

async function imported(
  deps: RepositoriesDeps,
  repo: { readonly artifactsRepo: string; readonly url: string; readonly description: string },
): Promise<string> {
  await deps.storage
    .importFrom(repo.artifactsRepo, repo.url, repo.description)
    .catch((error: unknown) => {
      if (IMPORT_REFUSALS.has(artifactsCode(error) ?? ''))
        throw new GatewayError(
          `${repo.url} is not a public git repository (it asked for credentials or was not found)`,
          'import_refused',
          422,
          { cause: error },
        );
      throw error;
    });
  const head = await deps.storage.lineFromDefault(repo.artifactsRepo);
  if (head === null)
    throw new GatewayError('the imported repository is empty', 'invalid_request', 422);
  return head;
}

/** Removes a half-made repository; failures here are logged, the original error stands. */
async function undo(deps: RepositoriesDeps, id: string, artifactsRepo: string): Promise<void> {
  const results = await Promise.allSettled([
    deps.registry.remove(id),
    deps.storage.delete(artifactsRepo),
  ]);
  const failed = results.filter((result) => result.status === 'rejected').length;
  if (failed > 0) deps.log.warn('repository cleanup incomplete', { repo: id, failed });
}

/**
 * The answers a tool or a script reads: a taken name is `exists` (409); a namespace the
 * person may not create in is 403 whether or not the org exists; an invalid request is 422.
 */
function clientError(error: RpcError, webUrl: string): RpcError {
  switch (error.code) {
    case 'name_taken':
      return { ...error, code: 'exists' };
    case 'not_found':
    case 'forbidden':
      return {
        code: 'forbidden',
        status: 403,
        message: `${error.message}. Create repositories in your own namespace, or ask an owner of the organization (or use ${webUrl}/new)`,
      };
    case 'invalid_request':
      return { ...error, status: 422 };
    default:
      return error;
  }
}

/** The Artifacts repo of a repository: named by id, so a rename never moves storage. */
export function artifactsRepoName(id: string): string {
  return `repo-${id}`;
}

/**
 * The first push to a repository `repo_create` or the API made empty: its commit replaces the
 * README seed on the stalk and the sprout, a new engine starts from it and the seed's engine
 * closes. The caller checked that nothing has been pushed yet (`awaitsFirstPush`).
 */
export async function adoptFirstPush(
  deps: RepositoriesDeps,
  input: {
    readonly record: RepositoryRecord;
    readonly ref: string;
    readonly start: PushedStart;
  },
): Promise<RpcResult<Created>> {
  const { record } = input;
  await deps.storage.seedFromPush(record.artifacts_repo, input.start);
  const { engineId } = await deps.engine.open(
    { repoName: record.name, artifactsRepo: record.artifacts_repo, owner: record.owner },
    'first-push',
  );
  const restarted = await deps.registry.restart(
    record.id,
    { engineId, origin: { kind: 'push', ref: input.ref } },
    deps.now(),
  );
  if (restarted === null)
    return failure({ code: 'not_found', status: 404, message: 'the repository is gone' });
  await deps.engine.close(record.engine_id).catch((error: unknown) => {
    deps.log.warn('seed engine not closed', { repo: record.id, error });
  });
  deps.log.info('first push became the stalk', { repo: record.id, engine: engineId });
  return ok({ record: restarted, stalk: input.start.commit });
}

/** Whether `repo_create` or the API created it empty, so its first push becomes the stalk. */
export function awaitsFirstPush(record: RepositoryRecord): boolean {
  return record.origin.kind === 'empty' && record.origin.first_push === 'becomes-stalk';
}

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value };
}

function failure(error: RpcError): { ok: false; error: RpcError } {
  return { ok: false, error };
}

function invalid(message: string): { ok: false; error: RpcError } {
  return failure({ code: 'invalid_request', status: 400, message });
}

function taken(handle: string, name: string): { ok: false; error: RpcError } {
  return failure({
    code: 'name_taken',
    status: 409,
    message: `${handle} already has a repository named ${name}`,
  });
}

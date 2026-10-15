/**
 * The registry's half of access: the facts `mayUseEngine` decides on (owner, visibility, the
 * asking person's collaborator role and, for an org's repository, their org role and its base
 * permission) gathered for a repository record, and the verdict as an
 * RPC answer. Every repository question from git, MCP and the web comes through here, and
 * here asks `mayUseEngine` and nothing else.
 */
import type {
  RepositoryAction,
  RepositoryForViewer,
  ViewerRole,
} from '@gitstalk/shared-race/collaborators';
import { ownerOf } from '@gitstalk/shared-identity/orgs';
import type { RepositoryRecord, Viewer } from '@gitstalk/shared-race/repos';
import type { RpcError, RpcResult } from '@gitstalk/shared-race/rpc';
import { RunId } from '@gitstalk/shared-race/ids';

import type { AccessVerdict, RepositoryAccess, RepositoryPrincipal } from '../auth/git-credential';
import { mayUseEngine, personOf, refusedByArchive, roleOf } from '../auth/git-credential';
import { firstPushEngineId, registryEngineId } from '../push/repo-engine';
import type { CollaboratorStore } from './collaborators';

export type Decision = {
  readonly verdict: AccessVerdict;
  readonly role: ViewerRole | null;
  /** Refused only because the repository is archived. */
  readonly archived: boolean;
};

/** The facts about `record` that the rule needs, for this principal. */
export async function accessFacts(
  collaborators: CollaboratorStore,
  record: RepositoryRecord,
  principal: RepositoryPrincipal,
): Promise<RepositoryAccess> {
  const person = personOf(principal);
  const isOwner = person !== null && person.id === record.owner.id;
  const asks = person !== null && !isOwner;
  const isOrgOwned = ownerOf(record).kind === 'org';
  const [collaboratorRole, org, seedEngine] = await Promise.all([
    asks ? collaborators.roleOf(record.id, person.id) : null,
    asks && isOrgOwned ? collaborators.orgStanding(record.owner.id, person.id) : null,
    seedEngineOf(record),
  ]);
  return {
    // Records from before engines had run ids would fail here; every created record has one.
    engine: RunId.parse(record.engine_id),
    seedEngine,
    owner: { id: record.owner.id, handle: record.owner.handle },
    visibility: record.visibility,
    collaboratorRole,
    org,
    archived: record.archived_at !== null,
  };
}

/** May `principal` do `action` with `record`, and what are they on it. */
export async function decideAccess(
  collaborators: CollaboratorStore,
  record: RepositoryRecord,
  input: { readonly principal: RepositoryPrincipal; readonly action: RepositoryAction },
): Promise<Decision> {
  const facts = await accessFacts(collaborators, record, input.principal);
  const verdict = mayUseEngine(input.principal, facts, input.action);
  return {
    verdict,
    role: roleOf(input.principal, facts),
    archived: refusedByArchive(input.principal, facts, input.action),
  };
}

/** The decision as an RPC answer: the record with the viewer's role, or 404 / 403. */
export async function accessResult(
  collaborators: CollaboratorStore,
  record: RepositoryRecord | null,
  input: {
    readonly principal: RepositoryPrincipal;
    readonly action: RepositoryAction;
    readonly what: string;
  },
): Promise<RpcResult<RepositoryForViewer>> {
  if (record === null) return { ok: false, error: notFound(input.what) };
  const decision = await decideAccess(collaborators, record, input);
  switch (decision.verdict) {
    case 'allowed':
      return { ok: true, value: { ...record, viewer_role: decision.role } };
    case 'forbidden':
      return {
        ok: false,
        error: decision.archived
          ? archivedError(record, input.action)
          : forbidden(input.action, decision.role),
      };
    case 'not-found':
      return { ok: false, error: notFound(input.what) };
    default:
      return decision.verdict;
  }
}

/** A web viewer (a signed-in person's id, or nobody) as a principal. */
export function viewerPrincipal(viewer: Viewer): RepositoryPrincipal {
  // Registry records always carry the owner's id, so the person is matched by id alone.
  return viewer === null
    ? { kind: 'anonymous' }
    : { kind: 'person', user: { id: viewer, handle: '' } };
}

export function notFound(what: string): RpcError {
  return { code: 'not_found', status: 404, message: `repository ${what} not found` };
}

/** Why a person who can see a repository may not do this, in their words. */
export function forbidden(action: RepositoryAction, role: ViewerRole | null): RpcError {
  const have = role === null ? 'no role on this repository' : `the ${role} role`;
  return { code: 'forbidden', status: 403, message: `${NEEDS[action]}; you have ${have}` };
}

/** Why an archived repository refuses this, and what would change it. */
export function archivedError(record: RepositoryRecord, action: RepositoryAction): RpcError {
  return {
    code: 'archived',
    status: 403,
    message: archivedMessage(`${record.owner.handle}/${record.name}`, action),
  };
}

/** The sentence git, MCP and the web print for a refusal by archive. */
export function archivedMessage(fullName: string, action: RepositoryAction): string {
  const what = ARCHIVED_REFUSES[action];
  return `${fullName} is archived, so it is read-only: ${what}. Its owner can unarchive it in Settings.`;
}

const ARCHIVED_REFUSES: Readonly<Record<RepositoryAction, string>> = {
  read: 'reading still works',
  write: 'pushes are refused',
  decide: 'decisions cannot be answered',
  'deploy-tokens': 'deploy tokens cannot be made or changed',
  actions: 'workflows cannot be run and secrets cannot be changed',
  administer: 'settings are read-only',
};

const NEEDS: Readonly<Record<RepositoryAction, string>> = {
  read: 'reading needs the read role',
  write: 'pushing beans needs the write role',
  decide: 'answering decisions needs the maintain role',
  'deploy-tokens': 'deploy tokens need the maintain role',
  actions: 'running workflows and managing Actions secrets need the maintain role',
  administer: 'only the owner (or, for an organization, its owners and admins) can change this',
};

/** The seed's engine of a repository whose first push restarted it (`adoptFirstPush`). */
async function seedEngineOf(record: RepositoryRecord): Promise<RunId | undefined> {
  if (record.origin.kind !== 'push') return undefined;
  return record.engine_id === (await firstPushEngineId(record.artifacts_repo))
    ? registryEngineId(record.artifacts_repo)
    : undefined;
}

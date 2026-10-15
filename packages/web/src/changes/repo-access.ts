/**
 * Who may read a repository's engine through the Changes routes: the same lookup its pages
 * make (`lookupRepository` with the viewer, so private and missing both read as not found),
 * then the engine's reads for this request.
 */
import type { User } from '../auth/user';
import type { ReadGrant } from '../edge/read-grant';
import { lookupRepository } from '../repositories/flows';
import type { RegistryClient, RepositoryRecord } from '../repositories/registry-client';
import type { ChangeReads, RepoAccess } from './changes-api';

export type RepoAccessInput = {
  /** The route's params, still URL-encoded. */
  readonly owner: string;
  readonly repo: string;
  readonly viewer: User | null;
  readonly registry: RegistryClient;
  /**
   * The engine's reads, or null when the record's engine id is unusable. `grant` is the proof
   * of this access check that opens its cached reads.
   */
  readonly readsFor: (found: {
    readonly record: RepositoryRecord;
    readonly grant: ReadGrant;
  }) => ChangeReads | null;
};

export async function repoAccess(input: RepoAccessInput): Promise<RepoAccess> {
  const found = await lookupRepository(
    decodeURIComponent(input.owner),
    decodeURIComponent(input.repo),
    input.viewer,
    input.registry,
  );
  if (found.kind === 'not-found') return { kind: 'not-found' };
  return { kind: 'found', visibility: found.record.visibility, reads: input.readsFor(found) };
}

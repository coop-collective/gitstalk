/**
 * The engine's jobs read the run repo through this port: reads named by commit id (a file at
 * a commit, the files or paths between two commits, a commit's message) go through the
 * RunDO's read index, so the approval gate's diff, a repository's checks config, a culprit's
 * diff and a conflict's line ranges share the objects the warm-up after each landing fetched,
 * and fill the index for the next warm-up. Git objects never change under their id, so a
 * cached answer is never stale. Reads of a branch, and every write, go to Artifacts as before.
 */
import type { ArtifactsPort } from '../adapters/artifacts';
import { changedFilesIn, changedPathsIn } from '../adapters/artifacts';
import type { RepoReader } from './object-cache';

/** Opens `repo` with a reader over the read index and runs `use` with it. */
export type IndexedRead = <T>(repo: string, use: (reader: RepoReader) => Promise<T>) => Promise<T>;

const COMMIT_ID = /^[0-9a-f]{40}$/u;

export function readThroughPort(port: ArtifactsPort, read: IndexedRead): ArtifactsPort {
  return {
    ...port,
    readFile: (repo, ref, path) =>
      COMMIT_ID.test(ref)
        ? read(repo, async (reader) => {
            const file = await reader.readFile({ ref, path });
            return file === null ? null : file.text();
          })
        : port.readFile(repo, ref, path),
    changedFiles: (repo, range) => read(repo, (reader) => changedFilesIn(reader, range)),
    changedPaths: (repo, range) => read(repo, (reader) => changedPathsIn(reader, range)),
    commitMessage: (repo, sha) =>
      COMMIT_ID.test(sha)
        ? read(repo, async (reader) => (await reader.readCommit(sha))?.message ?? null)
        : port.commitMessage(repo, sha),
  };
}

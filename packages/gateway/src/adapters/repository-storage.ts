/**
 * A repository's Artifacts repo: create or import it, put its first commit on the stalk and
 * the sprout, list the stalk's files, delete it. Write tokens are minted for one push, used
 * from inside the gateway and revoked; they never leave this module.
 */
import { readChecksFile } from '@gitstalk/shared-race/checks-config';
import type { RepositoryFiles } from '@gitstalk/shared-race/repos';

import { UpstreamError } from '../errors';
import type { SeedCommit } from '../git/seed-pack';
import { emptyPack, seedPack } from '../git/seed-pack';
import { call, withRepo } from './artifacts';

export type RepositoryStorage = {
  /** An empty repo whose default branch is the stalk. */
  create(name: string, description: string): Promise<void>;
  /** A copy of a public git repo (its default branch's history). */
  importFrom(name: string, url: string, description: string): Promise<void>;
  /** Puts a root commit of `seed` on the stalk and the sprout; returns its id. */
  seed(name: string, seed: SeedCommit): Promise<string>;
  /** Points the stalk and the sprout at the imported default branch's head; null if empty. */
  lineFromDefault(name: string): Promise<string | null>;
  files(name: string, ref: string): Promise<RepositoryFiles>;
  delete(name: string): Promise<boolean>;
};

/** The repo's lines, as the engine names them. */
const LINES = ['stalk', 'sprout'] as const;
const ZERO = '0'.repeat(40);
/** A one-push token lives a minute (Artifacts' minimum). */
const PUSH_TOKEN_TTL_SECONDS = 60;
const PUSH_TIMEOUT_MS = 30_000;
/** Files the listing walks at most; the page shows the shape of a repo, not all of it. */
const MAX_LISTED_FILES = 400;
const MAX_TEXT = 8000;
/** Reads of a repo still being created or imported are retried this many times. */
const OPEN_ATTEMPTS = 12;
const OPEN_BACKOFF_MS = 500;

export function repositoryStorage(binding: Artifacts): RepositoryStorage {
  return {
    async create(name, description) {
      await call(`create ${name}`, () =>
        binding.create(name, { description, setDefaultBranch: LINES[0] }),
      );
    },
    async importFrom(name, url, description) {
      await call(`import ${name}`, () =>
        binding.import({ source: { url }, target: { name, opts: { description } } }),
      );
    },
    async seed(name, seed) {
      const { commit, pack } = await seedPack(seed);
      await pushLines(binding, name, commit, pack);
      return commit;
    },
    async lineFromDefault(name) {
      const head = await opened(binding, name, async (repo) => {
        const info = await repo.info();
        const [top] = await repo.log({ ref: info.defaultBranch, limit: 1 });
        return top?.hash ?? null;
      });
      if (head === null) return null;
      await pushLines(binding, name, head, await emptyPack());
      return head;
    },
    files(name, ref) {
      return opened(binding, name, (repo) => listFiles(repo, ref));
    },
    delete(name) {
      return call(`delete ${name}`, () => binding.delete(name));
    },
  };
}

/** Creates `stalk` and `sprout` at `commit` with one smart-HTTP push to the Artifacts remote. */
async function pushLines(
  binding: Artifacts,
  name: string,
  commit: string,
  pack: Uint8Array,
): Promise<void> {
  const { remote, token } = await opened(binding, name, async (repo) => {
    const [info, minted] = await Promise.all([
      repo.info(),
      repo.createToken('write', PUSH_TOKEN_TTL_SECONDS),
    ]);
    return { remote: info.remote, token: minted };
  });
  try {
    const response = await fetch(`${remote}/git-receive-pack`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.plaintext}`,
        'content-type': 'application/x-git-receive-pack-request',
        accept: 'application/x-git-receive-pack-result',
      },
      body: receivePackBody(commit, pack),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    const report = await response.text();
    if (!response.ok) throw new UpstreamError(`seeding ${name}: HTTP ${response.status}`, true);
    const refused = refusedRefs(report);
    if (refused.length > 0)
      throw new UpstreamError(`seeding ${name}: ${refused.join('; ')}`, false);
  } finally {
    await withRepo(binding, name, (repo) => repo.revokeToken(token.id)).catch(() => false);
  }
}

/** `<old> <new> <ref>` for each line (capabilities on the first), a flush, then the pack. */
export function receivePackBody(commit: string, pack: Uint8Array): Uint8Array {
  const lines = LINES.map((line, index) =>
    pktLine(`${ZERO} ${commit} refs/heads/${line}${index === 0 ? '\0report-status' : ''}\n`),
  );
  const head = new TextEncoder().encode(`${lines.join('')}0000`);
  const body = new Uint8Array(head.length + pack.length);
  body.set(head, 0);
  body.set(pack, head.length);
  return body;
}

/** The refs a report-status refused (`ng <ref> <why>`), or an unpack failure. */
export function refusedRefs(report: string): string[] {
  const lines = report.split('\n').map((line) => line.replace(/^[0-9a-f]{4}/, '').trim());
  const unpack = lines.find((line) => line.startsWith('unpack '));
  const refused = lines.filter((line) => line.startsWith('ng '));
  if (unpack !== undefined && unpack !== 'unpack ok') return [unpack, ...refused];
  return refused;
}

function pktLine(text: string): string {
  const length = new TextEncoder().encode(text).length + 4;
  return `${length.toString(16).padStart(4, '0')}${text}`;
}

async function listFiles(repo: ArtifactsRepo, ref: string): Promise<RepositoryFiles> {
  const [top] = await repo.log({ ref, limit: 1 });
  if (top === undefined)
    return {
      ref,
      sha: null,
      files: [],
      readme: null,
      checks: null,
      checksPath: null,
      truncated: false,
    };
  const files: string[] = [];
  const pending: { readonly tree: string; readonly prefix: string }[] = [
    { tree: top.treeHash, prefix: '' },
  ];
  while (pending.length > 0 && files.length < MAX_LISTED_FILES) {
    const next = pending.shift();
    if (next === undefined) break;
    // oxlint-disable-next-line no-await-in-loop -- a breadth-first walk, bounded by MAX_LISTED_FILES
    const entries = (await repo.readTree(next.tree)) ?? [];
    for (const entry of entries) {
      const path = `${next.prefix}${entry.name}`;
      if (entry.type === 'tree') pending.push({ tree: entry.hash, prefix: `${path}/` });
      else if (entry.type !== 'gitlink') files.push(path);
    }
  }
  const [readme, checks] = await Promise.all([
    textAt(repo, top.hash, 'README.md'),
    readChecksFile((path) => textAt(repo, top.hash, path)),
  ]);
  return {
    ref,
    sha: top.hash,
    files: files.slice(0, MAX_LISTED_FILES).toSorted(),
    readme,
    checks: checks?.text ?? null,
    checksPath: checks?.path ?? null,
    truncated: files.length >= MAX_LISTED_FILES || pending.length > 0,
  };
}

async function textAt(repo: ArtifactsRepo, ref: string, path: string): Promise<string | null> {
  const file = await repo.readFile({ ref, path });
  return file === null ? null : (await file.text()).slice(0, MAX_TEXT);
}

/** Opens the repo, retrying while Artifacts is still creating or importing it. */
async function opened<T>(
  binding: Artifacts,
  name: string,
  use: (repo: ArtifactsRepo) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- each attempt waits for the previous one
      return await withRepo(binding, name, use);
    } catch (error: unknown) {
      if (!(error instanceof UpstreamError) || !error.retryable || attempt >= OPEN_ATTEMPTS)
        throw error;
      // oxlint-disable-next-line no-await-in-loop -- backoff between attempts
      await new Promise((resolve) => setTimeout(resolve, OPEN_BACKOFF_MS * attempt));
    }
  }
}

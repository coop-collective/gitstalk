/**
 * What a repository's tabs read from its engine, through the GATEWAY binding, for one request:
 * each read happens at most once per request (a page that needs the pushed beans twice asks
 * once), independent reads run together, and every answer is validated. Code, Changes and
 * History each make a fixed number of calls, never one per bean or per file.
 *
 * Reads may also be cached across requests (`CachedReads`, from `cached-reads.ts`): a tree, a
 * file or a diff at commit shas (which never change) through the edge caches, and a public
 * repository's event log, appended to rather than read whole.
 */
import { z } from 'zod';

import type { Sha as ShaType } from '@gitstalk/shared-race/ids';
import { RunId, Sha, TaskId } from '@gitstalk/shared-race/ids';
import type { RpcResult } from '@gitstalk/shared-race/rpc';

import { eventsAfter } from '@gitstalk/shared-ask/ask/plan-context';
import type { ForgeSource } from '@gitstalk/shared-ask/forge/forge-source';
import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';
import type { RefName, RepoDiff, RepoTree } from '@gitstalk/shared-ask/repo/repo-types';
import type { PushedBean } from '../changes/pushed-beans';
import { readPushedBeans } from '../changes/pushed-beans';
import type { RefChoice } from '../code/tree';
import { forgeForRun } from '../forge/sources';
import type { LogCommit } from '../history/history';
import { LogCommit as LogCommitSchema } from '../history/history';
import { log } from '../log';
import { hasGrownRepository } from '../repositories/flows';
import type { ReadTail } from './event-cache';

/** Commits each line's history shows. */
export const HISTORY_LIMIT = 100;

export type FileBlob = {
  readonly path: string;
  readonly size: number;
  readonly binary: boolean;
  /** Null for a binary file. */
  readonly content: string | null;
  readonly truncated: boolean;
};

export type EngineReads = {
  readonly engine: RunId;
  readonly source: ForgeSource;
  events(): Promise<readonly RaceEvent[]>;
  /**
   * The events after seq `after`: for a public repository, those of its shared log; otherwise
   * only that tail is read from the gateway (the whole log only when `after` is 0).
   */
  eventsAfter(after: number): Promise<readonly RaceEvent[]>;
  pushed(): Promise<readonly PushedBean[]>;
  /** The ref a choice browses: a line by name, a bean by its pushed head; null for an unknown bean. */
  resolve(ref: RefChoice): Promise<RefName | null>;
  tree(ref: RefName): Promise<RepoTree>;
  file(ref: RefName, path: string): Promise<FileBlob | null>;
  log(ref: 'stalk' | 'sprout'): Promise<readonly LogCommit[]>;
  /** A bean's own change: its landing, or its newest head against its base. */
  beanDiff(bean: string): Promise<RepoDiff | null>;
};

const FileAnswer = z.object({
  path: z.string(),
  size: z.number(),
  binary: z.boolean(),
  content: z.string().nullable(),
  truncated: z.boolean(),
});
const LogAnswer = z.object({ commits: z.array(LogCommitSchema) });

/** Events the start-page check reads: the first page `eventsAfter` asks for, so the memoised source shares it. */
const FIRST_EVENTS_PAGE = 5000;

/**
 * Reads that outlive the request (`cached-reads.ts`): only the grant of the viewer's access
 * check on this request produces them. Objects at commit shas go through the edge caches
 * (shared layers for a public repository, the private KV namespace otherwise).
 */
export type CachedReads = {
  /**
   * The whole event log, given a reader of the events after a sequence number; null when the
   * log is not cached (a private or internal repository), so it is read from the gateway.
   */
  readonly events: ((readTail: ReadTail) => Promise<readonly RaceEvent[]>) | null;
  tree(sha: ShaType): Promise<RepoTree>;
  /** Null when the commit has no such file; throws when the gateway failed. */
  file(sha: ShaType, path: string): Promise<FileBlob | null>;
  diff(base: ShaType, head: ShaType): Promise<RepoDiff>;
};

/** Raw reads the forge source does not carry (a file's binary flag, commit authors and dates). */
type RawReads = {
  repoFile(run: string, ref: string, path: string): Promise<RpcResult<unknown>>;
  repoLog(run: string, ref: string, paths: null, limit: number): Promise<RpcResult<unknown>>;
};

export function engineReads(
  binding: Fetcher,
  engine: RunId,
  cached: CachedReads | null = null,
): EngineReads {
  const source = forgeForRun(binding, engine);
  const events = once<readonly RaceEvent[]>();
  const pushed = once<readonly PushedBean[]>();
  const trees = once<RepoTree>();
  const files = once<FileBlob | null>();
  const logs = once<readonly LogCommit[]>();
  const diffs = once<RepoDiff | null>();
  const cachedLog = cached?.events ?? null;
  const readPushed = () => pushed('', () => readPushedBeans(binding, engine));
  const readEvents = () =>
    events('', async () =>
      cachedLog === null
        ? (await eventsAfter(source, engine, 0)).events
        : cachedLog((after) => eventsAfter(source, engine, after)),
    );
  return {
    engine,
    source,
    events: readEvents,
    eventsAfter: async (after) => {
      if (cachedLog !== null || after === 0)
        return (await readEvents()).filter((event) => event.seq > after);
      return (await eventsAfter(source, engine, after)).events;
    },
    pushed: readPushed,
    resolve: async (ref) => {
      if (ref.kind === 'commit') return Sha.safeParse(ref.sha).data ?? null;
      if (ref.kind !== 'bean') return ref.kind;
      const head = Sha.safeParse((await readPushed()).find((bean) => bean.bean === ref.name)?.head);
      return head.success ? head.data : null;
    },
    tree: (ref) =>
      trees(ref, () => {
        const sha = shaOf(ref);
        return cached !== null && sha !== null ? cached.tree(sha) : source.repoTree(engine, ref);
      }),
    file: (ref, path) =>
      files(`${ref}:${path}`, () => {
        const sha = shaOf(ref);
        const read =
          cached !== null && sha !== null
            ? cached.file(sha, path)
            : readFile(binding, { engine, ref, path });
        return read.catch((error: unknown) => {
          log.warn('file unreadable; the page shows it as missing', { engine, ref, path, error });
          return null;
        });
      }),
    log: (ref) =>
      logs(ref, async () => {
        const raw = hasRawReads(binding) ? binding : null;
        const answer = await raw?.repoLog(engine, ref, null, HISTORY_LIMIT);
        return answer?.ok === true ? LogAnswer.parse(answer.value).commits : [];
      }),
    beanDiff: (bean) =>
      diffs(bean, async () => {
        const id = TaskId.safeParse(bean);
        const detail = id.success ? await source.beanDetail(engine, id.data) : undefined;
        if (detail === undefined || detail.diffBase === null || detail.diffHead === null)
          return null;
        return cached === null
          ? source.repoDiff(engine, detail.diffBase, detail.diffHead)
          : cached.diff(detail.diffBase, detail.diffHead);
      }),
  };
}

/**
 * Whether a repository has grown past its start page: a pushed bean, or a started one in the
 * first page of its log (a repository that has not grown has a short log). The page of events
 * is the one a full read starts with, so a page that goes on to read the log shares it.
 */
export async function hasGrownEngine(reads: EngineReads): Promise<boolean> {
  const pushed = await reads.pushed();
  if (pushed.length > 0) return true;
  const first = await reads.source.runEvents(reads.engine, 0, FIRST_EVENTS_PAGE);
  if (hasGrownRepository(first.events, pushed)) return true;
  return first.done || first.events.length < FIRST_EVENTS_PAGE
    ? false
    : hasGrownRepository(await reads.events(), pushed);
}

/**
 * A file at a ref, read raw (the forge source carries no binary flag): null when the gateway
 * answers that there is no such file (any 4xx: a definite answer) or is too old to read files;
 * throws when the gateway failed, so a shared cache never keeps a passing failure.
 */
export async function readFile(
  binding: object,
  at: { readonly engine: RunId; readonly ref: RefName; readonly path: string },
): Promise<FileBlob | null> {
  if (!hasRawReads(binding)) return null;
  const answer = await binding.repoFile(at.engine, at.ref, at.path);
  if (answer.ok) return FileAnswer.parse(answer.value);
  if (answer.error.status < 500) return null;
  throw new Error(`repoFile ${at.ref}:${at.path} failed: ${answer.error.message}`);
}

function shaOf(ref: RefName): ShaType | null {
  return ref === 'stalk' || ref === 'sprout' || ref === 'base' ? null : ref;
}

function hasRawReads(binding: object): binding is RawReads {
  return ['repoFile', 'repoLog'].every(
    (method) => typeof Reflect.get(binding, method) === 'function',
  );
}

/** The engine of a repository record, or null for a record whose engine id is malformed. */
export function engineOf(engineId: string): RunId | null {
  const parsed = RunId.safeParse(engineId);
  return parsed.success ? parsed.data : null;
}

/** A per-request cache of one kind of read: the first call for a key reads, later ones share it. */
function once<T>(): (key: string, read: () => Promise<T>) => Promise<T> {
  const reads = new Map<string, Promise<T>>();
  return (key, read) => {
    const cached = reads.get(key);
    if (cached !== undefined) return cached;
    const started = read();
    reads.set(key, started);
    return started;
  };
}

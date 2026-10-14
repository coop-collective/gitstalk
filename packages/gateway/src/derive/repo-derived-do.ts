/**
 * RepoDerivedDO: one Durable Object per repository engine (named by its engine id), beside
 * the engine's RunDO, holding derived history (docs/claude-opus/34-derived-data-and-blame.md).
 * The `repo-events` consumer feeds it each batch of the engine's events after indexing them
 * (`observe`): facts are recorded at once and the eager derivers advance in the background.
 * Reads (`whyLines`, `pathHistory`) advance the derivers they need first (the lazy path), so a
 * missed or failed feed costs one slower read, never a wrong answer. The engine never waits
 * on, reads or writes anything here. Work runs one call at a time (`#serial`), because each
 * step awaits Artifacts reads and the chain must grow in order.
 */
import { DurableObject } from 'cloudflare:workers';

import type {
  PathHistory,
  PathHistoryInput,
  WhyLines,
  WhyLinesInput,
} from '@gitstalk/shared-race/derived';
import type { RepoEvent } from '@gitstalk/shared-race/repo-events';
import type { RpcResult } from '@gitstalk/shared-race/rpc';

import { readConfig } from '../config';
import { UpstreamError } from '../errors';
import type { Logger } from '../log';
import { createLogger } from '../log';
import { countLines } from '../git/diff-text';
import type { BlameSpan } from './blame-spans';
import { wholeFile } from './blame-spans';
import type { ChainReader } from './chain-reader';
import { withChainReader } from './chain-reader';
import type { ChainStore } from './derive-chain';
import type { Deriver } from './deriver';
import { DeriveError, advance, extendChain, parentState } from './derive-chain';
import type { ReadPoint } from './derived-answers';
import { pathHistoryAnswer, whyLinesAnswer } from './derived-answers';
import { recordEvents } from './derived-facts';
import { chainTip, commitBySha, lineHead, migrateDerivedStore, rowsUpTo } from './derived-store';
import { BASE_SEQ, DERIVERS, HistoryRow, beanBlame, pathHistory } from './derivers';

/** Changesets one read may derive before it answers `deriving`. */
const READ_BUDGET = 64;
/** Changesets per round of the background feed (rounds repeat until caught up). */
const FEED_BUDGET = 64;
const DEFAULT_HISTORY = 20;
const MAX_HISTORY = 100;

export type ObserveInput = { readonly repo: string; readonly events: readonly RepoEvent[] };
export type DerivedRead<T> = T & { readonly repo: string };

export class RepoDerivedDO extends DurableObject<Env> {
  readonly #log: Logger;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#log = createLogger(readConfig(env).logLevel, { component: 'derived' });
    migrateDerivedStore(ctx.storage.sql);
  }

  /** A batch of the engine's repository events, in order (the consumer's feed). */
  observe(input: ObserveInput): void {
    // The sprout's head when the work runs, not the event's commit: an old event never drags
    // the chain back to a line that has since moved on.
    const landed = recordEvents(this.ctx.storage.sql, input.events);
    if (landed !== null)
      this.#deriveInBackground(
        input.repo,
        'sprout',
        DERIVERS.filter((d) => d.eager),
      );
  }

  /** Which bean last changed each line range of a file at a sprout commit. */
  whyLines(input: DerivedRead<WhyLinesInput>): Promise<RpcResult<WhyLines>> {
    return this.#read(input, async (reader, point) => {
      const blame = await this.#blameAt(reader, point);
      return whyLinesAnswer(this.ctx.storage.sql, point, { ...blame, window: input });
    });
  }

  /** The sprout commits that touched a path, newest first. */
  pathHistory(input: DerivedRead<PathHistoryInput>): Promise<RpcResult<PathHistory>> {
    const limit = Math.max(1, Math.min(MAX_HISTORY, input.limit ?? DEFAULT_HISTORY));
    return this.#read(input, async (reader, point) => {
      await this.#require(reader, pathHistory, point.commit.seq);
      const rows = rowsUpTo(this.ctx.storage.sql, pathHistory.name, {
        path: point.path,
        seq: point.commit.seq,
        limit: limit + 1,
      }).map(({ seq, row }) => ({ seq, row: HistoryRow.parse(JSON.parse(row)) }));
      return pathHistoryAnswer(this.ctx.storage.sql, point, {
        rows: rows.slice(0, limit),
        truncated: rows.length > limit,
      });
    });
  }

  /** The file's blame at the read point, derived first if needed. */
  async #blameAt(
    reader: ChainReader,
    point: ReadPoint,
  ): Promise<{ readonly spans: readonly BlameSpan[]; readonly lines: number | null }> {
    await this.#require(reader, beanBlame, point.commit.seq);
    const row = parentState(this.ctx.storage.sql, beanBlame).at(point.path, point.commit.seq);
    if (row?.kind === 'deleted') throw notFound(point);
    if (row?.kind === 'opaque') return { spans: wholeFile(1, row.owner), lines: null };
    if (row?.kind === 'lines') {
      const spans = row.spans.map(([start, end, owner]) => ({ start, end, owner }));
      return { spans, lines: spans.at(-1)?.end ?? 0 };
    }
    // Never changed since derivation began: every line is the base's, if the file exists.
    const text = await reader.readText(point.commit.sha, point.path);
    if (text === null) throw notFound(point);
    const lines = countLines(text);
    return { spans: wholeFile(lines, BASE_SEQ), lines };
  }

  /** Advances one deriver to `seq` within the read budget, or answers `deriving`. */
  async #require(reader: ChainReader, deriver: Deriver<unknown>, seq: number): Promise<void> {
    const done = await advance(this.#store(), reader, {
      derivers: [deriver],
      to: seq,
      budget: READ_BUDGET,
    });
    if (!done)
      throw new DeriveError(
        'history is still being derived; ask again in a few seconds',
        'deriving',
        503,
      );
  }

  /** Resolves the ref onto the chain, runs `read`, and turns expected failures into values. */
  #read<T>(
    input: { readonly repo: string; readonly path: string; readonly ref?: string | undefined },
    read: (reader: ChainReader, point: ReadPoint) => Promise<T>,
  ): Promise<RpcResult<T>> {
    const ref = input.ref ?? 'sprout';
    return this.#serial(async () => {
      try {
        const value = await withChainReader(this.env.REPOS, input.repo, async (reader) => {
          const sha = await resolve(this.ctx.storage.sql, reader, ref);
          const detached = sha === ref ? 'refuse' : 'restart';
          const commit = await extendChain(this.#store(), reader, { sha, detached });
          return read(reader, {
            path: input.path,
            ref,
            commit,
            stalkSeq: await this.#stalkSeq(reader),
          });
        });
        return { ok: true, value };
      } catch (error: unknown) {
        // A read that ran out of budget leaves the rest to the background.
        if (error instanceof DeriveError && error.code === 'deriving') this.#catchUp(input.repo);
        return failure(error);
      }
    });
  }

  /** Every deriver, up to the chain's tip, in the background (after a read ran out of budget). */
  #catchUp(repo: string): void {
    const tip = chainTip(this.ctx.storage.sql);
    if (tip !== null) this.#deriveInBackground(repo, tip.sha, DERIVERS);
  }

  /**
   * Extends the chain to `ref` (`sprout`, or a commit already on the chain) and advances
   * `derivers` to it, round after round, off the caller's path.
   */
  #deriveInBackground(repo: string, ref: string, derivers: readonly Deriver<unknown>[]): void {
    const work = this.#serial(() =>
      withChainReader(this.env.REPOS, repo, async (reader) => {
        const sha = await resolve(this.ctx.storage.sql, reader, ref);
        const commit = await extendChain(this.#store(), reader, { sha, detached: 'restart' });
        const round = { derivers, to: commit.seq, budget: FEED_BUDGET };
        // oxlint-disable-next-line no-await-in-loop -- rounds follow each other until caught up
        for (let done = false; !done; done = await advance(this.#store(), reader, round));
      }),
    ).catch((error: unknown) => {
      // The next read derives what this missed.
      this.#log.warn('deriving in the background failed', { ref, error });
    });
    this.ctx.waitUntil(work);
  }

  /** The stalk's position on the chain: from the events, else its branch head. */
  async #stalkSeq(reader: ChainReader): Promise<number | null> {
    const sql = this.ctx.storage.sql;
    const sha = lineHead(sql, 'stalk') ?? (await reader.head('stalk'));
    return sha === null ? null : (commitBySha(sql, sha)?.seq ?? null);
  }

  #store(): ChainStore {
    const { storage } = this.ctx;
    return { sql: storage.sql, transact: (write) => storage.transactionSync(write) };
  }

  /** Runs `work` after every call before it (one derivation at a time). */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }
}

/**
 * The commit a ref names. A line is read where the engine's events last put it (the answer is
 * as of the last indexed landing, like the rest of the forge's indexes), else at its branch.
 */
async function resolve(sql: SqlStorage, reader: ChainReader, ref: string): Promise<string> {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  if (ref !== 'sprout' && ref !== 'stalk')
    throw new DeriveError(
      'derived history reads sprout, stalk or a sprout commit',
      'invalid_request',
      400,
    );
  const head = lineHead(sql, ref) ?? (await reader.head(ref));
  if (head === null) throw new DeriveError(`the repository has no ${ref} yet`, 'not_found', 404);
  return head;
}

function notFound(point: ReadPoint): DeriveError {
  return new DeriveError(`no file ${point.path} at ${point.ref}`, 'not_found', 404);
}

function failure(error: unknown): {
  readonly ok: false;
  readonly error: { code: string; status: number; message: string };
} {
  if (error instanceof DeriveError)
    return { ok: false, error: { code: error.code, status: error.status, message: error.message } };
  if (error instanceof UpstreamError)
    return { ok: false, error: { code: 'upstream_failed', status: 502, message: error.message } };
  throw error;
}

/**
 * `why_lines`: before changing code, which bean last changed these lines and why: each line
 * range with its bean, the bean's title (its intent), the landing commit and any decision card
 * that weighed it, plus the path's recent history (landings and reverts). Read from the
 * gateway's derived history (docs/claude-opus/34-derived-data-and-blame.md); one tool for both,
 * to keep the server's tool count down.
 */
import type { z } from 'zod';

import type { DerivedBean, DerivedCommit } from '@gitstalk/shared-race/derived';
import { PathHistory, WhyLines } from '@gitstalk/shared-race/derived';
import type { RpcResult } from '@gitstalk/shared-race/rpc';

import { unwrap } from '@gitstalk/shared-ask/forge/gateway-rpc';

import { ToolError } from '../mcp/tool-result';
import type { ToolContext } from './tool-context';

/** Entries of the path's history in an answer. */
const HISTORY_ENTRIES = 8;
const SHORT_SHA = 10;

export type WhyLinesInput = {
  readonly path: string;
  readonly start?: number | undefined;
  readonly end?: number | undefined;
  readonly ref?: 'sprout' | 'stalk' | undefined;
};

type WhyRange = {
  readonly lines: string;
  readonly bean: string | null;
  readonly commit: string;
  readonly kind: DerivedCommit['kind'];
  /** The commit's title, for lines no bean owns (the base, an engine commit). */
  readonly title?: string;
};

type HistoryEntry = {
  readonly commit: string;
  readonly kind: DerivedCommit['kind'];
  readonly bean: string | null;
  readonly change: string;
  readonly at: string;
  readonly on_stalk: boolean | null;
};

export type WhyLinesAnswer = {
  readonly path: string;
  readonly ref: string;
  readonly commit: string;
  readonly lines: number | null;
  readonly ranges: readonly WhyRange[];
  readonly beans: Readonly<Record<string, Omit<DerivedBean, 'bean'>>>;
  readonly history: readonly HistoryEntry[];
  readonly summary: string;
};

type DerivedMethods = {
  whyLines(run: string, input: object): Promise<RpcResult<unknown>>;
  pathHistory(run: string, input: object): Promise<RpcResult<unknown>>;
};

export async function whyLines(ctx: ToolContext, input: WhyLinesInput): Promise<WhyLinesAnswer> {
  const rpc = derivedRpcOf(ctx.gateway);
  if (rpc === undefined) throw new ToolError('this forge does not derive line history yet');
  const ref = input.ref ?? 'sprout';
  const [why, history] = await Promise.all([
    rpc.whyLines(ctx.run, { path: input.path, ref, start: input.start, end: input.end }),
    rpc.pathHistory(ctx.run, { path: input.path, ref, limit: HISTORY_ENTRIES }),
  ]);
  const blame = parse(why, WhyLines);
  const past = parse(history, PathHistory);
  const ranges = blame.ranges.map((range) => toRange(range, blame.commits[range.commit]));
  return {
    path: blame.path,
    ref,
    commit: short(blame.commit),
    lines: blame.lines,
    ranges,
    beans: Object.fromEntries(
      Object.values({ ...past.beans, ...blame.beans }).map(({ bean, ...rest }) => [bean, rest]),
    ),
    history: past.entries.map((entry) => ({
      commit: short(entry.sha),
      kind: entry.kind,
      bean: entry.bean,
      change: entry.change,
      at: entry.at,
      on_stalk: entry.on_stalk,
    })),
    summary: summarize(ranges),
  };
}

/** The gateway's derived-history methods, or undefined for a gateway that predates them. */
function derivedRpcOf(binding: object): DerivedMethods | undefined {
  const why: unknown = Reflect.get(binding, 'whyLines');
  const history: unknown = Reflect.get(binding, 'pathHistory');
  if (typeof why !== 'function' || typeof history !== 'function') return undefined;
  return {
    whyLines: async (run, input) => Reflect.apply(why, binding, [run, input]),
    pathHistory: async (run, input) => Reflect.apply(history, binding, [run, input]),
  };
}

/** A derived-history answer; its expected failures become tool errors the agent can read. */
function parse<S extends z.ZodType>(result: RpcResult<unknown>, schema: S): z.infer<S> {
  if (!result.ok) throw new ToolError(`${result.error.code}: ${result.error.message}`);
  return unwrap(result, schema);
}

function toRange(
  range: { readonly start: number; readonly end: number; readonly commit: string },
  commit: DerivedCommit | undefined,
): WhyRange {
  const lines = range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`;
  const base = {
    lines,
    bean: commit?.bean ?? null,
    commit: short(range.commit),
    kind: commit?.kind ?? 'commit',
  };
  return base.bean === null ? { ...base, title: commit?.title ?? '' } : base;
}

function summarize(ranges: readonly WhyRange[]): string {
  const beans = [
    ...new Set(
      ranges.flatMap((range) =>
        range.kind === 'landing' && range.bean !== null ? [range.bean] : [],
      ),
    ),
  ];
  if (beans.length === 0) return 'No bean changed these lines since derived history began.';
  return `${beans.length} bean${beans.length === 1 ? '' : 's'} last changed these lines: ${beans.join(', ')}. Read their titles and decisions before changing them.`;
}

function short(sha: string): string {
  return sha.slice(0, SHORT_SHA);
}

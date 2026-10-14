/**
 * Derived rows into answers (`@gitstalk/shared-race/derived`): blame spans become 1-based line
 * ranges naming commits, and the commits and their beans are described once each, with the
 * bean's title, actor, decision cards and whether it was reverted.
 */
import type {
  DerivedBean,
  DerivedCommit,
  PathHistory,
  WhyLines,
} from '@gitstalk/shared-race/derived';

import type { BlameSpan } from './blame-spans';
import { clipSpans } from './blame-spans';
import type { StoredCommit } from './derived-store';
import { beansNamed, cardsOf, commitsAt } from './derived-store';
import type { HistoryRow } from './derivers';

/** Where the answer was read: the ref asked, its commit, and the stalk's position if known. */
export type ReadPoint = {
  readonly path: string;
  readonly ref: string;
  readonly commit: StoredCommit;
  readonly stalkSeq: number | null;
};

/** Lines asked for, 1-based and inclusive; absent ends mean the file's. */
export type LineWindow = { readonly start?: number | undefined; readonly end?: number | undefined };

export function whyLinesAnswer(
  sql: SqlStorage,
  point: ReadPoint,
  blame: {
    readonly spans: readonly BlameSpan[];
    readonly lines: number | null;
    readonly window: LineWindow;
  },
): WhyLines {
  const { window } = blame;
  const total = blame.lines ?? 1;
  const start = Math.max(1, window.start ?? 1) - 1;
  const end = Math.min(total, window.end ?? total);
  const spans = clipSpans(blame.spans, start, end);
  const described = describe(
    sql,
    point,
    spans.map((span) => span.owner),
  );
  const ranges = spans.flatMap((span) => {
    const commit = described.bySeq.get(span.owner);
    return commit === undefined
      ? []
      : [{ start: span.start + 1, end: span.end, commit: commit.sha }];
  });
  return {
    path: point.path,
    ref: point.ref,
    commit: point.commit.sha,
    lines: blame.lines,
    ranges,
    commits: Object.fromEntries(
      [...described.bySeq.values()].map((commit) => [commit.sha, commit]),
    ),
    beans: described.beans,
  };
}

export function pathHistoryAnswer(
  sql: SqlStorage,
  point: ReadPoint,
  history: {
    readonly rows: readonly { readonly seq: number; readonly row: HistoryRow }[];
    readonly truncated: boolean;
  },
): PathHistory {
  const described = describe(
    sql,
    point,
    history.rows.map((row) => row.seq),
  );
  return {
    path: point.path,
    ref: point.ref,
    commit: point.commit.sha,
    entries: history.rows.flatMap(({ seq, row }) => {
      const commit = described.bySeq.get(seq);
      return commit === undefined ? [] : [{ ...commit, change: row.change }];
    }),
    beans: described.beans,
    truncated: history.truncated,
  };
}

type Described = {
  readonly bySeq: ReadonlyMap<number, DerivedCommit>;
  readonly beans: Record<string, DerivedBean>;
};

function describe(sql: SqlStorage, point: ReadPoint, seqs: readonly number[]): Described {
  const commits = commitsAt(sql, seqs);
  const beanIds = commits.flatMap((commit) => (commit.bean === null ? [] : [commit.bean]));
  const known = new Map(beansNamed(sql, beanIds).map((bean) => [bean.bean, bean]));
  const cards = cardsOf(sql, beanIds);
  const bySeq = new Map(
    commits.map((commit) => [commit.seq, toCommit(commit, point.stalkSeq)] as const),
  );
  const beans: Record<string, DerivedBean> = {};
  for (const commit of commits) {
    if (commit.bean === null || beans[commit.bean] !== undefined) continue;
    const facts = known.get(commit.bean);
    // A landing's own title stands in until the bean's event told its title.
    const landing = commits.find((other) => other.bean === commit.bean && other.kind === 'landing');
    beans[commit.bean] = {
      bean: commit.bean,
      title: facts !== undefined && facts.title !== '' ? facts.title : (landing?.title ?? ''),
      actor: facts?.actor ?? null,
      decisions: cards.get(commit.bean) ?? [],
      reverted:
        facts?.reverted === 1 ||
        commits.some((other) => other.kind === 'revert' && other.bean === commit.bean),
    };
  }
  return { bySeq, beans };
}

function toCommit(commit: StoredCommit, stalkSeq: number | null): DerivedCommit {
  return {
    sha: commit.sha,
    kind: commit.kind,
    bean: commit.bean,
    title: commit.title,
    at: new Date(commit.at_ms).toISOString(),
    on_stalk: stalkSeq === null ? null : commit.seq <= stalkSeq,
  };
}

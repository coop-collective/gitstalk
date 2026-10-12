'use client';

import type { ReactNode } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { BeanStreamSummary, BeanStreamView } from '@gitstalk/shared-ask/forge/bean-stream';
import { BeanStreamSocketMessage } from '@gitstalk/shared-ask/forge/bean-stream';
import type { LiveStreams } from '../../src/live/stream-state';
import {
  applyStreamMessage,
  beanView,
  seedStream,
  writingSummaries,
} from '../../src/live/stream-state';

/**
 * Streaming diffs (`stream_diffs`) on the repository home (docs/claude-17-streaming-diffs.md):
 * one stream feed per page, subscribed to the beans whose diffs are on screen. The beans
 * come from the components that call `useBeanStream`; the stalk and Growing now read the
 * summaries of every bean being written.
 */
type StreamsContext = {
  readonly run: string;
  readonly enabled: boolean;
  readonly streams: LiveStreams;
  readonly summaries: ReadonlyMap<string, BeanStreamSummary>;
  /** Puts a bean on screen; the returned function takes it off. */
  readonly watch: (bean: string) => () => void;
  readonly seed: (view: BeanStreamView) => void;
};

const NO_STREAMS: StreamsContext = {
  run: '',
  enabled: false,
  streams: new Map(),
  summaries: new Map(),
  watch: () => () => undefined,
  seed: () => undefined,
};

const LiveStreamsContext = createContext<StreamsContext>(NO_STREAMS);

export function LiveStreamsProvider(props: {
  readonly run: string;
  /** A live run streams; a recorded one replays and has nothing streaming. */
  readonly enabled: boolean;
  readonly children: ReactNode;
}) {
  const { run, enabled } = props;
  const { beans, watch } = useWatchedBeans();
  const { streams, seed } = useLiveStreams(run, beans, enabled);
  const summaries = useMemo(() => writingSummaries(streams), [streams]);
  const value = useMemo(
    () => ({ run, enabled, streams, summaries, watch, seed }),
    [run, enabled, streams, summaries, watch, seed],
  );
  return <LiveStreamsContext value={value}>{props.children}</LiveStreamsContext>;
}

/**
 * Follows a live run's stream feed (`/api/runs/:run/streams?beans=`): every bean's summary,
 * and the files of `beans`, patched in place as the agents write. Changing `beans` reconnects
 * this feed only; what is held stays.
 */
export function useLiveStreams(
  run: string,
  beans: readonly string[],
  enabled: boolean,
): { readonly streams: LiveStreams; readonly seed: (view: BeanStreamView) => void } {
  const [streams, setStreams] = useState<LiveStreams>(new Map());
  const subscribed = beans.join(',');
  useEffect(() => {
    if (!enabled) return undefined;
    const query = subscribed === '' ? '' : `?beans=${encodeURIComponent(subscribed)}`;
    const source = new EventSource(`/api/runs/${run}/streams${query}`);
    source.addEventListener('stream', (message) => {
      const parsed = BeanStreamSocketMessage.safeParse(parseJson(message.data));
      if (parsed.success) setStreams((current) => applyStreamMessage(current, parsed.data));
    });
    source.addEventListener('end', () => source.close());
    return () => source.close();
  }, [run, subscribed, enabled]);
  const seed = useCallback(
    (view: BeanStreamView) => setStreams((current) => seedStream(current, view)),
    [],
  );
  return { streams, seed };
}

/** The engine run the page streams from ('' outside a `LiveStreamsProvider`). */
export function useStreamRun(): string {
  return useContext(LiveStreamsContext).run;
}

/** The summaries of every bean being written now, by task. */
export function useStreamSummaries(): ReadonlyMap<string, BeanStreamSummary> {
  return useContext(LiveStreamsContext).summaries;
}

/**
 * A bean's streamed change, patched in place as its agent writes. The bean joins the feed's
 * subscription while the caller is on screen; until its files arrive (first paint) they are
 * read once through the GET route. `writing` is false once the stream ended; the last files
 * stay until the caller has the commit.
 */
export function useBeanStream(bean: string): {
  readonly view: BeanStreamView | null;
  readonly writing: boolean;
} {
  const { run, enabled, streams, watch, seed } = useContext(LiveStreamsContext);
  useEffect(() => watch(bean), [watch, bean]);
  const live = streams.get(bean);
  const view = beanView(live);
  const writing = live?.writing === true;
  const missing = enabled && writing && view === null ? (live?.summary?.inv ?? null) : null;
  useEffect(() => {
    if (missing === null) return undefined;
    const controller = new AbortController();
    const load = async () => {
      try {
        const first = await fetchStream(run, bean, controller.signal);
        if (first !== null) seed(first);
      } catch {
        // An aborted or failed read is fine: the feed's snapshot fills the view.
      }
    };
    void load();
    return () => controller.abort();
  }, [run, bean, missing, seed]);
  return { view, writing };
}

/** The beans on screen, counted per caller, as a sorted list that changes only when they do. */
function useWatchedBeans(): {
  readonly beans: readonly string[];
  readonly watch: (bean: string) => () => void;
} {
  const counts = useRef(new Map<string, number>());
  const [beans, setBeans] = useState<readonly string[]>([]);
  const publish = useCallback(() => {
    const next = [...counts.current.keys()].toSorted();
    setBeans((current) => (current.join(',') === next.join(',') ? current : next));
  }, []);
  const watch = useCallback(
    (bean: string) => {
      counts.current.set(bean, (counts.current.get(bean) ?? 0) + 1);
      publish();
      return () => {
        const left = (counts.current.get(bean) ?? 1) - 1;
        if (left > 0) counts.current.set(bean, left);
        else counts.current.delete(bean);
        publish();
      };
    },
    [publish],
  );
  return { beans, watch };
}

async function fetchStream(
  run: string,
  bean: string,
  signal: AbortSignal,
): Promise<BeanStreamView | null> {
  const response = await fetch(`/api/runs/${run}/beans/${bean}/stream`, {
    signal,
    cache: 'no-store',
  });
  if (!response.ok) return null;
  const body: { readonly stream: BeanStreamView | null } = await response.json();
  return body.stream;
}

function parseJson(data: unknown): unknown {
  if (typeof data !== 'string') return undefined;
  try {
    return JSON.parse(data);
  } catch {
    // A malformed stream message is skipped; the next summary or snapshot replaces it.
    return undefined;
  }
}

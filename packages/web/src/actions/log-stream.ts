/**
 * A job's log over HTTP, for the log route: Server-Sent Events while the job runs (`lines`
 * with the new lines and the last line's number as the event id, `job` with the steps'
 * states, `end` once every line is in, `failed` when the control plane refuses), resumed from
 * `Last-Event-ID` or `?after=`; or, with `?download=1`, the whole log as plain text. A public
 * repository's finished, complete log is kept by the browser for good; anything else (a
 * running job, a log whose last lines are not stored yet, any private or internal
 * repository's log) is never kept, and neither is the stream. The caller has already checked
 * who may read the repository.
 */
import { IMMUTABLE, NO_STORE, byVisibility, cacheControl } from '../edge/http-cache';
import { log } from '../log';
import type { Visibility } from '../query/policy';
import type { ActionsClient } from './actions-client';
import { plainLog } from './log-view';
import { isLive, stateOf } from './run-view';

/** How often a live job's new lines are read, and how long one response follows (the browser then reconnects). */
const POLL_MS = 1000;
const FOLLOW_MS = 4 * 60_000;

export type LogTiming = { readonly pollMs: number; readonly followMs: number };

/** The job whose log is asked for, and its repository's visibility. */
export type LogTarget = {
  readonly run: string;
  readonly job: string;
  readonly visibility: Visibility;
};

export function jobLogResponse(
  request: Request,
  client: ActionsClient,
  target: LogTarget,
  timing: LogTiming = { pollMs: POLL_MS, followMs: FOLLOW_MS },
): Promise<Response> | Response {
  const url = new URL(request.url);
  if (url.searchParams.get('download') === '1') return download(client, target);
  const after = resumeAfter(request, url);
  const { run, job } = target;
  const options = { client, run, job, after, signal: request.signal, timing };
  const stream = client.follow === null ? pollLog(options) : relayLog(options, client.follow);
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
}

async function download(client: ActionsClient, where: LogTarget): Promise<Response> {
  const [detail, page] = await Promise.all([
    client.run(where.run),
    client.log(where.run, where.job, 0),
  ]);
  if (!detail.ok) return problem(404, detail.error.message);
  if (!page.ok) return problem(404, page.error.message);
  const job = detail.value.jobs.find((candidate) => candidate.id === where.job);
  if (job === undefined) return problem(404, 'no such job');
  const name = `${detail.value.workflowName}-${detail.value.number}-${job.name}`.replace(
    /[^\w.-]+/g,
    '-',
  );
  // A finished job's log never changes once every line is stored (the state and the lines
  // are read together, so a just-finished job's page can still miss its last lines).
  const isFinal = !isLive(stateOf(job)) && page.value.complete;
  const rule = byVisibility(where.visibility, {
    public: isFinal ? IMMUTABLE : NO_STORE,
    restricted: NO_STORE,
  });
  return new Response(plainLog(job.steps, page.value.lines), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="${name}.log"`,
      'cache-control': cacheControl(rule),
    },
  });
}

type FollowOptions = {
  readonly client: ActionsClient;
  readonly run: string;
  readonly job: string;
  readonly after: number;
  readonly signal: AbortSignal;
  readonly timing: LogTiming;
};

type Send = (event: string, data: unknown, id?: number) => void;

function sseStream(write: (send: Send) => Promise<void>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send: Send = (event, data, id) =>
        controller.enqueue(
          encoder.encode(
            `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
          ),
        );
      await write(send);
      controller.close();
    },
  });
}

/** The control plane's relay (history, then live frames) as events, until the job ends. */
function relayLog(
  options: FollowOptions,
  follow: NonNullable<ActionsClient['follow']>,
): ReadableStream<Uint8Array> {
  const { run, job, signal } = options;
  return sseStream(async (send) => {
    try {
      const events = follow({ runId: run, jobId: job, after: options.after, signal });
      for await (const event of events) {
        if (event.kind === 'lines') send('lines', { lines: event.lines }, event.lines.at(-1)?.n);
        else if (event.kind === 'job') send('job', event.job);
        else if (event.kind === 'failed') send('failed', { message: event.message });
        else send('end', {});
        if (signal.aborted || event.kind === 'end' || event.kind === 'failed') break;
      }
    } catch (error: unknown) {
      log.error('job log relay failed', { run, job, error });
    }
  });
}

/** The job's new lines and states, read every `pollMs`, until it finishes or `followMs` passes. */
function pollLog(options: FollowOptions): ReadableStream<Uint8Array> {
  const { client, run, job, signal } = options;
  return sseStream(async (send) => {
    let after = options.after;
    const until = Date.now() + options.timing.followMs;
    try {
      while (!signal.aborted && Date.now() < until) {
        // oxlint-disable-next-line no-await-in-loop -- each read follows the previous one by design (a poll)
        const [page, detail] = await Promise.all([client.log(run, job, after), client.run(run)]);
        if (!page.ok) {
          send('failed', { message: page.error.message });
          break;
        }
        if (!detail.ok) {
          send('failed', { message: detail.error.message });
          break;
        }
        const last = page.value.lines.at(-1);
        if (last !== undefined) {
          after = last.n;
          send('lines', { lines: page.value.lines }, after);
        }
        const state = detail.value.jobs.find((candidate) => candidate.id === job);
        if (state !== undefined) send('job', state);
        if (page.value.complete) {
          send('end', {});
          break;
        }
        // oxlint-disable-next-line no-await-in-loop -- the poll's pause
        await wait(options.timing.pollMs, signal);
      }
    } catch (error: unknown) {
      log.error('job log stream failed', { run, job, error });
    }
  });
}

function resumeAfter(request: Request, url: URL): number {
  const fromHeader = Number(request.headers.get('last-event-id'));
  if (Number.isInteger(fromHeader) && fromHeader > 0) return fromHeader;
  const fromQuery = Number(url.searchParams.get('after'));
  return Number.isInteger(fromQuery) && fromQuery > 0 ? fromQuery : 0;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function problem(status: number, message: string): Response {
  return Response.json({ error: { message } }, { status });
}

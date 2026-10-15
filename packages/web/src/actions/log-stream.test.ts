import { describe, expect, it } from 'vitest';

import type { RpcResult } from '@gitstalk/shared-race/rpc';

import { actionsClient } from './actions-client';
import type { ActionsViewRpc } from './actions-contract';
import {
  decodeOverlay,
  encodeOverlay,
  withRepoOverlay,
  EMPTY_REPO_OVERLAY,
} from './fake/fake-overlay';
import { asGatewayActions } from './gateway-actions';
import { jobLogResponse } from './log-stream';
import { testActions } from './testing/fake-actions';

const NOON = Date.UTC(2026, 9, 8, 12, 0, 0);
const TIMING = { pollMs: 0, followMs: 60_000 };

type SseEvent = { readonly event: string; readonly id: string | null; readonly data: unknown };

function parseSse(body: string): readonly SseEvent[] {
  return body
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const fields = new Map(
        block
          .split('\n')
          .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]),
      );
      return {
        event: fields.get('event') ?? '',
        id: fields.get('id') ?? null,
        data: JSON.parse(fields.get('data') ?? 'null'),
      };
    });
}

async function runningCiRun() {
  const actions = testActions(NOON);
  const page = await actions
    .client()
    .runs({ workflow: '.github/workflows/ci.yml', status: 'success', limit: 1 });
  if (!page.ok || page.value.runs[0] === undefined) throw new Error('no run');
  const run = page.value.runs[0];
  actions.setNow(Date.parse(run.createdAt) + 30_000);
  return { actions, run };
}

describe('the job log route', () => {
  it('streams a running job to its end: lines numbered as event ids, the job state, then end', async () => {
    const { actions, run } = await runningCiRun();
    // Each read moves the clock on, so the job finishes within a few polls and no test sleeps.
    const client = actions.client();
    const ticking = {
      ...client,
      log: (...args: Parameters<typeof client.log>) => {
        actions.advance(15_000);
        return client.log(...args);
      },
    };
    const request = new Request('https://web.test/log?after=0');
    const response = await jobLogResponse(
      request,
      ticking,
      { run: run.id, job: 'test', visibility: 'public' },
      TIMING,
    );
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const events = parseSse(await response.text());
    expect(events.at(-1)?.event).toBe('end');
    const lineEvents = events.filter((event) => event.event === 'lines');
    expect(lineEvents.length).toBeGreaterThan(1);
    const ids = lineEvents.map((event) => Number(event.id));
    expect(ids).toEqual([...ids].toSorted((a, b) => a - b));
    expect(events.some((event) => event.event === 'job')).toBe(true);
  });

  it('resumes after Last-Event-ID', async () => {
    const { actions, run } = await runningCiRun();
    actions.advance(10 * 60_000);
    const request = new Request('https://web.test/log', { headers: { 'last-event-id': '3' } });
    const response = await jobLogResponse(
      request,
      actions.client(),
      { run: run.id, job: 'lint', visibility: 'public' },
      TIMING,
    );
    const first = parseSse(await response.text()).find((event) => event.event === 'lines');
    expect(first?.data).toMatchObject({
      lines: expect.arrayContaining([expect.objectContaining({ n: 4 })]),
    });
    expect(JSON.stringify(first?.data)).not.toContain('"n":3,');
  });

  it('downloads the whole log as plain text, colours removed', async () => {
    const { actions, run } = await runningCiRun();
    actions.advance(10 * 60_000);
    const request = new Request('https://web.test/log?download=1');
    const response = await jobLogResponse(
      request,
      actions.client(),
      { run: run.id, job: 'test', visibility: 'public' },
      TIMING,
    );
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="CI-\d+-test\.log"$/,
    );
    const text = await response.text();
    expect(text).toContain('##[group]npm test');
    expect(text).not.toContain('\u001b[');
  });

  it('lets the browser keep a finished job’s download for good, never a running one’s', async () => {
    const { actions, run } = await runningCiRun();
    const download = () =>
      jobLogResponse(
        new Request('https://web.test/log?download=1'),
        actions.client(),
        { run: run.id, job: 'test', visibility: 'public' },
        TIMING,
      );
    expect((await download()).headers.get('cache-control')).toBe('no-store');
    actions.advance(10 * 60_000);
    expect((await download()).headers.get('cache-control')).toBe(
      'private, max-age=31536000, immutable',
    );
  });

  it.each(['private', 'internal'] as const)(
    'never lets the browser keep a %s repository’s download, even a finished one',
    async (visibility) => {
      const { actions, run } = await runningCiRun();
      actions.advance(10 * 60_000);
      const response = await jobLogResponse(
        new Request('https://web.test/log?download=1'),
        actions.client(),
        { run: run.id, job: 'test', visibility },
        TIMING,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
    },
  );

  it('never lets the browser keep a finished job’s log whose last lines are not stored yet', async () => {
    const { actions, run } = await runningCiRun();
    actions.advance(10 * 60_000);
    const client = actions.client();
    const partial = {
      ...client,
      log: async (...args: Parameters<typeof client.log>) => {
        const page = await client.log(...args);
        return page.ok ? { ...page, value: { ...page.value, complete: false } } : page;
      },
    };
    const response = await jobLogResponse(
      new Request('https://web.test/log?download=1'),
      partial,
      { run: run.id, job: 'test', visibility: 'public' },
      TIMING,
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('never lets the browser keep the live stream', async () => {
    const { actions, run } = await runningCiRun();
    const controller = new AbortController();
    const response = await jobLogResponse(
      new Request('https://web.test/log', { signal: controller.signal }),
      actions.client(),
      { run: run.id, job: 'test', visibility: 'public' },
      TIMING,
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    controller.abort();
    await response.body?.cancel();
  });

  it('answers 404 for a job the run does not have', async () => {
    const { actions, run } = await runningCiRun();
    const request = new Request('https://web.test/log?download=1');
    const response = await jobLogResponse(
      request,
      actions.client(),
      { run: run.id, job: 'nope', visibility: 'public' },
      TIMING,
    );
    expect(response.status).toBe(404);
  });
});

describe('the client', () => {
  it('treats a binding without every method as no control plane', () => {
    expect(asGatewayActions({ listWorkflows: () => null })).toBeNull();
    expect(asGatewayActions(undefined)).toBeNull();
  });

  it('turns an answer in an unknown shape into an error, not a page', async () => {
    const answer = async (): Promise<RpcResult<unknown>> => ({
      ok: true,
      value: { surprise: true },
    });
    const rpc: ActionsViewRpc = {
      listWorkflows: answer,
      dispatchWorkflow: answer,
      listRuns: answer,
      getRun: answer,
      cancelRun: answer,
      logChunks: answer,
      listSecrets: answer,
      putSecret: answer,
      deleteSecret: answer,
    };
    const result = await actionsClient(rpc, { actor: null, repoId: 'r', mode: 'live' }).run('x');
    expect(result).toMatchObject({ ok: false, error: { code: 'upstream_failed' } });
  });
});

describe('the fake overlay cookie', () => {
  it('round-trips and reads garbage as empty', () => {
    const overlay = withRepoOverlay({}, 'r1', EMPTY_REPO_OVERLAY);
    expect(decodeOverlay(encodeOverlay(overlay))).toEqual(overlay);
    expect(decodeOverlay('%7Bnot json')).toEqual({});
    expect(decodeOverlay(encodeURIComponent('{"r1":{"dispatched":7}}'))).toEqual({});
  });

  it('keeps the newest dispatches and at most three repositories', () => {
    const dispatched = Array.from({ length: 12 }, (_, index) => ({
      id: `ci-${index}-d`,
      workflow: 'ci',
      atMs: index,
      by: 'coop',
      inputs: {},
    }));
    const one = withRepoOverlay({}, 'r1', { ...EMPTY_REPO_OVERLAY, dispatched });
    expect(one['r1']?.dispatched.map((run) => run.id).at(0)).toBe('ci-4-d');
    const four = ['r2', 'r3', 'r4'].reduce(
      (overlay, id) => withRepoOverlay(overlay, id, EMPTY_REPO_OVERLAY),
      one,
    );
    expect(Object.keys(four)).toEqual(['r2', 'r3', 'r4']);
  });
});

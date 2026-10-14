/**
 * The bean diff route on Miniflare, with the real Cache API and KV behind the edge object
 * cache: what each viewer is answered, which headers say how long the browser may keep it, and
 * that a private repository's diff is never stored or served from the shared caches.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Sha as ShaType } from '@gitstalk/shared-race/ids';
import { RunId, Sha, TaskId } from '@gitstalk/shared-race/ids';

import type { BeanStatus, ForgeSource } from '@gitstalk/shared-ask/forge/forge-source';
import type { RepoDiff } from '@gitstalk/shared-ask/repo/repo-types';
import type { EdgeObject } from '../edge/cache-keys';
import { EDGE_CACHE_NAME, coloKey, kvKey } from '../edge/cache-keys';
import { createEdgeObjectCache } from '../edge/object-cache';
import { PublicEngine } from '../repo-pages/event-cache';
import type { RunAccess } from './bean-diff-answer';
import { answerBeanDiff } from './bean-diff-answer';

const ORIGIN = 'https://gitstalk.test';
const BASE = Sha.parse('1'.repeat(40));
const HEAD = Sha.parse('2'.repeat(40));
const BEAN = TaskId.parse('fix-login');
const DIFF: RepoDiff = {
  from: BASE,
  to: HEAD,
  files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0, hunks: [] }],
};
const POISON: RepoDiff = {
  ...DIFF,
  files: [{ path: 'stolen.ts', status: 'added', additions: 9, deletions: 0, hunks: [] }],
};

const PUBLIC: RunAccess = { kind: 'repository', visibility: 'public' };
const PRIVATE: RunAccess = { kind: 'repository', visibility: 'private' };
const INTERNAL: RunAccess = { kind: 'repository', visibility: 'internal' };

let runs = 0;
const freshRun = () => RunId.parse(`beandiff${(runs += 1)}`);
const DIFF_OBJECT: EdgeObject = { kind: 'diff', base: BASE, head: HEAD };

/** A gateway that knows one bean at one pair, counting the diffs it produces. */
function fakeSource(status: BeanStatus = 'landed') {
  const calls = { detail: 0, diff: 0 };
  const source: Pick<ForgeSource, 'beanDetail' | 'repoDiff'> = {
    beanDetail: (_run, bean) => {
      calls.detail += 1;
      return Promise.resolve(bean === BEAN ? beanDetail(status, BASE, HEAD) : undefined);
    },
    repoDiff: () => {
      calls.diff += 1;
      return Promise.resolve(DIFF);
    },
  };
  return { source, calls };
}

function harness() {
  const pending: Promise<unknown>[] = [];
  const objects = createEdgeObjectCache({
    origin: () => ORIGIN,
    colo: () => caches.open(EDGE_CACHE_NAME),
    kv: () => env.OBJECTS,
    waitUntil: (promise) => {
      pending.push(promise);
    },
    isolateBytes: 1024 * 1024,
  });
  return { objects, settle: () => Promise.all(pending.splice(0)) };
}

const request = (ifNoneMatch?: string) =>
  new Request(`${ORIGIN}/api/runs/x/beans/${BEAN}/diff`, {
    headers: ifNoneMatch === undefined ? {} : { 'if-none-match': ifNoneMatch },
  });

/** The keys a public engine of this id would have: what a leak would be stored under. */
async function keysOf(run: RunId) {
  const asPublic = PublicEngine.of({ visibility: 'public' }, run);
  if (asPublic === null) throw new Error('a public record names a public engine');
  return { colo: coloKey(ORIGIN, asPublic, DIFF_OBJECT), kv: await kvKey(asPublic, DIFF_OBJECT) };
}

describe('a public repository’s bean diff', () => {
  it('is read once through the edge cache, then served from it with Server-Timing', async () => {
    const run = freshRun();
    const { objects, settle } = harness();
    const { source, calls } = fakeSource();
    const first = await answerBeanDiff(
      { request: request(), run, bean: BEAN, access: PUBLIC },
      { source, objects },
    );
    expect(first.status).toBe(200);
    expect(first.headers.get('server-timing')).toMatch(/^edge;desc="gateway-read";dur=/);
    expect(await first.json()).toEqual(DIFF);
    await settle();
    const second = await answerBeanDiff(
      { request: request(), run, bean: BEAN, access: PUBLIC },
      { source, objects },
    );
    expect(second.headers.get('server-timing')).toMatch(/^edge;desc="isolate-hit";dur=/);
    expect(await second.json()).toEqual(DIFF);
    expect(calls.diff).toBe(1);
    const { kv } = await keysOf(run);
    expect(await env.OBJECTS.get(kv)).not.toBeNull();
  });

  it('is a 404, uncached and without the stored diff, once the viewer may no longer read it', async () => {
    const run = freshRun();
    const { objects, settle } = harness();
    const { source, calls } = fakeSource();
    await answerBeanDiff(
      { request: request(), run, bean: BEAN, access: PUBLIC },
      { source, objects },
    );
    await settle();
    // The repository turned private (or was deleted): the access check refuses this viewer.
    const response = await answerBeanDiff(
      { request: request(pairTag()), run, bean: BEAN, access: { kind: 'refused' } },
      { source, objects },
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('etag')).toBeNull();
    expect(await response.text()).not.toContain('a.ts');
    expect(calls).toEqual({ detail: 1, diff: 1 });
  });
});

describe('a private repository’s bean diff', () => {
  it.each([
    ['private', PRIVATE],
    ['internal', INTERNAL],
  ])('is never stored in the colo or KV (%s)', async (_name, access) => {
    const run = freshRun();
    const { objects, settle } = harness();
    const { source, calls } = fakeSource();
    const read = async () => {
      const response = await answerBeanDiff(
        { request: request(), run, bean: BEAN, access },
        { source, objects },
      );
      expect(await response.json()).toEqual(DIFF);
      expect(response.headers.get('server-timing')).toBeNull();
    };
    // Two requests, one after the other: the second would hit a cache the first had filled.
    await read();
    await settle();
    await read();
    await settle();
    expect(calls.diff).toBe(2);
    const keys = await keysOf(run);
    expect(await (await caches.open(EDGE_CACHE_NAME)).match(keys.colo)).toBeUndefined();
    expect(await env.OBJECTS.get(keys.kv)).toBeNull();
    expect(objects.stats()).toEqual({ hits: { isolate: 0, colo: 0, kv: 0 }, misses: 0, writes: 0 });
  });

  it('is never served from a poisoned entry under its engine’s key', async () => {
    const run = freshRun();
    const keys = await keysOf(run);
    const poisoned = JSON.stringify(POISON);
    await (
      await caches.open(EDGE_CACHE_NAME)
    ).put(
      keys.colo,
      new Response(poisoned, { headers: { 'cache-control': 'public, max-age=600' } }),
    );
    await env.OBJECTS.put(keys.kv, poisoned);
    const { objects } = harness();
    const { source, calls } = fakeSource();
    const response = await answerBeanDiff(
      { request: request(), run, bean: BEAN, access: PRIVATE },
      { source, objects },
    );
    const body = await response.text();
    expect(body).not.toContain('stolen.ts');
    expect(JSON.parse(body)).toEqual(DIFF);
    expect(calls.diff).toBe(1);
  });
});

describe('the browser headers', () => {
  it('make a validated bean’s diff immutable, named by its commit pair', async () => {
    const response = await answer('green', PUBLIC);
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(response.headers.get('etag')).toBe(pairTag());
  });

  it.each(['landed', 'in-flight'] as const)(
    'let a %s bean’s diff be kept 30 s only',
    async (status) => {
      const response = await answer(status, PRIVATE);
      expect(response.headers.get('cache-control')).toBe('private, max-age=30');
      expect(response.headers.get('etag')).toBe(pairTag());
    },
  );

  it('never let a benchmark race’s diff be kept', async () => {
    const response = await answer('green', { kind: 'race' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('etag')).toBeNull();
  });

  it('answer 304 to a reader holding the same pair, and 404 to anyone refused', async () => {
    const run = freshRun();
    const { objects } = harness();
    const { source } = fakeSource('green');
    const held = await answerBeanDiff(
      { request: request(pairTag()), run, bean: BEAN, access: PUBLIC },
      { source, objects },
    );
    expect(held.status).toBe(304);
    const refused = await answerBeanDiff(
      { request: request(pairTag()), run, bean: BEAN, access: { kind: 'refused' } },
      { source, objects },
    );
    expect(refused.status).toBe(404);
  });

  it('answer 404, uncached, for a bean without a change yet', async () => {
    const { objects } = harness();
    const source: Pick<ForgeSource, 'beanDetail' | 'repoDiff'> = {
      beanDetail: () => Promise.resolve(beanDetail('pending', null, null)),
      repoDiff: () => Promise.reject(new Error('not asked')),
    };
    const response = await answerBeanDiff(
      { request: request(), run: freshRun(), bean: BEAN, access: PUBLIC },
      { source, objects },
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

async function answer(status: BeanStatus, access: RunAccess): Promise<Response> {
  const { objects } = harness();
  const { source } = fakeSource(status);
  return answerBeanDiff(
    { request: request(), run: freshRun(), bean: BEAN, access },
    { source, objects },
  );
}

function pairTag(): string {
  return `"${BASE}..${HEAD}"`;
}

function beanDetail(status: BeanStatus, base: ShaType | null, head: ShaType | null) {
  return {
    id: BEAN,
    title: 'Fix login',
    intent: 'fix the login',
    status,
    phase: 'pending' as const,
    agent: null,
    files: ['a.ts'],
    startedAt: null,
    landedAt: null,
    landedIdx: null,
    greenAt: null,
    reworks: 0,
    card: null,
    costUsd: 0,
    tests: [],
    steps: [],
    head,
    diffBase: base,
    diffHead: head,
    checks: 0,
    redChecks: 0,
    conflicts: 0,
    lastMessage: '',
    dropReason: null,
  };
}

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { CacheRead } from '../repo/cache-stats';

import {
  INFRA_PRICES,
  countAlarm,
  countArtifactsOps,
  countRequest,
  emptyMeter,
  infraReport,
  recordCacheRead,
  recordRunnerCall,
  recordWarmStart,
} from './infra-meter';
import type { InfraMeter } from './infra-meter';
import { loadMeter, saveMeter } from './run-store';

function withReads(meter: InfraMeter, reads: readonly CacheRead[]): InfraMeter {
  return reads.reduce(recordCacheRead, meter);
}

const HIT = (kind: CacheRead['kind']): CacheRead => ({ kind, outcome: 'hit' });
const MISS = (kind: CacheRead['kind']): CacheRead => ({ kind, outcome: 'miss' });

describe('the infra meter', () => {
  it('counts an instance’s up time once when calls overlap its sleepAfter tail', () => {
    const first = recordRunnerCall(emptyMeter(0), { instance: 'ci-0', startMs: 0, endMs: 10_000 });
    const overlapping = recordRunnerCall(first, {
      instance: 'ci-0',
      startMs: 60_000,
      endMs: 70_000,
    });
    const otherInstance = recordRunnerCall(overlapping, {
      instance: 'ci-1',
      startMs: 60_000,
      endMs: 70_000,
    });

    expect(first.containerUpSeconds).toBe(130);
    expect(overlapping.containerUpSeconds).toBe(190);
    expect(otherInstance.containerUpSeconds).toBe(320);
    expect(otherInstance.containerBusySeconds).toBe(30);
    expect(otherInstance.artifactsOps).toBe(3);
  });

  it('counts a pre-warmed instance’s up time without a call, once with the call it serves', () => {
    const warmed = recordWarmStart(emptyMeter(0), { instance: 'ci-0', startMs: 0, endMs: 5000 });
    const called = recordRunnerCall(warmed, { instance: 'ci-0', startMs: 30_000, endMs: 40_000 });

    expect(warmed).toMatchObject({ runnerCalls: 0, artifactsOps: 0, containerBusySeconds: 0 });
    expect(warmed.containerUpSeconds).toBe(125);
    expect(called.containerUpSeconds).toBe(160);
    expect(called.runnerCalls).toBe(1);
  });

  it('prices each product at its list rate', () => {
    let meter = countArtifactsOps(emptyMeter(0), 1000);
    meter = countRequest(countRequest(meter, 500), 1000);
    meter = countAlarm(meter, 1000);

    const report = infraReport(meter, 0);

    expect(report).toMatchObject({ worker_requests: 2, do_requests: 3, artifacts_ops: 1000 });
    expect(report.usd.artifacts).toBeCloseTo(0.15, 6);
    expect(report.usd.workers).toBeCloseTo(2 * INFRA_PRICES.workerRequestUsd, 9);
    expect(report.usd.total).toBeCloseTo(
      report.usd.workers + report.usd.durable_objects + report.usd.artifacts,
      6,
    );
  });
});

describe('the read index’s counts on the meter', () => {
  it('reports each kind’s hit rate, objects together and the ref memo apart', () => {
    const meter = withReads(emptyMeter(0), [
      MISS('tree'),
      HIT('tree'),
      HIT('tree'),
      HIT('tree'),
      MISS('blob'),
      HIT('commit'),
      MISS('ref'),
      HIT('ref'),
      HIT('ref'),
    ]);

    const { cache } = infraReport(meter, 0);

    expect(cache.tree).toEqual({ hits: 3, misses: 1, hit_rate: 0.75 });
    expect(cache.blob).toEqual({ hits: 0, misses: 1, hit_rate: 0 });
    expect(cache.commit).toEqual({ hits: 1, misses: 0, hit_rate: 1 });
    expect(cache.objects).toEqual({ hits: 4, misses: 2, hit_rate: 0.6667 });
    expect(cache.ref_memo).toEqual({ hits: 2, misses: 1, hit_rate: 0.6667 });
  });

  it('keeps the warm-up’s prefetch out of the demand hit rates', () => {
    const meter = withReads(emptyMeter(0), [
      { kind: 'blob', outcome: 'miss', purpose: 'prefetch' },
      { kind: 'tree', outcome: 'hit', purpose: 'prefetch' },
      { kind: 'blob', outcome: 'hit', purpose: 'demand' },
    ]);

    const { cache } = infraReport(meter, 0);

    expect(cache.blob).toEqual({ hits: 1, misses: 0, hit_rate: 1 });
    expect(cache.tree.hit_rate).toBeNull();
    expect(cache.prefetch?.blob).toEqual({ hits: 0, misses: 1, hit_rate: 0 });
    expect(cache.prefetch?.objects).toEqual({ hits: 1, misses: 1, hit_rate: 0.5 });
  });

  it('reports no rate before anything was read', () => {
    expect(infraReport(emptyMeter(0), 0).cache.objects).toEqual({
      hits: 0,
      misses: 0,
      hit_rate: null,
    });
  });

  it('keeps the counts across a flush to storage and a reload', async () => {
    const meter = withReads(emptyMeter(0), [MISS('blob'), HIT('blob'), HIT('ref')]);

    const reloaded = await runInDurableObject(
      env.RUNS.getByName('meter-flush-test'),
      (_, state) => {
        saveMeter(state.storage, meter);
        return loadMeter(state.storage, 1000);
      },
    );

    expect(reloaded?.cache).toEqual(meter.cache);
  });

  it('starts the counts at zero for a meter stored before they existed', async () => {
    const { cache: _cache, ...older } = emptyMeter(0);

    const reloaded = await runInDurableObject(
      env.RUNS.getByName('meter-older-test'),
      (_, state) => {
        state.storage.kv.put('infra-meter', { ...older, requests: 7 });
        return loadMeter(state.storage, 1000);
      },
    );

    expect(reloaded?.requests).toBe(7);
    expect(infraReport(reloaded ?? emptyMeter(0), 0).cache.objects.hit_rate).toBeNull();
  });

  it('starts the prefetch counts at zero for counts stored before purposes existed', async () => {
    const { prefetch: _prefetch, ...demand } = withReads(emptyMeter(0), [HIT('tree')]).cache;

    const reloaded = await runInDurableObject(
      env.RUNS.getByName('meter-purposes-test'),
      (_, state) => {
        state.storage.kv.put('infra-meter', { ...emptyMeter(0), cache: demand });
        return loadMeter(state.storage, 1000);
      },
    );

    const report = infraReport(reloaded ?? emptyMeter(0), 0).cache;
    expect(report.tree.hits).toBe(1);
    expect(report.prefetch?.objects.hit_rate).toBeNull();
  });
});

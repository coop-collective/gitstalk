import { describe, expect, it } from 'vitest';

import { RunId, Sha } from '@gitstalk/shared-race/ids';

import { PublicEngine } from '../repo-pages/event-cache';
import { EDGE_CACHE_NAME, coloKey, isEdgePath, kvKey } from './cache-keys';

const ORIGIN = 'https://gitstalk.test';
const SHA = Sha.parse('a'.repeat(40));
const OTHER = Sha.parse('b'.repeat(40));

function publicEngine(id: string): PublicEngine {
  const engine = PublicEngine.of({ visibility: 'public' }, RunId.parse(id));
  if (engine === null) throw new Error('a public record names a public engine');
  return engine;
}

const engine = publicEngine('engine01');

describe('Cache API keys', () => {
  it('live under the reserved, versioned path on this deployment’s origin', () => {
    expect(coloKey(ORIGIN, engine, { kind: 'tree', sha: SHA })).toBe(
      `${ORIGIN}/__edge/v1/engine01/tree/${SHA}`,
    );
    expect(coloKey(ORIGIN, engine, { kind: 'diff', base: SHA, head: OTHER })).toBe(
      `${ORIGIN}/__edge/v1/engine01/diff/${SHA}..${OTHER}`,
    );
    expect(EDGE_CACHE_NAME).toBe('gitstalk-objects-v1');
  });

  it('encode a file path as one segment, so no path can climb out of its key', () => {
    const key = coloKey(ORIGIN, engine, { kind: 'file', sha: SHA, path: '../../x y/ü?.ts#1' });
    expect(key).toBe(`${ORIGIN}/__edge/v1/engine01/file/${SHA}/..%2F..%2Fx%20y%2F%C3%BC%3F.ts%231`);
    expect(new URL(key).pathname.startsWith('/__edge/v1/engine01/file/')).toBe(true);
  });

  it('differ by engine, kind, sha and path', () => {
    const keys = new Set([
      coloKey(ORIGIN, engine, { kind: 'tree', sha: SHA }),
      coloKey(ORIGIN, engine, { kind: 'tree', sha: OTHER }),
      coloKey(ORIGIN, publicEngine('engine02'), { kind: 'tree', sha: SHA }),
      coloKey(ORIGIN, engine, { kind: 'file', sha: SHA, path: 'a' }),
      coloKey(ORIGIN, engine, { kind: 'file', sha: SHA, path: 'b' }),
      coloKey(ORIGIN, engine, { kind: 'diff', base: SHA, head: OTHER }),
      coloKey(ORIGIN, engine, { kind: 'diff', base: OTHER, head: SHA }),
    ]);
    expect(keys.size).toBe(7);
  });
});

describe('KV keys', () => {
  it('name the version, the engine and the commit', async () => {
    expect(await kvKey(engine, { kind: 'tree', sha: SHA })).toBe(`v1:engine01:tree:${SHA}`);
    expect(await kvKey(engine, { kind: 'diff', base: SHA, head: OTHER })).toBe(
      `v1:engine01:diff:${SHA}:${OTHER}`,
    );
  });

  it('hash a file path, so even a very long path stays within KV’s 512 bytes', async () => {
    const path = `${'deep/'.repeat(200)}file.ts`;
    const key = await kvKey(engine, { kind: 'file', sha: SHA, path });
    expect(key).toMatch(new RegExp(`^v1:engine01:file:${SHA}:[0-9a-f]{64}$`));
    expect(new TextEncoder().encode(key).byteLength).toBeLessThanOrEqual(512);
    expect(await kvKey(engine, { kind: 'file', sha: SHA, path: 'a.ts' })).not.toBe(key);
  });
});

describe('the reserved path', () => {
  it.each(['/__edge', '/__edge/', '/__edge/v1/engine01/tree/x'])('includes %s', (path) => {
    expect(isEdgePath(path)).toBe(true);
  });

  it.each(['/', '/__edgy', '/coop/__edge/x', '/api/repos/a/b/events'])('excludes %s', (path) => {
    expect(isEdgePath(path)).toBe(false);
  });
});

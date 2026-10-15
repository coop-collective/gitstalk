import { describe, expect, it } from 'vitest';

import { RunId, Sha } from '@gitstalk/shared-race/ids';

import { PublicEngine } from '../repo-pages/event-cache';
import { EDGE_CACHE_NAME, coloKey, isEdgePath, kvKey } from './cache-keys';

const ORIGIN = 'https://gitstalk.test';
const SHA = Sha.parse('a'.repeat(40));
const OTHER = Sha.parse('b'.repeat(40));

const EPOCH_AT = '2026-10-14T12:00:00.000Z';
const EPOCH = '20261014T120000000Z';

function publicEngine(id: string, updatedAt = EPOCH_AT): PublicEngine {
  const engine = PublicEngine.of({ visibility: 'public', updated_at: updatedAt }, RunId.parse(id));
  if (engine === null) throw new Error('a public record names a public engine');
  return engine;
}

const engine = publicEngine('engine01');

describe('Cache API keys', () => {
  it('live under the reserved, versioned path on this deployment’s origin, with the epoch', async () => {
    expect(await coloKey(ORIGIN, engine, { kind: 'tree', sha: SHA })).toBe(
      `${ORIGIN}/__edge/v1/engine01/${EPOCH}/tree/${SHA}`,
    );
    expect(await coloKey(ORIGIN, engine, { kind: 'diff', base: SHA, head: OTHER })).toBe(
      `${ORIGIN}/__edge/v1/engine01/${EPOCH}/diff/${SHA}..${OTHER}`,
    );
    expect(EDGE_CACHE_NAME).toBe('gitstalk-objects-v1');
  });

  it('hash a file path into one segment, so no path can climb out of its key', async () => {
    const key = await coloKey(ORIGIN, engine, {
      kind: 'file',
      sha: SHA,
      path: '../../x y/ü?.ts#1',
    });
    expect(key).toMatch(
      new RegExp(`^${ORIGIN}/__edge/v1/engine01/${EPOCH}/file/${SHA}/[0-9a-f]{64}$`),
    );
  });

  it('keep the dot segments and the empty path apart (a URL would fold them together)', async () => {
    const keys = await Promise.all(
      ['..', '.', '', 'a/..', '%2E%2E'].map((path) =>
        coloKey(ORIGIN, engine, { kind: 'file', sha: SHA, path }),
      ),
    );
    expect(new Set(keys).size).toBe(keys.length);
    const elsewhere = await coloKey(ORIGIN, engine, { kind: 'file', sha: OTHER, path: '..' });
    expect(keys).not.toContain(elsewhere);
  });

  it('differ by engine, epoch, kind, sha and path', async () => {
    const keys = new Set(
      await Promise.all([
        coloKey(ORIGIN, engine, { kind: 'tree', sha: SHA }),
        coloKey(ORIGIN, engine, { kind: 'tree', sha: OTHER }),
        coloKey(ORIGIN, publicEngine('engine02'), { kind: 'tree', sha: SHA }),
        coloKey(ORIGIN, publicEngine('engine01', '2026-10-15T00:00:00.000Z'), {
          kind: 'tree',
          sha: SHA,
        }),
        coloKey(ORIGIN, engine, { kind: 'file', sha: SHA, path: 'a' }),
        coloKey(ORIGIN, engine, { kind: 'file', sha: SHA, path: 'b' }),
        coloKey(ORIGIN, engine, { kind: 'diff', base: SHA, head: OTHER }),
        coloKey(ORIGIN, engine, { kind: 'diff', base: OTHER, head: SHA }),
      ]),
    );
    expect(keys.size).toBe(8);
  });
});

describe('KV keys', () => {
  it('name the version, the engine, the epoch and the commit', async () => {
    expect(await kvKey(engine, { kind: 'tree', sha: SHA })).toBe(
      `v1:engine01:${EPOCH}:tree:${SHA}`,
    );
    expect(await kvKey(engine, { kind: 'diff', base: SHA, head: OTHER })).toBe(
      `v1:engine01:${EPOCH}:diff:${SHA}:${OTHER}`,
    );
  });

  it('move to new keys when the record changes (the purge path)', async () => {
    const later = publicEngine('engine01', '2026-10-15T00:00:00.000Z');
    expect(await kvKey(later, { kind: 'tree', sha: SHA })).not.toBe(
      await kvKey(engine, { kind: 'tree', sha: SHA }),
    );
  });

  it('hash a file path, so even a very long path stays within KV’s 512 bytes', async () => {
    const path = `${'deep/'.repeat(200)}file.ts`;
    const key = await kvKey(engine, { kind: 'file', sha: SHA, path });
    expect(key).toMatch(new RegExp(`^v1:engine01:${EPOCH}:file:${SHA}:[0-9a-f]{64}$`));
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

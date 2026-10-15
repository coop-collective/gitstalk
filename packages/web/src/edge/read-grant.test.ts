/**
 * The access-proof rule in source form: a `ReadGrant` (what opens every edge cache read) is
 * made only by the access checks, so no code path can read a cache entry without passing
 * access on this request. Tests may make grants.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { RunId } from '@gitstalk/shared-race/ids';

import { PublicEngine } from '../repo-pages/event-cache';
import { PrivateEngine, ReadGrant } from './read-grant';

const ROOT = path.resolve(import.meta.dirname, '../..');
/** The access checks: the repository lookup (pages, Changes routes) and the run routes' gate. */
const ACCESS_CHECKS = ['src/admin/admin-gate.ts', 'src/repositories/flows.ts'];

function sourcesUnder(dir: string): readonly string[] {
  return readdirSync(path.join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => path.join(dir, file).replaceAll(path.sep, '/'));
}

describe('who makes a read grant', () => {
  const makers = ['src', 'app', 'components', 'worker']
    .flatMap(sourcesUnder)
    .filter((file) =>
      readFileSync(path.join(ROOT, file), 'utf8').includes('ReadGrant.afterAccessCheck('),
    );

  it('only the access checks, never a page, a route or a cache', () => {
    expect(makers.toSorted()).toEqual(ACCESS_CHECKS);
  });
});

describe('what a grant opens', () => {
  const engine = RunId.parse('grantengine');
  const at = '2026-10-14T12:00:00.000Z';

  it('a public engine for a public repository, a private one otherwise', () => {
    const open = ReadGrant.afterAccessCheck({ visibility: 'public', updated_at: at });
    expect(PublicEngine.of(open, engine)?.engine).toBe(engine);
    expect(PrivateEngine.of(open, engine)).toBeNull();
    for (const visibility of ['private', 'internal'] as const) {
      const closed = ReadGrant.afterAccessCheck({ visibility, updated_at: at });
      expect(PublicEngine.of(closed, engine)).toBeNull();
      expect(PrivateEngine.of(closed, engine)?.epoch).toBe('20261014T120000000Z');
    }
  });
});

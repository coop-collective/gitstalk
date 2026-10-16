import { describe, expect, it } from 'vitest';

import type { FileChange } from '../../git/diff-text';
import { beanLinks } from '../bean-links';
import { javascript } from './javascript';

function change(path: string, before: string | null, after: string | null): FileChange {
  return { path, before, after, beforeId: null, afterId: null };
}

describe('javascript imports', () => {
  it("resolves a TypeScript file's import to the module's declaration file", () => {
    const candidates = new Set(['fastify.js', 'fastify.d.ts']);
    expect(
      javascript.importedFiles('types/instance.d.ts', "import '../fastify'", candidates),
    ).toEqual(['fastify.d.ts']);
    expect(
      javascript.importedFiles('test/a.ts', "import x from '../fastify.js'", candidates),
    ).toEqual(['fastify.d.ts']);
  });

  it('resolves a JavaScript import to the module itself', () => {
    const candidates = new Set(['fastify.js', 'fastify.d.ts']);
    expect(javascript.importedFiles('lib/a.js', "require('../fastify')", candidates)).toEqual([
      'fastify.js',
    ]);
  });
});

describe('javascript declarations', () => {
  it('reads top-level bindings, functions and classes, never a local binding', () => {
    expect(javascript.declaredName('export const SHIPPING_CENTS = 500;')).toBe('SHIPPING_CENTS');
    expect(javascript.declaredName('const price = () => 100;')).toBe('price');
    expect(javascript.declaredName('  function closeSessions () {')).toBe('closeSessions');
    expect(javascript.declaredName('    const res = await fetch(url)')).toBeNull();
    expect(javascript.declaredName('  let session = server.sessions.get(id)')).toBeNull();
  });

  it('links two beans by a function, not by a local both happen to name', () => {
    const theirs = change(
      'lib/server.js',
      'function close () {\n  const session = 1\n  return session\n}\n',
      'function close () {\n  const session = 2\n  return session\n}\n',
    );
    const mine = change('lib/route.js', 'x()\n', 'const session = close()\n');
    expect(beanLinks([mine], [theirs]).theyChangedThisUses).toEqual(['close']);
  });
});

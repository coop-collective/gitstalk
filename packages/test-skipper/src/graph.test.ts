import { describe, expect, it } from 'vitest';
import { closure, dependencyGraph } from './graph';

describe('the Node module adapter', () => {
  it('follows imports, re-exports and cycles, including TypeScript', () => {
    const graph = dependencyGraph({
      'src/a.test.ts': "import assert from 'node:assert/strict'; import { a } from './a.ts';",
      'src/a.ts': "export { value as a } from './b.ts';",
      'src/b.ts': "import './a.ts'; export const value: number = 1;",
      'src/unrelated.ts': 'export const value = 2;',
    });
    expect(graph.reason).toBeNull();
    expect(closure('src/a.test.ts', graph)).toEqual(['src/a.test.ts', 'src/a.ts', 'src/b.ts']);
  });

  it.each([
    "await import('./missing.ts')",
    "import data from 'external-package'",
    "import { readFileSync } from 'node:fs'",
    "import data from './missing.ts'",
    "export { value } from './missing.ts'",
    "require('./a.ts')",
    "const value = process.env['VALUE']",
    "globalThis.fetch('https://example.com')",
    'const value = Math.random()',
    'const now = Date.now()',
    "import './%61.ts'",
    "import './a.ts?version=2'",
    "import './a.ts#copy'",
    'const f = Object.getOwnPropertyDescriptor({}, "constructor");',
    'const callback = () => 1; callback();',
    'const constructor = (() => {}).constructor',
    'const broken: = 3;',
  ])('falls back for unsupported input: %s', (source) => {
    expect(dependencyGraph({ 'src/a.ts': source }).reason).not.toBeNull();
  });

  it('does not mistake comments or string contents for imports', () => {
    const graph = dependencyGraph({
      'src/a.ts': "// import './missing.ts';\nexport const value = `require('fs')`;",
    });
    expect(graph.reason).toBeNull();
    expect(graph.dependencies['src/a.ts']).toEqual([]);
  });
});

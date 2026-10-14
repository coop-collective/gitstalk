import { describe, expect, it } from 'vitest';

import { highlight, languageOf } from './highlight';
import { isSafeHref, parseInline, parseMarkdown } from './markdown';
import { codeHref, crumbs, listing, readRef, readmeHref, readmeOf, refParam } from './tree';

const FILES = [
  { path: '.gitstalk/checks.yml', size: 120 },
  { path: 'README.md', size: 900 },
  { path: 'package.json', size: 210 },
  { path: 'src/text.ts', size: 340 },
  { path: 'src/util/slug.ts', size: 160 },
  { path: 'test/text.test.ts', size: 410 },
];

describe('a folder of the stalk', () => {
  it('lists folders first, then files, by name', () => {
    expect(listing(FILES, '')?.map((entry) => `${entry.kind} ${entry.name}`)).toEqual([
      'dir .gitstalk',
      'dir src',
      'dir test',
      'file package.json',
      'file README.md',
    ]);
    expect(listing(FILES, 'src')?.map((entry) => entry.path)).toEqual(['src/util', 'src/text.ts']);
  });

  it('answers null for a folder the tree does not have, and empty for an empty root', () => {
    expect(listing(FILES, 'nope')).toBeNull();
    expect(listing([], '')).toEqual([]);
  });

  it('finds the README and the breadcrumb', () => {
    expect(readmeOf(listing(FILES, '') ?? [])?.path).toBe('README.md');
    expect(readmeOf(listing(FILES, 'src') ?? [])).toBeNull();
    expect(crumbs('src/util/slug.ts').map((crumb) => crumb.path)).toEqual([
      'src',
      'src/util',
      'src/util/slug.ts',
    ]);
  });
});

describe('refs and addresses', () => {
  it('reads ?ref= as the stalk, the sprout, a bean or a commit', () => {
    expect(readRef(undefined)).toEqual({ kind: 'stalk' });
    expect(readRef('sprout')).toEqual({ kind: 'sprout' });
    expect(readRef('bean/add-truncate')).toEqual({ kind: 'bean', name: 'add-truncate' });
    expect(readRef('a'.repeat(40))).toEqual({ kind: 'commit', sha: 'a'.repeat(40) });
    expect(readRef('bean/../../etc')).toEqual({ kind: 'stalk' });
    expect(refParam({ kind: 'stalk' })).toBeNull();
  });

  it('writes folder and file URLs, the stalk without a ref', () => {
    expect(codeHref('/coop/greeter', 'tree', '', { kind: 'stalk' })).toBe('/coop/greeter');
    expect(codeHref('/coop/greeter', 'blob', 'src/a b.ts', { kind: 'bean', name: 'x' })).toBe(
      '/coop/greeter/blob/src/a%20b.ts?ref=bean%2Fx',
    );
  });

  it('resolves a README’s relative links into the same ref, and keeps absolute ones', () => {
    const at = { base: '/coop/greeter', ref: { kind: 'sprout' as const }, path: 'docs' };
    expect(readmeHref(at, '../src/text.ts')).toBe('/coop/greeter/blob/src/text.ts?ref=sprout');
    expect(readmeHref(at, 'guide/')).toBe('/coop/greeter/tree/docs/guide?ref=sprout');
    expect(readmeHref(at, 'https://example.com/x')).toBe('https://example.com/x');
    expect(readmeHref(at, '#usage')).toBe('#usage');
  });
});

describe('syntax highlighting', () => {
  it('colours keywords, strings, comments, numbers and types in TypeScript, line by line', () => {
    const lines = highlight("// hi\nexport const n: Count = 42;\nconst s = 'a';\n", 'ts');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual([{ kind: 'comment', text: '// hi' }]);
    const kinds = (lines[1] ?? []).filter((token) => token.kind !== 'plain');
    expect(kinds).toEqual([
      { kind: 'keyword', text: 'export' },
      { kind: 'keyword', text: 'const' },
      { kind: 'type', text: 'Count' },
      { kind: 'number', text: '42' },
    ]);
    expect(lines[2]?.some((token) => token.kind === 'string' && token.text === "'a'")).toBe(true);
  });

  it('keeps the text exactly, across a block comment that spans lines', () => {
    const text = 'a /* one\ntwo */ b\n`x\ny`';
    const lines = highlight(text, 'ts');
    expect(lines.map((line) => line.map((token) => token.text).join('')).join('\n')).toBe(text);
    expect(lines[1]?.[0]).toEqual({ kind: 'comment', text: 'two */' });
  });

  it('reads a regular expression as one token, quotes inside it included', () => {
    const [line] = highlight("const re = /[\\p{L}']*/gu; const half = a / b / c;", 'ts');
    expect(line?.filter((token) => token.kind === 'regex')).toEqual([
      { kind: 'regex', text: "/[\\p{L}']*/gu" },
    ]);
    expect(line?.some((token) => token.kind === 'string')).toBe(false);
  });

  it('marks keys in TOML and JSON, and leaves unknown files plain', () => {
    expect(highlight('name = "x"', 'toml')[0]?.[0]).toEqual({ kind: 'key', text: 'name' });
    expect(highlight('{"a": 1}', 'json')[0]?.[1]).toEqual({ kind: 'key', text: '"a"' });
    expect(languageOf('src/main.rs')).toBe('rust');
    expect(languageOf('notes.txt')).toBeNull();
    expect(highlight('plain', null)).toEqual([[{ kind: 'plain', text: 'plain' }]]);
  });
});

describe('the README as Markdown', () => {
  it('parses headings, paragraphs, lists, quotes, fenced code and rules', () => {
    const blocks = parseMarkdown(
      '# greeter\n\nSmall *text* helpers.\n\n- one\n- two\n\n> note\n\n```ts\nconst a = 1;\n```\n\n---\n',
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      'heading',
      'paragraph',
      'list',
      'quote',
      'code',
      'rule',
    ]);
    expect(blocks[4]).toEqual({ kind: 'code', language: 'ts', text: 'const a = 1;' });
  });

  it('keeps raw HTML as text and links only to safe targets', () => {
    expect(parseInline('<script>x</script>')).toEqual([
      { kind: 'text', text: '<script>x</script>' },
    ]);
    expect(parseInline('[go](javascript:alert(1))')[0]?.kind).not.toBe('link');
    expect(parseInline('[docs](docs/a.md)')).toEqual([
      { kind: 'link', href: 'docs/a.md', children: [{ kind: 'text', text: 'docs' }] },
    ]);
    expect(isSafeHref('//evil.example')).toBe(false);
    expect(isSafeHref('data:text/html,x')).toBe(false);
    expect(isSafeHref('mailto:a@b.c')).toBe(true);
  });

  it('reads code spans before emphasis', () => {
    expect(parseInline('run `npm *test*` now')).toEqual([
      { kind: 'text', text: 'run ' },
      { kind: 'code', text: 'npm *test*' },
      { kind: 'text', text: ' now' },
    ]);
  });
});

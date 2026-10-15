import { describe, expect, it } from 'vitest';

import type { FileChange } from '../../git/diff-text';
import { beanLinks } from '../bean-links';
import { go } from './go';

function imported(path: string, text: string, candidates: readonly string[]): readonly string[] {
  return go.importedFiles(path, text, new Set(candidates));
}

function change(path: string, before: string, after: string): FileChange {
  return { path, before, after, beforeId: null, afterId: null };
}

describe('go.importedFiles', () => {
  it('resolves a single import to the files of the package directory', () => {
    const text = 'package cart\n\nimport "example.com/shop/pricing"\n';
    expect(imported('cart/cart.go', text, ['pricing/price.go', 'docs/pricing.md'])).toEqual([
      'pricing/price.go',
    ]);
  });

  it('resolves grouped and aliased imports', () => {
    const text = [
      'package cart',
      'import (',
      '\t"fmt"',
      '\tp "example.com/shop/internal/pricing"',
      '\t_ "example.com/shop/tax" // side effects',
      ')',
    ].join('\n');
    expect(
      imported('cart/cart.go', text, ['internal/pricing/x.go', 'tax/rate.go', 'fmt/fake.go']),
    ).toEqual(['internal/pricing/x.go', 'tax/rate.go']);
  });

  it('prefers the directory that matches the most trailing segments', () => {
    const text = 'package cart\nimport "example.com/shop/internal/pricing"\n';
    expect(imported('cart/cart.go', text, ['internal/pricing/a.go', 'pricing/b.go'])).toEqual([
      'internal/pricing/a.go',
    ]);
  });

  it('links files of the same package without an import', () => {
    expect(imported('pricing/total.go', 'package pricing\n', ['pricing/price.go'])).toEqual([
      'pricing/price.go',
    ]);
  });

  it('leaves out imports that match no candidate, the standard library and the file itself', () => {
    const text = 'package cart\nimport (\n\t"net/http"\n\t"example.com/shop/billing"\n)\n';
    expect(imported('cart/cart.go', text, ['cart/cart.go', 'http/x.go', 'pricing/p.go'])).toEqual(
      [],
    );
  });

  it('ignores an import in a comment', () => {
    const text = 'package cart\n// import "example.com/shop/pricing"\n';
    expect(imported('cart/cart.go', text, ['pricing/price.go'])).toEqual([]);
  });
});

describe('go.declaredName', () => {
  it.each([
    ['func Price(cents int) int {', 'Price'],
    ['func (c *Cart) Total() int {', 'Total'],
    ['func Map[T any](xs []T) []T {', 'Map'],
    ['type Cart struct {', 'Cart'],
    ['const Shipping = 500', 'Shipping'],
    ['var rate = 0.2', 'rate'],
  ])('reads the name %s declares', (line, name) => {
    expect(go.declaredName(line)).toBe(name);
  });

  it.each(['\treturn Price(10) + shipping', '\tif total > 0 {', '\tgo func() {', 'x := Price(1)'])(
    'reads no declaration in %s',
    (line) => {
      expect(go.declaredName(line)).toBeNull();
    },
  );
});

describe('beanLinks for Go', () => {
  it('links a changed price function to the other bean that imports and calls it', () => {
    const theirs = change(
      'pricing/price.go',
      'package pricing\n\nfunc Price() int {\n\treturn 10000\n}\n',
      'package pricing\n\nfunc Price() int {\n\treturn 100\n}\n',
    );
    const mine = change(
      'cart/cart.go',
      'package cart\n\nimport p "example.com/shop/pricing"\n\nfunc Total() int {\n\treturn 0\n}\n',
      'package cart\n\nimport p "example.com/shop/pricing"\n\nfunc Total() int {\n\treturn p.Price() + 500\n}\n',
    );
    expect(beanLinks([mine], [theirs])).toEqual({
      thisImportsTheirs: ['cart/cart.go -> pricing/price.go'],
      theirsImportsThis: [],
      theyChangedThisUses: ['Price'],
      thisChangedTheyUse: [],
    });
  });
});

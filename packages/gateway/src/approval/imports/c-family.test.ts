import { describe, expect, it } from 'vitest';

import type { FileChange } from '../../git/diff-text';
import { beanLinks } from '../bean-links';
import { cFamily } from './c-family';

function imports(path: string, text: string, candidates: readonly string[]): readonly string[] {
  return cFamily.importedFiles(path, text, new Set(candidates));
}

function change(path: string, before: string, after: string): FileChange {
  return { path, before, after, beforeId: null, afterId: null };
}

describe('cFamily.importedFiles', () => {
  it('resolves a quoted include against the including file first', () => {
    expect(
      imports('src/cart.c', '#include "price.h"\n', ['src/price.h', 'include/price.h']),
    ).toEqual(['src/price.h']);
  });

  it('falls back to a path suffix for a quoted include that is not relative', () => {
    expect(
      imports('src/cart.c', '#include "shop/price.h"\n', ['include/shop/price.h', 'shop.h']),
    ).toEqual(['include/shop/price.h']);
  });

  it('resolves a relative include that climbs a directory', () => {
    expect(imports('src/app/cart.cpp', '#include "../price.hpp"\n', ['src/price.hpp'])).toEqual([
      'src/price.hpp',
    ]);
  });

  it('matches an angle include by suffix only, so system headers match nothing', () => {
    const text = '#include <stdio.h>\n#include <shop/price.h>\n';
    expect(imports('src/cart.c', text, ['include/shop/price.h', 'vendor/stdio.c'])).toEqual([
      'include/shop/price.h',
    ]);
  });

  it('links an include of a header to the changed implementation behind it', () => {
    expect(imports('src/cart.cc', '#include "shop/price.h"\n', ['lib/price.cpp'])).toEqual([
      'lib/price.cpp',
    ]);
  });

  it('links a source file to its own header by name when the include path does not resolve', () => {
    expect(imports('src/price.c', '#include "price.h"\n', ['include/shop/price.h'])).toEqual([
      'include/shop/price.h',
    ]);
  });

  it('leaves out includes that name no candidate, and the file itself', () => {
    const text = '#include "tax.h"\n#include "price.h"\n';
    expect(imports('src/price.h', text, ['src/price.h', 'src/shipping.c'])).toEqual([]);
  });
});

describe('cFamily.declaredName', () => {
  it.each([
    ['int price(void) {', 'price'],
    ['static inline double price(int cents);', 'price'],
    ['std::string Shop::price() const {', 'price'],
    ['const std::vector<Item>& Cart::items() const {', 'items'],
    ['struct Price *make_price(void) {', 'make_price'],
    ['Shop::Shop(int id) : id_(id) {', 'Shop'],
    ['struct Price {', 'Price'],
    ['class Shop : public Store {', 'Shop'],
    ['enum class Currency : int {', 'Currency'],
    ['union Value;', 'Value'],
    ['typedef unsigned long cents_t;', 'cents_t'],
    ['typedef int (*price_fn)(int);', 'price_fn'],
    ['} Price;', 'Price'],
    ['#define PRICE_SCALE 100', 'PRICE_SCALE'],
  ])('reads the declaration in %s', (line, name) => {
    expect(cFamily.declaredName(line)).toBe(name);
  });

  it.each([
    'if (price() > 0) {',
    '} else if (total) {',
    'while (running) {',
    'return price();',
    'total = price() + shipping;',
    'printf("%d\\n", price());',
    'std::sort(items.begin(), items.end());',
    'struct Price p;',
  ])('reads no declaration in %s', (line) => {
    expect(cFamily.declaredName(line)).toBeNull();
  });
});

describe('beanLinks for C', () => {
  it('links price changed in one bean to the include and call in the other', () => {
    const theirs = change(
      'src/price.c',
      '#include "price.h"\n\nint price(void) {\n  return 10000;\n}\n',
      '#include "price.h"\n\nint price(void) {\n  return 100;\n}\n',
    );
    const mine = change(
      'src/cart.c',
      '#include "price.h"\n\nint total(void) {\n  return price();\n}\n',
      '#include "price.h"\n\nint total(void) {\n  return price() + 500;\n}\n',
    );
    const links = beanLinks([mine], [theirs]);
    expect(links.thisImportsTheirs).toEqual(['src/cart.c -> src/price.c']);
    expect(links.theyChangedThisUses).toEqual(['price']);
  });
});

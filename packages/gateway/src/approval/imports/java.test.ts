import { describe, expect, it } from 'vitest';

import type { FileChange } from '../../git/diff-text';
import { beanLinks } from '../bean-links';
import { java } from './java';

const PRICE = 'src/main/java/com/shop/Price.java';
const TAX = 'src/main/java/com/shop/Tax.java';
const CART = 'src/main/java/com/shop/cart/Cart.java';
const OTHER_ROOT = 'service/billing/src/main/java/com/shop/Price.java';

function imports(path: string, text: string, candidates: readonly string[]): readonly string[] {
  return java.importedFiles(path, text, new Set(candidates));
}

function change(path: string, before: string, after: string): FileChange {
  return { path, before, after, beforeId: null, afterId: null };
}

describe('java.importedFiles', () => {
  it('resolves a class import under any source root', () => {
    const text = 'package com.shop.cart;\n\nimport com.shop.Price;\n';
    expect(imports(CART, text, [PRICE, OTHER_ROOT, TAX])).toEqual([PRICE, OTHER_ROOT]);
  });

  it('resolves a static import to the class that holds the member', () => {
    expect(imports(CART, 'import static com.shop.Price.amount;\n', [PRICE])).toEqual([PRICE]);
  });

  it('resolves an import of a nested class to its outer class file', () => {
    expect(imports(CART, 'import com.shop.Price.Currency;\n', [PRICE])).toEqual([PRICE]);
  });

  it('resolves a wildcard import to the files directly in the package', () => {
    const text = 'import com.shop.*;\n';
    expect(imports(CART, text, [PRICE, TAX, 'src/main/java/com/shop/deep/Deep.java'])).toEqual([
      PRICE,
      TAX,
    ]);
  });

  it('counts a same-package class the text names without an import', () => {
    const text = 'package com.shop;\n\nclass Order {\n  Price total;\n}\n';
    const order = 'src/main/java/com/shop/Order.java';
    expect(imports(order, text, [PRICE, TAX])).toEqual([PRICE]);
  });

  it('leaves out an import that names none of the candidates', () => {
    expect(imports(CART, 'import java.util.List;\nimport com.shop.Taxes;\n', [PRICE, TAX])).toEqual(
      [],
    );
  });

  it('never lists the file itself', () => {
    expect(imports(PRICE, 'class Price { Price next; }\n', [PRICE])).toEqual([]);
  });
});

describe('java.declaredName', () => {
  it.each([
    ['public class Price {', 'Price'],
    ['public final class Price<T extends Number> {', 'Price'],
    ['interface Priced {', 'Priced'],
    ['enum Currency {', 'Currency'],
    ['public record Money(long cents) {', 'Money'],
    ['public @interface Audited {', 'Audited'],
    ['  public static int price(int quantity) {', 'price'],
    ['  private static <T extends Comparable<T>> List<T> sorted(List<T> items) {', 'sorted'],
    ['  Map<String, List<Integer>> byName() {', 'byName'],
    ['  @Override public String toString() {', 'toString'],
    ['  int[] totals();', 'totals'],
    ['  public Price(long cents) {', 'Price'],
    ['  public static final int SHIPPING = 500;', 'SHIPPING'],
  ])('reads the declaration in %s', (line, name) => {
    expect(java.declaredName(line)).toBe(name);
  });

  it.each([
    ['    return price();'],
    ['    if (price() > 0) {'],
    ['    } else if (ready) {'],
    ['    for (int i = 0; i < 3; i++) {'],
    ['    total = price(quantity);'],
    ['    int total = price();'],
    ['    throw new IllegalStateException("no price");'],
    ['  @Override'],
    ['  private int count = 0;'],
  ])('reads no declaration in %s', (line) => {
    expect(java.declaredName(line)).toBeNull();
  });
});

describe('beanLinks with Java', () => {
  it('links price() changed in one bean to its call in the other', () => {
    const priceInDollars = change(
      PRICE,
      'package com.shop;\n\npublic class Price {\n  public static int price() {\n    return 10000;\n  }\n}\n',
      'package com.shop;\n\npublic class Price {\n  public static int price() {\n    return 100;\n  }\n}\n',
    );
    const shippingInCents = change(
      CART,
      'package com.shop.cart;\n\nimport com.shop.Price;\n\nclass Cart {\n  int total() {\n    return Price.price();\n  }\n}\n',
      'package com.shop.cart;\n\nimport com.shop.Price;\n\nclass Cart {\n  int total() {\n    return Price.price() + 500;\n  }\n}\n',
    );
    const links = beanLinks([shippingInCents], [priceInDollars]);
    expect(links.thisImportsTheirs).toEqual([`${CART} -> ${PRICE}`]);
    expect(links.theyChangedThisUses).toEqual(['price']);
  });
});

import { describe, expect, it } from 'vitest';

import type { FileChange } from '../../git/diff-text';
import { beanLinks } from '../bean-links';
import { kotlin } from './kotlin';

const PRICE = 'src/main/kotlin/com/shop/Price.kt';
const PRICING = 'src/main/kotlin/com/shop/Pricing.kt';
const CART = 'src/main/kotlin/com/shop/cart/Cart.kt';
const LEGACY = 'legacy/src/main/java/com/shop/Tax.java';

function imports(path: string, text: string, candidates: readonly string[]): readonly string[] {
  return kotlin.importedFiles(path, text, new Set(candidates));
}

function change(path: string, before: string, after: string): FileChange {
  return { path, before, after, beforeId: null, afterId: null };
}

describe('kotlin.importedFiles', () => {
  it('resolves a class import to the file named after it under any source root', () => {
    const text = 'package com.shop.cart\n\nimport com.shop.Price\n';
    expect(imports(CART, text, [PRICE, PRICING])).toEqual([PRICE]);
  });

  it('resolves a class import to a Java file named after it', () => {
    expect(imports(CART, 'import com.shop.Tax\n', [LEGACY])).toEqual([LEGACY]);
  });

  it('falls back to the package files when no file is named after the class', () => {
    expect(imports(CART, 'import com.shop.Money as Cash\n', [PRICING])).toEqual([PRICING]);
  });

  it('resolves an import of a top-level function to the package files', () => {
    const text = 'import com.shop.price\n';
    expect(imports(CART, text, [PRICE, PRICING, 'src/main/kotlin/com/shop/deep/D.kt'])).toEqual([
      PRICE,
      PRICING,
    ]);
  });

  it('resolves a wildcard import and a backticked name', () => {
    expect(imports(CART, 'import com.`shop`.*\n', [PRICE])).toEqual([PRICE]);
  });

  it('counts a same-package class the text names without an import', () => {
    const text = 'package com.shop\n\nclass Order(val total: Price)\n';
    expect(imports('src/main/kotlin/com/shop/Order.kt', text, [PRICE, PRICING])).toEqual([PRICE]);
  });

  it('leaves out an import that names none of the candidates', () => {
    expect(imports(CART, 'import kotlinx.coroutines.launch\n', [PRICE])).toEqual([]);
  });
});

describe('kotlin.declaredName', () => {
  it.each([
    ['fun price(quantity: Int): Int {', 'price'],
    ['  private suspend fun load() = repo.get()', 'load'],
    ['fun <T> List<T>.second(): T = this[1]', 'second'],
    ['@JvmStatic fun create(): Price {', 'create'],
    ['data class Money(val cents: Long)', 'Money'],
    ['sealed interface Priced {', 'Priced'],
    ['object Prices {', 'Prices'],
    ['enum class Currency {', 'Currency'],
    ['fun interface Pricer {', 'Pricer'],
    ['const val SHIPPING = 500', 'SHIPPING'],
    ['  private val cache = mutableMapOf<String, Int>()', 'cache'],
    ['val String.cents: Long get() = 0', 'cents'],
    ['typealias Cents = Long', 'Cents'],
  ])('reads the declaration in %s', (line, name) => {
    expect(kotlin.declaredName(line)).toBe(name);
  });

  it.each([
    ['    return price()'],
    ['    if (price() > 0) {'],
    ['    price(quantity)'],
    ['    total = price()'],
    ['  companion object {'],
    ['  @Test'],
  ])('reads no declaration in %s', (line) => {
    expect(kotlin.declaredName(line)).toBeNull();
  });
});

describe('beanLinks with Kotlin', () => {
  it('links price() changed in one bean to its call in the other', () => {
    const priceInDollars = change(
      PRICING,
      'package com.shop\n\nfun price(): Int {\n    return 10000\n}\n',
      'package com.shop\n\nfun price(): Int {\n    return 100\n}\n',
    );
    const shippingInCents = change(
      CART,
      'package com.shop.cart\n\nimport com.shop.price\n\nfun total(): Int {\n    return price()\n}\n',
      'package com.shop.cart\n\nimport com.shop.price\n\nfun total(): Int {\n    return price() + 500\n}\n',
    );
    const links = beanLinks([shippingInCents], [priceInDollars]);
    expect(links.thisImportsTheirs).toEqual([`${CART} -> ${PRICING}`]);
    expect(links.theyChangedThisUses).toEqual(['price']);
  });
});

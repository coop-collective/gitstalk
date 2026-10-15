import { describe, expect, it } from 'vitest';

import type { FileChange } from '../../git/diff-text';
import { beanLinks } from '../bean-links';
import { python } from './python';

const CANDIDATES: ReadonlySet<string> = new Set([
  'src/shop/price.py',
  'src/shop/tax/__init__.py',
  'src/shop/tax/rates.py',
  'src/shop/__init__.py',
  'tools/report.py',
]);

function imports(path: string, text: string): readonly string[] {
  return python.importedFiles(path, text, CANDIDATES);
}

describe('python.importedFiles', () => {
  it('resolves a relative import from the importing file', () => {
    expect(imports('src/shop/cart.py', 'from .price import price\n')).toEqual([
      'src/shop/price.py',
    ]);
  });

  it('resolves parent-relative imports and names that are submodules', () => {
    expect(imports('src/shop/tax/vat.py', 'from .. import price\n')).toEqual([
      'src/shop/__init__.py',
      'src/shop/price.py',
    ]);
    expect(imports('src/shop/cart.py', 'from .tax import rates\n')).toEqual([
      'src/shop/tax/__init__.py',
      'src/shop/tax/rates.py',
    ]);
  });

  it('resolves absolute imports by suffix under a nested source root', () => {
    expect(imports('app/main.py', 'from shop.price import price\n')).toEqual(['src/shop/price.py']);
    expect(imports('app/main.py', 'import shop.tax as tax, os\n')).toEqual([
      'src/shop/tax/__init__.py',
    ]);
  });

  it('reads parenthesised and continued import lists', () => {
    const text = 'from shop.tax import (\n    rates,\n    other as o,\n)\n';
    expect(imports('app/main.py', text)).toEqual([
      'src/shop/tax/__init__.py',
      'src/shop/tax/rates.py',
    ]);
    expect(imports('app/main.py', 'from shop import \\\n    price\n')).toEqual([
      'src/shop/__init__.py',
      'src/shop/price.py',
    ]);
  });

  it('leaves out imports that match no candidate, comments, strings and the file itself', () => {
    const text = [
      'import json',
      'from billing.price import price',
      '# from shop.price import price',
      '"""',
      'import tools.report',
      '"""',
      'from .price import price',
    ].join('\n');
    expect(imports('src/shop/price.py', text)).toEqual([]);
  });

  it('never resolves a relative import above the repo root', () => {
    expect(imports('main.py', 'from ..shop import price\n')).toEqual([]);
  });
});

describe('python.declaredName', () => {
  it('names functions, async functions and classes at any depth', () => {
    expect(python.declaredName('def price(cents):')).toBe('price');
    expect(python.declaredName('    async def fetch_rates(self):')).toBe('fetch_rates');
    expect(python.declaredName('class Cart(Base):')).toBe('Cart');
  });

  it('names module-level upper-case and annotated constants', () => {
    expect(python.declaredName('SHIPPING_CENTS = 500')).toBe('SHIPPING_CENTS');
    expect(python.declaredName('TIMEOUT: Final[int] = 30')).toBe('TIMEOUT');
    expect(python.declaredName('rate: float = 1.0')).toBe('rate');
  });

  it('returns null for statements, comparisons and indented assignments', () => {
    expect(python.declaredName('    return price() + 500')).toBeNull();
    expect(python.declaredName('total = price()')).toBeNull();
    expect(python.declaredName('    RATE = 2')).toBeNull();
    expect(python.declaredName('else: x = 1')).toBeNull();
    expect(python.declaredName('DEBUG == True')).toBeNull();
  });
});

function change(path: string, before: string | null, after: string | null): FileChange {
  return { path, before, after, beforeId: null, afterId: null };
}

describe('beanLinks on Python', () => {
  it('links price changed in one bean to its import and call in the other', () => {
    const priceInDollars = change(
      'src/shop/price.py',
      'def price():\n    return 10000\n',
      'def price():\n    return 100\n',
    );
    const shipping = change(
      'src/shop/checkout.py',
      'from .price import price\n\ndef total():\n    return price()\n',
      'from .price import price\n\nSHIPPING = 500\n\ndef total():\n    return price() + SHIPPING\n',
    );
    expect(beanLinks([shipping], [priceInDollars])).toEqual({
      thisImportsTheirs: ['src/shop/checkout.py -> src/shop/price.py'],
      theirsImportsThis: [],
      theyChangedThisUses: ['price'],
      thisChangedTheyUse: [],
    });
  });
});

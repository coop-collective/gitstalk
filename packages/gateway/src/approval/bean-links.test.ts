import { describe, expect, it } from 'vitest';

import type { FileChange } from '../git/diff-text';
import { NO_LINKS, beanLinks, linkCount } from './bean-links';

function change(path: string, before: string | null, after: string | null): FileChange {
  return { path, before, after, beforeId: null, afterId: null };
}

const PRICE_TO_DOLLARS = change(
  'src/price.mjs',
  '// cents\nexport function price() {\n  return 10000;\n}\n',
  '// dollars\nexport function price() {\n  return 100;\n}\n',
);
const SHIPPING_IN_CENTS = change(
  'src/checkout.mjs',
  'import { price } from "./price.mjs";\n\nexport function total() {\n  return price();\n}\n',
  'import { price } from "./price.mjs";\n\nconst SHIPPING = 500;\n\nexport function total() {\n  return price() + SHIPPING;\n}\n',
);

describe('beanLinks', () => {
  it('finds the import and the changed function the other bean calls', () => {
    expect(beanLinks([SHIPPING_IN_CENTS], [PRICE_TO_DOLLARS])).toEqual({
      thisImportsTheirs: ['src/checkout.mjs -> src/price.mjs'],
      theirsImportsThis: [],
      theyChangedThisUses: ['price'],
      thisChangedTheyUse: [],
    });
  });

  it('reads both directions', () => {
    const links = beanLinks([PRICE_TO_DOLLARS], [SHIPPING_IN_CENTS]);
    expect(links.theirsImportsThis).toEqual(['src/checkout.mjs -> src/price.mjs']);
    expect(links.thisChangedTheyUse).toEqual(['price']);
  });

  it('names a constant changed on its own line', () => {
    const rate = change('src/rate.ts', 'export const RATE = 100;\n', 'export const RATE = 1;\n');
    const user = change('src/use.ts', 'let a = 0;\n', 'let a = RATE * 2;\n');
    expect(beanLinks([user], [rate]).theyChangedThisUses).toEqual(['RATE']);
  });

  it('reads Python definitions', () => {
    const theirs = change(
      'app/price.py',
      'def price():\n    return 10000\n',
      'def price():\n    return 100\n',
    );
    const mine = change('app/cart.py', 'x = 1\n', 'x = price() + 500\n');
    expect(beanLinks([mine], [theirs]).theyChangedThisUses).toEqual(['price']);
  });

  it('never links by a generic name or a single letter', () => {
    const theirs = change(
      'src/a.ts',
      'export function server() {}\nexport const x = 1;\n',
      'export function server() { return 1; }\nexport const x = 2;\n',
    );
    const mine = change('src/b.ts', 'a;\n', 'server(); x;\n');
    expect(beanLinks([mine], [theirs]).theyChangedThisUses).toEqual([]);
  });

  it('finds no link between unrelated changes, or in docs', () => {
    const readme = change('README.md', 'price\n', 'price() in dollars\n');
    const other = change('src/log.ts', 'export const level = 1;\n', 'export const level = 2;\n');
    expect(beanLinks([readme, other], [PRICE_TO_DOLLARS])).toEqual(NO_LINKS);
    expect(linkCount(NO_LINKS)).toBe(0);
  });
});

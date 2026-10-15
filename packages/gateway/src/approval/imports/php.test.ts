import { describe, expect, it } from 'vitest';

import type { FileChange } from '../../git/diff-text';
import { beanLinks } from '../bean-links';
import { php } from './php';

function imports(path: string, text: string, candidates: readonly string[]): readonly string[] {
  return php.importedFiles(path, text, new Set(candidates));
}

function change(path: string, before: string, after: string): FileChange {
  return { path, before, after, beforeId: null, afterId: null };
}

describe('php.importedFiles', () => {
  it('resolves require and include of a string literal against the file', () => {
    const text = "<?php\nrequire_once 'lib/price.php';\ninclude('../tax.php');\n";
    expect(imports('web/cart.php', text, ['web/lib/price.php', 'tax.php', 'web/x.php'])).toEqual([
      'web/lib/price.php',
      'tax.php',
    ]);
  });

  it('resolves a path built from __DIR__', () => {
    const text = "<?php\nrequire __DIR__ . '/../src/price.php';\n";
    expect(imports('public/index.php', text, ['src/price.php'])).toEqual(['src/price.php']);
  });

  it('maps a use of a class to its PSR-4 file under any root', () => {
    const text = '<?php\nnamespace App\\Cart;\n\nuse App\\Pricing\\Price;\n';
    expect(imports('src/Cart/Cart.php', text, ['src/Pricing/Price.php', 'app/Price.php'])).toEqual([
      'src/Pricing/Price.php',
    ]);
  });

  it('accepts the full namespace path as the suffix', () => {
    const text = '<?php\nuse App\\Pricing\\Price as Cost;\n';
    expect(imports('index.php', text, ['lib/App/Pricing/Price.php'])).toEqual([
      'lib/App/Pricing/Price.php',
    ]);
  });

  it('reads grouped and function imports', () => {
    const text =
      '<?php\nuse App\\Pricing\\{Price, Tax as Vat};\nuse function App\\Shipping\\rate;\n';
    const candidates = ['src/Pricing/Price.php', 'src/Pricing/Tax.php', 'src/Shipping/rate.php'];
    expect(imports('src/Cart.php', text, candidates)).toEqual(candidates);
  });

  it('leaves out imports that name no candidate, and the file itself', () => {
    const text = "<?php\nuse Psr\\Log\\LoggerInterface;\nrequire 'Cart.php';\n";
    expect(imports('src/Cart.php', text, ['src/Cart.php', 'src/Pricing/Price.php'])).toEqual([]);
  });
});

describe('php.declaredName', () => {
  it.each([
    ['function price(int $cents): int {', 'price'],
    ['    public static function price(): int', 'price'],
    ['    final protected function &items() {', 'items'],
    ['abstract class Price extends Money', 'Price'],
    ['interface Priced {', 'Priced'],
    ['trait HasPrice', 'HasPrice'],
    ['enum Currency: string {', 'Currency'],
    ['    private const SCALE = 100;', 'SCALE'],
    ['    const int SCALE = 100;', 'SCALE'],
    ["define('PRICE_SCALE', 100);", 'PRICE_SCALE'],
  ])('reads the declaration in %s', (line, name) => {
    expect(php.declaredName(line)).toBe(name);
  });

  it.each([
    'if ($price > 0) {',
    'return price();',
    'while ($running) {',
    '$total = $this->price() + 5;',
    '$fn = function ($x) use ($rate) {',
  ])('reads no declaration in %s', (line) => {
    expect(php.declaredName(line)).toBeNull();
  });
});

describe('beanLinks for PHP', () => {
  it('links price changed in one bean to the use and call in the other', () => {
    const theirs = change(
      'src/Pricing/Price.php',
      '<?php\nclass Price\n{\n    public function price(): int\n    {\n        return 10000;\n    }\n}\n',
      '<?php\nclass Price\n{\n    public function price(): int\n    {\n        return 100;\n    }\n}\n',
    );
    const mine = change(
      'src/Cart/Cart.php',
      '<?php\nuse App\\Pricing\\Price;\n\n$total = (new Price())->price();\n',
      '<?php\nuse App\\Pricing\\Price;\n\n$total = (new Price())->price() + 500;\n',
    );
    const links = beanLinks([mine], [theirs]);
    expect(links.thisImportsTheirs).toEqual(['src/Cart/Cart.php -> src/Pricing/Price.php']);
    expect(links.theyChangedThisUses).toEqual(['price']);
  });
});

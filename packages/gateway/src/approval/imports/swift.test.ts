import { describe, expect, it } from 'vitest';

import type { FileChange } from '../../git/diff-text';
import { beanLinks } from '../bean-links';
import { swift } from './swift';

function imported(path: string, text: string, candidates: readonly string[]): readonly string[] {
  return swift.importedFiles(path, text, new Set(candidates));
}

function change(path: string, before: string, after: string): FileChange {
  return { path, before, after, beforeId: null, afterId: null };
}

const CART = 'Sources/ShopApp/Cart.swift';

describe('swift imports', () => {
  it('links an import to the files under the module directory', () => {
    const candidates = ['Sources/ShopCore/Models/Price.swift', 'Sources/ShopCore/README.md'];
    expect(imported(CART, 'import Foundation\nimport ShopCore\n', candidates)).toEqual([
      'Sources/ShopCore/Models/Price.swift',
    ]);
  });

  it('links a testable import from a test target', () => {
    const test = 'Tests/ShopCoreTests/PriceTests.swift';
    expect(imported(test, '@testable import ShopCore\n', ['Sources/ShopCore/Tax.swift'])).toEqual([
      'Sources/ShopCore/Tax.swift',
    ]);
  });

  it('links a symbol import only to the file named after the symbol', () => {
    const candidates = ['Sources/ShopCore/Price.swift', 'Sources/ShopCore/Tax.swift'];
    expect(imported(CART, 'import struct ShopCore.Price\n', candidates)).toEqual([
      'Sources/ShopCore/Price.swift',
    ]);
  });

  it('links a file of the same module whose type is used', () => {
    const text = 'struct Cart { let total = Price(cents: 1).formatted }\n';
    const candidates = [
      'Sources/ShopApp/Models/Price+Format.swift',
      'Sources/ShopApp/Tax.swift',
      'Sources/Other/Price.swift',
    ];
    expect(imported(CART, text, candidates)).toEqual(['Sources/ShopApp/Models/Price+Format.swift']);
  });

  it('links a file in the same directory outside a package', () => {
    const text = 'let price = Price()\n';
    expect(imported('App/Cart.swift', text, ['App/Price.swift', 'Lib/Price.swift'])).toEqual([
      'App/Price.swift',
    ]);
  });

  it('links nothing for an import of another module, a comment, or the file itself', () => {
    const text = 'import UIKit\n// Price is mentioned here only\nstruct Cart {}\n';
    const candidates = ['Sources/ShopCore/Price.swift', 'Sources/ShopApp/Price.swift', CART];
    expect(imported(CART, text, candidates)).toEqual([]);
  });
});

describe('swift declarations', () => {
  it.each([
    ['func price(cents: Int) -> Decimal {', 'price'],
    ['    public static func make<T>(_ value: T) -> Self {', 'make'],
    ['@MainActor final class CartModel: ObservableObject {', 'CartModel'],
    ['public struct Price: Equatable {', 'Price'],
    ['indirect enum Rule {', 'Rule'],
    ['protocol Pricing {', 'Pricing'],
    ['extension Price: CustomStringConvertible {', 'Price'],
    ['static let shipping = 500', 'shipping'],
    ['private(set) var total: Int = 0', 'total'],
    ['class func shared() -> Cart {', 'shared'],
    ['@Published var items: [Item] = []', 'items'],
    ['let `default` = Price()', 'default'],
  ])('reads %s as %s', (line, name) => {
    expect(swift.declaredName(line)).toBe(name);
  });

  it.each([
    'if let price = cart.price {',
    'guard var total else { return }',
    'return price(cents: 1)',
    'price(cents: 1)',
    'for item in items {',
    'import ShopCore',
  ])('reads no declaration in %s', (line) => {
    expect(swift.declaredName(line)).toBeNull();
  });
});

describe('swift bean links', () => {
  it('links Price changed in one bean to its use in the other', () => {
    const theirs = change(
      'Sources/ShopCore/Price.swift',
      'public struct Price {\n    public static func of(_ cents: Int) -> Decimal {\n        return Decimal(cents)\n    }\n}\n',
      'public struct Price {\n    public static func of(_ cents: Int) -> Decimal {\n        return Decimal(cents) / 100\n    }\n}\n',
    );
    const mine = change(
      CART,
      'import ShopCore\n\nfunc total() -> Decimal {\n    return 0\n}\n',
      'import ShopCore\n\nfunc total() -> Decimal {\n    return Price.of(500)\n}\n',
    );
    expect(beanLinks([mine], [theirs])).toEqual({
      thisImportsTheirs: [`${CART} -> Sources/ShopCore/Price.swift`],
      theirsImportsThis: [],
      theyChangedThisUses: ['of'],
      thisChangedTheyUse: [],
    });
  });
});

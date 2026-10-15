import { describe, expect, it } from 'vitest';

import type { FileChange } from '../../git/diff-text';
import { beanLinks } from '../bean-links';
import { csharp } from './csharp';

function imported(text: string, candidates: readonly string[]): readonly string[] {
  return csharp.importedFiles('src/Shop/Checkout/Cart.cs', text, new Set(candidates));
}

function change(path: string, before: string, after: string): FileChange {
  return { path, before, after, beforeId: null, afterId: null };
}

describe('csharp imports', () => {
  it('links a using to the files in the directory that spells the namespace', () => {
    const candidates = ['src/Shop/Pricing/Price.cs', 'src/Shop/Pricing/Tax/Rate.cs', 'README.md'];
    expect(imported('using Shop.Pricing;\n', candidates)).toEqual(['src/Shop/Pricing/Price.cs']);
  });

  it('links a using to a dotted project directory', () => {
    const candidates = ['Shop.Pricing/Discount.cs', 'Shop.Core/Pricing/Rule.cs'];
    expect(imported('global using Shop.Pricing;\n', candidates)).toEqual([
      'Shop.Pricing/Discount.cs',
    ]);
    expect(imported('using Shop.Core.Pricing;\n', candidates)).toEqual([
      'Shop.Core/Pricing/Rule.cs',
    ]);
  });

  it('links a using static and an alias to the type file', () => {
    const candidates = ['src/Shop/Pricing/Price.cs', 'src/Shop/Pricing/Tax.cs'];
    expect(imported('using static Shop.Pricing.Price;\n', candidates)).toEqual([
      'src/Shop/Pricing/Price.cs',
    ]);
    expect(imported('using P = Shop.Pricing.Price;\n', candidates)).toEqual([
      'src/Shop/Pricing/Price.cs',
    ]);
  });

  it('links a file whose type is referenced without a using', () => {
    const text =
      'namespace Shop.Checkout;\nclass Cart { Order.Line line; decimal Total() => Price.Of(1); }\n';
    expect(imported(text, ['src/Shop/Pricing/Price.cs', 'src/Shop/Order.Designer.cs'])).toEqual([
      'src/Shop/Pricing/Price.cs',
      'src/Shop/Order.Designer.cs',
    ]);
  });

  it('links nothing for a using of another namespace, a comment, or the file itself', () => {
    const text = 'using System.Linq;\n// Price is mentioned here only\nclass Cart {}\n';
    const candidates = [
      'src/Shop/Pricing/Price.cs',
      'src/Shop/Checkout/Cart.cs',
      'src/System/Text.cs',
    ];
    expect(imported(text, candidates)).toEqual([]);
  });
});

describe('csharp declarations', () => {
  it.each([
    ['public sealed class Price', 'Price'],
    ['internal readonly record struct Money(decimal Amount);', 'Money'],
    ['public partial interface IPricing', 'IPricing'],
    ['[Flags] public enum Currency', 'Currency'],
    ['public static decimal Price(int quantity)', 'Price'],
    ['public async Task<IReadOnlyList<Line>> LinesAsync()', 'LinesAsync'],
    ['public int Total { get; }', 'Total'],
    ['public decimal Net => Gross - Tax;', 'Net'],
    ['private readonly decimal _rate = 1m;', '_rate'],
    ['private const int Cents = 100;', 'Cents'],
    ['public Price(decimal amount)', 'Price'],
    ['decimal Price(int quantity);', 'Price'],
    ['T Parse<T>(string text) where T : new()', 'Parse'],
  ])('reads %s as %s', (line, name) => {
    expect(csharp.declaredName(line)).toBe(name);
  });

  it.each([
    'if (total > 0)',
    'return Price();',
    'await Task.Delay(1);',
    'throw new InvalidOperationException();',
    'new Price(1);',
    'var total = Price(2);',
    'Console.WriteLine(total);',
    'else if (x)',
    'namespace Shop.Pricing;',
  ])('reads no declaration in %s', (line) => {
    expect(csharp.declaredName(line)).toBeNull();
  });
});

describe('csharp bean links', () => {
  it('links Price changed in one bean to its use in the other', () => {
    const theirs = change(
      'src/Shop/Pricing/Price.cs',
      'public static class Price\n{\n    public static decimal Of(int cents)\n    {\n        return cents;\n    }\n}\n',
      'public static class Price\n{\n    public static decimal Of(int cents)\n    {\n        return cents / 100m;\n    }\n}\n',
    );
    const mine = change(
      'src/Shop/Checkout/Cart.cs',
      'using Shop.Pricing;\nclass Cart\n{\n    decimal Total() => 0;\n}\n',
      'using Shop.Pricing;\nclass Cart\n{\n    decimal Total() => Price.Of(500);\n}\n',
    );
    expect(beanLinks([mine], [theirs])).toEqual({
      thisImportsTheirs: ['src/Shop/Checkout/Cart.cs -> src/Shop/Pricing/Price.cs'],
      theirsImportsThis: [],
      theyChangedThisUses: ['Of'],
      thisChangedTheyUse: [],
    });
  });
});

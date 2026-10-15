import { describe, expect, it } from 'vitest';

import type { FileChange } from '../../git/diff-text';
import { beanLinks } from '../bean-links';
import { ruby } from './ruby';

const CANDIDATES: ReadonlySet<string> = new Set([
  'lib/shop/price.rb',
  'lib/shop/tax.rb',
  'app/models/cart.rb',
  'gems/billing/lib/billing/invoice.rb',
]);

function imports(path: string, text: string): readonly string[] {
  return ruby.importedFiles(path, text, CANDIDATES);
}

describe('ruby.importedFiles', () => {
  it('resolves require_relative from the requiring file, with or without .rb', () => {
    expect(imports('lib/shop/cart.rb', "require_relative 'price'\n")).toEqual([
      'lib/shop/price.rb',
    ]);
    expect(imports('app/controllers/cart.rb', 'require_relative("../models/cart.rb")\n')).toEqual([
      'app/models/cart.rb',
    ]);
  });

  it('resolves require, load and autoload by suffix under a nested lib root', () => {
    const text = [
      "require 'shop/price'",
      'load "shop/tax.rb"',
      "autoload :Invoice, 'billing/invoice'",
    ].join('\n');
    expect(imports('bin/checkout.rb', text)).toEqual([
      'lib/shop/price.rb',
      'lib/shop/tax.rb',
      'gems/billing/lib/billing/invoice.rb',
    ]);
  });

  it('leaves out unmatched, commented, interpolated and self requires', () => {
    const text = [
      "require 'json'",
      "# require 'shop/tax'",
      '=begin',
      "require 'billing/invoice'",
      '=end',
      'require "shop/#{name}"',
      "require_relative 'price'",
      "require_relative '../../outside'",
    ].join('\n');
    expect(imports('lib/shop/price.rb', text)).toEqual([]);
  });
});

describe('ruby.declaredName', () => {
  it('names instance methods, class methods and predicate methods', () => {
    expect(ruby.declaredName('  def price(cents)')).toBe('price');
    expect(ruby.declaredName('  def self.for_cart(cart)')).toBe('for_cart');
    expect(ruby.declaredName('  def free?')).toBe('free');
  });

  it('names classes, modules and constants', () => {
    expect(ruby.declaredName('class Shop::Price < Base')).toBe('Price');
    expect(ruby.declaredName('module Billing')).toBe('Billing');
    expect(ruby.declaredName('  SHIPPING_CENTS = 500')).toBe('SHIPPING_CENTS');
  });

  it('returns null for statements, comparisons and singleton blocks', () => {
    expect(ruby.declaredName('    price + 500')).toBeNull();
    expect(ruby.declaredName('  class << self')).toBeNull();
    expect(ruby.declaredName('  RATE == 1')).toBeNull();
    expect(ruby.declaredName('  total = price')).toBeNull();
  });
});

function change(path: string, before: string | null, after: string | null): FileChange {
  return { path, before, after, beforeId: null, afterId: null };
}

describe('beanLinks on Ruby', () => {
  it('links price changed in one bean to its require and call in the other', () => {
    const priceInDollars = change(
      'lib/shop/price.rb',
      'module Shop\n  def self.price\n    10000\n  end\nend\n',
      'module Shop\n  def self.price\n    100\n  end\nend\n',
    );
    const shipping = change(
      'app/checkout.rb',
      "require 'shop/price'\n\ndef total\n  Shop.price\nend\n",
      "require 'shop/price'\n\ndef total\n  Shop.price + 500\nend\n",
    );
    expect(beanLinks([shipping], [priceInDollars])).toEqual({
      thisImportsTheirs: ['app/checkout.rb -> lib/shop/price.rb'],
      theirsImportsThis: [],
      theyChangedThisUses: ['price'],
      thisChangedTheyUse: [],
    });
  });
});

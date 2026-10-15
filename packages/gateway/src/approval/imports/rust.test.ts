import { describe, expect, it } from 'vitest';

import type { FileChange } from '../../git/diff-text';
import { beanLinks } from '../bean-links';
import { rust } from './rust';

function imported(path: string, text: string, candidates: readonly string[]): readonly string[] {
  return rust.importedFiles(path, text, new Set(candidates));
}

function change(path: string, before: string, after: string): FileChange {
  return { path, before, after, beforeId: null, afterId: null };
}

describe('rust.importedFiles', () => {
  it('resolves mod declarations to a sibling file or a mod.rs', () => {
    const text = 'mod price;\npub mod tax;\nmod inline {\n}\n';
    expect(
      imported('src/lib.rs', text, ['src/price.rs', 'src/tax/mod.rs', 'src/inline.rs']),
    ).toEqual(['src/price.rs', 'src/tax/mod.rs']);
  });

  it('resolves a child module of a non-directory file into its own directory', () => {
    expect(imported('src/pricing.rs', 'mod price;\n', ['src/pricing/price.rs'])).toEqual([
      'src/pricing/price.rs',
    ]);
  });

  it('resolves use crate:: to every module prefix under the crate src', () => {
    const text = 'use crate::pricing::price;\n';
    expect(
      imported('crates/shop/src/cart.rs', text, [
        'crates/shop/src/pricing.rs',
        'crates/shop/src/pricing/price.rs',
        'crates/other/src/pricing.rs',
      ]),
    ).toEqual(['crates/shop/src/pricing.rs', 'crates/shop/src/pricing/price.rs']);
  });

  it('expands grouped use trees', () => {
    const text = 'use crate::{tax, pricing::{self, price::Price as P}};\n';
    expect(
      imported('src/cart.rs', text, ['src/tax.rs', 'src/pricing/mod.rs', 'src/pricing/price.rs']),
    ).toEqual(['src/tax.rs', 'src/pricing/mod.rs', 'src/pricing/price.rs']);
  });

  it('resolves super:: and self:: from the file module', () => {
    const text = 'use super::price::Price;\nuse self::helpers::round;\n';
    expect(
      imported('src/pricing/total.rs', text, [
        'src/pricing/price.rs',
        'src/pricing/total/helpers.rs',
      ]),
    ).toEqual(['src/pricing/price.rs', 'src/pricing/total/helpers.rs']);
  });

  it('resolves inline crate paths outside use', () => {
    const text = 'fn total() -> u32 {\n    crate::pricing::price() + 500\n}\n';
    expect(imported('src/cart.rs', text, ['src/pricing.rs'])).toEqual(['src/pricing.rs']);
  });

  it('leaves out std, external crates and the file itself', () => {
    const text = 'use std::collections::HashMap;\nuse serde::Serialize;\nuse crate::cart;\n';
    expect(imported('src/cart.rs', text, ['src/cart.rs', 'src/std.rs', 'src/serde.rs'])).toEqual(
      [],
    );
  });

  it('matches by suffix when the file has no src directory', () => {
    expect(imported('cart.rs', 'use crate::pricing;\n', ['lib/pricing.rs'])).toEqual([
      'lib/pricing.rs',
    ]);
  });
});

describe('rust.declaredName', () => {
  it.each([
    ['fn price() -> u32 {', 'price'],
    ['pub fn price() -> u32 {', 'price'],
    ['    pub(crate) async fn fetch(&self) {', 'fetch'],
    ['pub const unsafe fn raw() {', 'raw'],
    ['pub struct Cart {', 'Cart'],
    ['enum Currency {', 'Currency'],
    ['pub trait Priced {', 'Priced'],
    ['type Cents = u32;', 'Cents'],
    ['impl Cart {', 'Cart'],
    ['impl<T: Into<u32>> Priced for crate::cart::Cart<T> {', 'Cart'],
    ['impl fmt::Display for Price {', 'Price'],
    ['pub const SHIPPING: u32 = 500;', 'SHIPPING'],
    ['static mut COUNT: u32 = 0;', 'COUNT'],
  ])('reads the name %s declares', (line, name) => {
    expect(rust.declaredName(line)).toBe(name);
  });

  it.each(['    price() + 500', '    if total > 0 {', '    let x = Cart::new();', 'match c {'])(
    'reads no declaration in %s',
    (line) => {
      expect(rust.declaredName(line)).toBeNull();
    },
  );
});

describe('beanLinks for Rust', () => {
  it('links a changed price function to the other bean that uses and calls it', () => {
    const theirs = change(
      'src/pricing.rs',
      'pub fn price() -> u32 {\n    10000\n}\n',
      'pub fn price() -> u32 {\n    100\n}\n',
    );
    const mine = change(
      'src/cart.rs',
      'use crate::pricing::price;\n\npub fn total() -> u32 {\n    0\n}\n',
      'use crate::pricing::price;\n\npub fn total() -> u32 {\n    price() + 500\n}\n',
    );
    expect(beanLinks([mine], [theirs])).toEqual({
      thisImportsTheirs: ['src/cart.rs -> src/pricing.rs'],
      theirsImportsThis: [],
      theyChangedThisUses: ['price'],
      thisChangedTheyUse: [],
    });
  });
});

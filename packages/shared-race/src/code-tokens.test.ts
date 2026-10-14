import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { codeTokens, dialectOf, isCommentOnlyChange } from './code-tokens';

describe('isCommentOnlyChange', () => {
  it('accepts an edited line comment', () => {
    expect(isCommentOnlyChange('a.ts', 'const a = 1; // one\n', 'const a = 1; // the one\n')).toBe(
      true,
    );
  });

  it('accepts added block comments and reindentation', () => {
    const before = 'function f(a, b) {\n  return a + b;\n}\n';
    const after = '/** Adds. */\nfunction f(a, b) {\n    /* sum */ return a + b;\n}\n';
    expect(isCommentOnlyChange('src/f.js', before, after)).toBe(true);
  });

  it('refuses a changed identifier, number or operator', () => {
    expect(isCommentOnlyChange('a.ts', 'let a = 1;', 'let b = 1;')).toBe(false);
    expect(isCommentOnlyChange('a.ts', 'let a = 1;', 'let a = 2;')).toBe(false);
    expect(isCommentOnlyChange('a.ts', 'a + b', 'a - b')).toBe(false);
    expect(isCommentOnlyChange('a.ts', 'x = a +', 'x = a -')).toBe(false);
  });

  it('keeps whitespace inside strings and templates significant', () => {
    expect(isCommentOnlyChange('a.ts', "s = 'a b'", "s = 'a  b'")).toBe(false);
    expect(isCommentOnlyChange('a.ts', 's = `a ${x} b`', 's = `a ${x}  b`')).toBe(false);
  });

  it('does not read comment markers inside strings, templates or regular expressions', () => {
    expect(isCommentOnlyChange('a.ts', 'u = "http://a"', 'u = "http://b"')).toBe(false);
    expect(isCommentOnlyChange('a.ts', 'u = `//${a}`', 'u = `//${b}`')).toBe(false);
    expect(isCommentOnlyChange('a.ts', 'r = /[/]/; x', 'r = /[/]/; y')).toBe(false);
    expect(isCommentOnlyChange('a.ts', 'r = /a\\/*/g; x', 'r = /a\\/*/g; y')).toBe(false);
  });

  it('reads a slash after an operand as division', () => {
    expect(isCommentOnlyChange('a.ts', 'x = a / b / c', 'x = a / b /* c */ / c')).toBe(true);
    expect(isCommentOnlyChange('a.ts', 'x = a / b; // y', 'x = a / c; // y')).toBe(false);
  });

  it('follows nested template expressions', () => {
    const before = 's = `a ${f({ k: `b ${c}` })} d`; // x';
    const after = 's = `a ${f({ k: `b ${c}` })} d`; // y';
    expect(isCommentOnlyChange('a.ts', before, after)).toBe(true);
    expect(isCommentOnlyChange('a.ts', before, before.replace('d`', 'e`'))).toBe(false);
  });

  it('never equates a+ +b with a++b', () => {
    expect(isCommentOnlyChange('a.js', 'x = a+ +b', 'x = a++b')).toBe(false);
  });

  it('handles Rust raw strings, chars, lifetimes and nested comments', () => {
    const before = "fn f<'a>(s: &'a str) -> char { let r = r#\"// no\"#; 'x' }\n";
    const after =
      "/* outer /* inner */ still */\nfn f<'a>(s: &'a str) -> char { let r = r#\"// no\"#; 'x' } // end\n";
    expect(isCommentOnlyChange('src/lib.rs', before, after)).toBe(true);
    expect(isCommentOnlyChange('src/lib.rs', before, before.replace('// no', '// yes'))).toBe(
      false,
    );
  });

  it('refuses added, deleted and unknown files, and anything unterminated', () => {
    expect(isCommentOnlyChange('a.ts', null, '// new')).toBe(false);
    expect(isCommentOnlyChange('a.ts', '// old', null)).toBe(false);
    expect(isCommentOnlyChange('README.md', 'a', 'a ')).toBe(false);
    expect(isCommentOnlyChange('view.tsx', 'a', 'a // b')).toBe(false);
    expect(isCommentOnlyChange('a.ts', 'a /* open', 'a /* open more')).toBe(false);
    expect(isCommentOnlyChange('a.ts', 's = "open', 's = "open')).toBe(false);
  });
});

describe('dialectOf', () => {
  it('judges C-family sources and nothing else', () => {
    expect(dialectOf('src/a.ts')).toBe('js');
    expect(dialectOf('src/lib.rs')).toBe('rust');
    expect(dialectOf('main.go')).toBe('c');
    expect(dialectOf('src/view.tsx')).toBeNull();
    expect(dialectOf('Makefile')).toBeNull();
    expect(dialectOf('.ts')).toBeNull();
  });
});

const identifier = fc.constantFrom('a', 'b', 'total', 'x1', '$y', '_z');
const operator = fc.constantFrom('+', '-', '*', '=', '==', '(', ')', '{', '}', ';', ',', '.');
const literal = fc.constantFrom('"s t"', "'u'", '`v ${a} w`', '42', '= /re+/g;');
const token = fc.oneof(identifier, operator, literal);
const gap = fc.constantFrom(' ', '\n', '  ', ' /* c */ ', ' // c\n', '\t');

describe('codeTokens (properties)', () => {
  it('ignores how tokens are spaced and commented', () => {
    fc.assert(
      fc.property(fc.array(token, { maxLength: 30 }), gap, gap, (tokens, one, two) => {
        const spaced = tokens.join(one);
        const respaced = tokens.join(two);
        expect(isCommentOnlyChange('p.ts', spaced, respaced)).toBe(
          codeTokens(spaced, 'js') !== null,
        );
        expect(isCommentOnlyChange('p.ts', spaced, `// lead\n${spaced}/* tail */`)).toBe(true);
      }),
    );
  });

  it('sees a changed word', () => {
    fc.assert(
      fc.property(fc.array(token, { minLength: 1, maxLength: 20 }), (tokens) => {
        const source = tokens.join(' ');
        expect(isCommentOnlyChange('p.ts', source, `${source} extra`)).toBe(false);
      }),
    );
  });
});

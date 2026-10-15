/**
 * C and C++: imports and declarations for `bean-links.ts` (`language.ts`). `#include "x.h"`
 * resolves against the including file first and then by path suffix (an `include/` root is
 * unknown); `#include <x.h>` by suffix only, so system headers match nothing. A header also
 * stands for the implementation behind it: including `"price.h"` links to a changed `price.c`
 * (quoted includes only, so `<stdio.h>` never pairs with a project's `stdio.c`).
 */
import type { Language } from './language';
import { bySuffix, joinPath } from './language';

const HEADER_EXTENSIONS = ['.h', '.hh', '.hpp', '.hxx'];
const SOURCE_EXTENSIONS = ['.c', '.cc', '.cpp', '.cxx'];

const INCLUDE = /^[ \t]*#[ \t]*(?:include|import)[ \t]*([<"])([^>"\n]+)[>"]/gmu;

const DEFINE = /^\s*#\s*define\s+([A-Za-z_]\w*)/u;
const POINTER_TYPEDEF = /^\s*typedef\b.*\(\s*\*\s*([A-Za-z_]\w*)\s*\)\s*\(/u;
const TYPEDEF = /^\s*typedef\b.*?\b([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*;/u;
/** `} Price;` closing a multi-line `typedef struct {`. */
const TYPEDEF_CLOSE = /^\s*\}\s*([A-Za-z_]\w*)\s*;/u;
const TYPE =
  /^\s*(?:template\s*<.*>\s*)?(?:struct|class|union|enum(?:\s+class|\s+struct)?)\s+(?:\[\[.*?\]\]\s*)?([A-Za-z_]\w*)\s*(?:[:{;]|final\b|$)/u;
/** Return type and specifiers, optional `Owner::` qualifiers, the name, then `(`. */
const FUNCTION =
  /^\s*((?:[A-Za-z_][\w:]*(?:<[^()]*>)?[\s*&]+)+)(?:[A-Za-z_]\w*::)*(~?[A-Za-z_]\w*)\s*\(/u;
/** A constructor or method defined out of line with no return type: `Shop::Shop() {`. */
const QUALIFIED_DEFINITION = /^\s*(?:[A-Za-z_]\w*::)+(~?[A-Za-z_]\w*)\s*\(.*\)[^;]*(?:\{|:)?\s*$/u;

/** Words that start a statement or expression, never a declaration's type. */
const STATEMENT_WORDS: ReadonlySet<string> = new Set([
  'return',
  'if',
  'else',
  'while',
  'for',
  'switch',
  'case',
  'do',
  'goto',
  'sizeof',
  'alignof',
  'decltype',
  'delete',
  'new',
  'throw',
  'co_return',
  'co_await',
  'co_yield',
  'defined',
]);

export const cFamily: Language = {
  id: 'c-family',
  extensions: [...SOURCE_EXTENSIONS, ...HEADER_EXTENSIONS],
  importedFiles: (path, text, candidates) => {
    const includes = [...text.matchAll(INCLUDE)].flatMap(([, delimiter, specifier]) =>
      specifier === undefined ? [] : [{ isQuoted: delimiter === '"', specifier: specifier.trim() }],
    );
    const headers = includes.flatMap(({ isQuoted, specifier }) =>
      includedFiles(path, specifier, isQuoted, candidates),
    );
    const implementations = includes.flatMap(({ isQuoted, specifier }) =>
      isQuoted ? implementationsOf(specifier, candidates) : [],
    );
    const ownHeaders = isSource(path) ? sameStemHeaders(path, includes, candidates) : [];
    return [...new Set([...headers, ...implementations, ...ownHeaders])].filter(
      (target) => target !== path,
    );
  },
  declaredName,
};

function includedFiles(
  path: string,
  specifier: string,
  isQuoted: boolean,
  candidates: ReadonlySet<string>,
): readonly string[] {
  if (isQuoted) {
    const relative = joinPath(path, specifier);
    if (relative !== null && candidates.has(relative)) return [relative];
  }
  return bySuffix(specifier, candidates);
}

/** The changed `price.c`/`price.cpp` behind an included `price.h`, wherever it lives. */
function implementationsOf(specifier: string, candidates: ReadonlySet<string>): readonly string[] {
  const { stem, extension } = splitName(specifier);
  if (!HEADER_EXTENSIONS.includes(extension)) return [];
  return [...candidates].filter((candidate) => {
    const name = splitName(candidate);
    return name.stem === stem && SOURCE_EXTENSIONS.includes(name.extension);
  });
}

/**
 * The changed header a source file implements (`src/price.c` including `price.h` while the
 * header sits in `include/shop/price.h`): matched by file name when the path does not resolve.
 */
function sameStemHeaders(
  path: string,
  includes: readonly { readonly specifier: string }[],
  candidates: ReadonlySet<string>,
): readonly string[] {
  const { stem } = splitName(path);
  const includesOwnHeader = includes.some(({ specifier }) => {
    const name = splitName(specifier);
    return name.stem === stem && HEADER_EXTENSIONS.includes(name.extension);
  });
  if (!includesOwnHeader) return [];
  return [...candidates].filter((candidate) => {
    const name = splitName(candidate);
    return name.stem === stem && HEADER_EXTENSIONS.includes(name.extension);
  });
}

function declaredName(line: string): string | null {
  const simple =
    DEFINE.exec(line)?.[1] ??
    POINTER_TYPEDEF.exec(line)?.[1] ??
    TYPEDEF.exec(line)?.[1] ??
    TYPEDEF_CLOSE.exec(line)?.[1] ??
    TYPE.exec(line)?.[1];
  if (simple !== undefined) return simple;
  return functionName(line);
}

/** A function declared or defined on the line, never a call or a control statement. */
function functionName(line: string): string | null {
  const qualified = QUALIFIED_DEFINITION.exec(line)?.[1];
  if (qualified !== undefined) return qualified;
  const match = FUNCTION.exec(line);
  const prefix = match?.[1];
  const name = match?.[2];
  if (prefix === undefined || name === undefined) return null;
  const firstWord = /[A-Za-z_]\w*/u.exec(prefix)?.[0] ?? '';
  if (STATEMENT_WORDS.has(firstWord) || STATEMENT_WORDS.has(name)) return null;
  return name;
}

function isSource(path: string): boolean {
  return SOURCE_EXTENSIONS.includes(splitName(path).extension);
}

/** A path's file name without its last extension, and that extension lower-cased. */
function splitName(path: string): { readonly stem: string; readonly extension: string } {
  const fileName = path.slice(path.lastIndexOf('/') + 1);
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return { stem: fileName, extension: '' };
  return { stem: fileName.slice(0, dot), extension: fileName.slice(dot).toLowerCase() };
}

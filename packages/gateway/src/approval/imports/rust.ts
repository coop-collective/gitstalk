/**
 * Rust: imports and declarations for `bean-links.ts` (`language.ts`). A file's module path
 * comes from its place under the nearest `src/` (`src/pricing/price.rs` is
 * `crate::pricing::price`; `lib.rs`, `main.rs` and `mod.rs` name their directory). `mod x;`
 * names a child module; `use` and inline paths that start with `crate`, `self` or `super`
 * name modules of the same crate, and every prefix of such a path may be a module file
 * (`crate::pricing::price` → `pricing.rs`, `pricing/mod.rs`, `pricing/price.rs`). Paths into
 * std or another crate are left out.
 */
import type { Language } from './language';
import { bySuffix, captures } from './language';

const COMMENT = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu;
const VISIBILITY = String.raw`(?:pub(?:\([^)]*\))?\s+)?`;
const MOD_DECLARATION = new RegExp(String.raw`^\s*${VISIBILITY}mod\s+(\w+)\s*;`, 'gmu');
const USE_DECLARATION = new RegExp(String.raw`^\s*${VISIBILITY}use\s+([^;]+);`, 'gmu');
const INLINE_PATH = /(?<![\w:])((?:crate|self|super)(?:::\w+)+)/gu;
const DIRECTORY_MODULE_FILES: ReadonlySet<string> = new Set(['lib.rs', 'main.rs', 'mod.rs']);

const FUNCTION = new RegExp(
  String.raw`^\s*${VISIBILITY}(?:(?:const|async|unsafe|extern(?:\s+"[^"]*")?)\s+)*fn\s+(\w+)`,
  'u',
);
const ITEM = new RegExp(
  String.raw`^\s*${VISIBILITY}(?:unsafe\s+)?(?:struct|enum|union|trait|type|const|static(?:\s+mut)?)\s+(\w+)`,
  'u',
);
const IMPL = /^\s*(?:unsafe\s+)?impl\b(.*)$/u;
const IMPL_TYPE = /^&?\s*(?:mut\s+)?(?:dyn\s+)?(?:\w+::)*(\w+)/u;

export const rust: Language = {
  id: 'rust',
  extensions: ['.rs'],
  importedFiles: (path, text, candidates) => {
    const crate = crateLocation(path);
    const code = text.replace(COMMENT, '');
    const children = captures(MOD_DECLARATION, code).flatMap((name) =>
      moduleFiles(crate.sourceRoot, [...crate.module, name]),
    );
    const used = [...captures(USE_DECLARATION, code).flatMap(useTreePaths), ...inlinePaths(code)]
      .flatMap((segments) => referencedModules(segments, crate.module))
      .flatMap((module) => matchingFiles(crate.sourceRoot, module, candidates));
    const imported = [...children.filter((file) => candidates.has(file)), ...used];
    return [...new Set(imported)].filter((file) => file !== path);
  },
  declaredName: (line) => FUNCTION.exec(line)?.[1] ?? ITEM.exec(line)?.[1] ?? implementedType(line),
};

/** Where a file sits: the crate's `src/` (with its slash, or `''`) and its module path. */
type CrateLocation = { readonly sourceRoot: string; readonly module: readonly string[] };

function crateLocation(path: string): CrateLocation {
  const segments = path.split('/');
  const fileName = segments.at(-1) ?? '';
  const source = segments.slice(0, -1).lastIndexOf('src');
  const sourceRoot = source < 0 ? '' : `${segments.slice(0, source + 1).join('/')}/`;
  const directories = segments.slice(source + 1, -1);
  const module = DIRECTORY_MODULE_FILES.has(fileName)
    ? directories
    : [...directories, fileName.replace(/\.rs$/u, '')];
  return { sourceRoot, module };
}

/** The two files a module can live in: `a/b.rs` or `a/b/mod.rs`. */
function moduleFiles(sourceRoot: string, module: readonly string[]): readonly string[] {
  const base = `${sourceRoot}${module.join('/')}`;
  return [`${base}.rs`, `${base}/mod.rs`];
}

/** The candidates a module names: exact under a known `src/`, by suffix without one. */
function matchingFiles(
  sourceRoot: string,
  module: readonly string[],
  candidates: ReadonlySet<string>,
): readonly string[] {
  const files = moduleFiles(sourceRoot, module);
  if (sourceRoot !== '') return files.filter((file) => candidates.has(file));
  return files.flatMap((file) => bySuffix(file, candidates));
}

/** The modules a crate-local path may name: every prefix, from `crate`, `self` or `super`. */
function referencedModules(
  segments: readonly string[],
  module: readonly string[],
): readonly (readonly string[])[] {
  const anchored = anchorPath(segments, module);
  if (anchored === null) return [];
  const { base, rest } = anchored;
  const firstPrefix = base.length === 0 ? 1 : 0;
  return Array.from({ length: rest.length + 1 - firstPrefix }, (_, index) => [
    ...base,
    ...rest.slice(0, index + firstPrefix),
  ]);
}

/** A path split into the module it starts from and the segments after it; null outside the crate. */
function anchorPath(
  segments: readonly string[],
  module: readonly string[],
): { readonly base: readonly string[]; readonly rest: readonly string[] } | null {
  const [first] = segments;
  if (first === 'crate') return { base: [], rest: segments.slice(1) };
  if (first === 'self') return { base: module, rest: segments.slice(1) };
  if (first !== 'super') return null;
  const notSuper = segments.findIndex((segment) => segment !== 'super');
  const depth = notSuper < 0 ? segments.length : notSuper;
  if (depth > module.length) return null;
  return { base: module.slice(0, module.length - depth), rest: segments.slice(depth) };
}

/** Each path a `use` tree names (`crate::{a, b::c}` → `crate::a`, `crate::b::c`). */
function useTreePaths(tree: string): readonly (readonly string[])[] {
  const open = tree.indexOf('{');
  if (open < 0) return [simplePath(tree)];
  const prefix = simplePath(tree.slice(0, open));
  const inner = tree.slice(open + 1, tree.lastIndexOf('}'));
  return topLevelParts(inner).flatMap((part) =>
    part.trim() === 'self' ? [prefix] : useTreePaths(part).map((rest) => prefix.concat(rest)),
  );
}

function simplePath(path: string): readonly string[] {
  return path
    .replace(/\s+as\s+\w+\s*$/u, '')
    .split('::')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && segment !== '*');
}

/** A `use` group's entries, split on the commas outside nested braces. */
function topLevelParts(group: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < group.length; index += 1) {
    const character = group[index];
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(group.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(group.slice(start));
  return parts.filter((part) => part.trim() !== '');
}

function inlinePaths(code: string): readonly (readonly string[])[] {
  return captures(INLINE_PATH, code).map((path) => path.split('::'));
}

/** The type an `impl` block is for: `impl<T> Trait for a::Name<T>` → `Name`. */
function implementedType(line: string): string | null {
  const header = IMPL.exec(line)?.[1];
  if (header === undefined) return null;
  const afterGenerics = skipGenerics(header.trim());
  const target = afterGenerics.split(/\s+for\s+/u).at(-1) ?? '';
  return IMPL_TYPE.exec(target.trim())?.[1] ?? null;
}

/** The text after a leading `<…>` parameter list, nested brackets included. */
function skipGenerics(text: string): string {
  if (!text.startsWith('<')) return text;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '<') depth += 1;
    else if (character === '>') depth -= 1;
    if (depth === 0) return text.slice(index + 1);
  }
  return '';
}

/**
 * Go: imports and declarations for `bean-links.ts` (`language.ts`). An import path names a
 * package directory, and the module root is unknown without `go.mod`, so a path resolves to
 * the `.go` files directly in the directory whose path ends with the most of its trailing
 * segments (`example.com/shop/pricing` → `internal/pricing/price.go`). Files of one package
 * share a directory and need no import, so a file also "imports" its directory's other files.
 */
import type { Language } from './language';
import { captures } from './language';

const COMMENT = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu;
const SINGLE_IMPORT = /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gmu;
const GROUPED_IMPORT = /^\s*import\s*\(([^)]*)\)/gmu;
const IMPORT_SPEC = /^\s*(?:[\w.]+\s+)?"([^"]+)"/gmu;

const FUNC = /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[([]/u;
const TYPE_CONST_VAR = /^\s*(?:type|const|var)\s+([A-Za-z_]\w*)/u;

/** Top-level standard library packages: an import under one is never a repo file. */
const STANDARD_LIBRARY: ReadonlySet<string> = new Set([
  'archive',
  'bufio',
  'builtin',
  'bytes',
  'cmp',
  'compress',
  'container',
  'context',
  'crypto',
  'database',
  'debug',
  'embed',
  'encoding',
  'errors',
  'expvar',
  'flag',
  'fmt',
  'go',
  'hash',
  'html',
  'image',
  'index',
  'io',
  'iter',
  'log',
  'maps',
  'math',
  'mime',
  'net',
  'os',
  'path',
  'plugin',
  'reflect',
  'regexp',
  'runtime',
  'slices',
  'sort',
  'strconv',
  'strings',
  'sync',
  'syscall',
  'testing',
  'text',
  'time',
  'unicode',
  'unique',
  'unsafe',
]);

export const go: Language = {
  id: 'go',
  extensions: ['.go'],
  importedFiles: (path, text, candidates) => {
    const goFiles = [...candidates].filter(
      (candidate) => isGoFile(candidate) && candidate !== path,
    );
    const imported = importPaths(text).flatMap((importPath) => packageFiles(importPath, goFiles));
    const samePackage = goFiles.filter((candidate) => directoryOf(candidate) === directoryOf(path));
    return [...new Set([...samePackage, ...imported])];
  },
  declaredName: (line) => FUNC.exec(line)?.[1] ?? TYPE_CONST_VAR.exec(line)?.[1] ?? null,
};

/** Every import path of a file, from single and grouped (`import ( … )`) declarations. */
function importPaths(text: string): readonly string[] {
  const code = text.replace(COMMENT, '');
  const grouped = captures(GROUPED_IMPORT, code).flatMap((body) => captures(IMPORT_SPEC, body));
  return [...captures(SINGLE_IMPORT, code), ...grouped];
}

/** The files of the package directory that matches most of an import path's trailing segments. */
function packageFiles(importPath: string, goFiles: readonly string[]): readonly string[] {
  const segments = importPath.split('/').filter((segment) => segment !== '');
  if (isStandardLibrary(segments)) return [];
  const scored = goFiles.map((file) => ({
    file,
    shared: sharedTrailingSegments(directoryOf(file).split('/'), segments),
  }));
  const best = Math.max(0, ...scored.map(({ shared }) => shared));
  return best === 0 ? [] : scored.filter(({ shared }) => shared === best).map(({ file }) => file);
}

function isStandardLibrary(segments: readonly string[]): boolean {
  const [first] = segments;
  return first === undefined || (!first.includes('.') && STANDARD_LIBRARY.has(first));
}

function sharedTrailingSegments(
  directory: readonly string[],
  importPath: readonly string[],
): number {
  let shared = 0;
  while (
    shared < directory.length &&
    shared < importPath.length &&
    directory[directory.length - 1 - shared] === importPath[importPath.length - 1 - shared]
  ) {
    shared += 1;
  }
  return shared;
}

function isGoFile(path: string): boolean {
  return path.toLowerCase().endsWith('.go');
}

function directoryOf(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

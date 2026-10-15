/**
 * What `bean-links.ts` needs from a programming language to link two beans' changes
 * (`docs/claude-opus/32-approval-rules.md` §4.1): which of the other bean's changed files a
 * file imports, and the name a line declares. One module per language family in this
 * directory, each registered in `languages.ts`. Heuristics on purpose: they read one file's
 * text with patterns, never a build system, and point Clef at a contract; they never decide.
 */

/** One language family's import and declaration reading. */
export type Language = {
  /** A short id for tests and logs: `javascript`, `python`, … */
  readonly id: string;
  /** Lower-case file extensions with the dot (`.py`); a path matches on its last extension. */
  readonly extensions: readonly string[];
  /**
   * The paths among `candidates` (the other bean's changed files, repo-relative) that the
   * file at `path`, whose text is `text`, imports. Unresolvable imports are left out.
   */
  importedFiles(path: string, text: string, candidates: ReadonlySet<string>): readonly string[];
  /** The name a line declares (a function, method, class, constant or type), or null. */
  declaredName(line: string): string | null;
};

/** The repo path a relative specifier names from a file (`..` past the root: null). */
export function joinPath(fromFile: string, specifier: string): string | null {
  const parts = fromFile.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join('/');
}

/**
 * The candidates whose path ends with `suffix` at a path boundary (`com/shop/Price.java`
 * matches `src/main/java/com/shop/Price.java`): how most languages' module names map to files
 * when the source root is unknown.
 */
export function bySuffix(suffix: string, candidates: ReadonlySet<string>): readonly string[] {
  return [...candidates].filter((path) => path === suffix || path.endsWith(`/${suffix}`));
}

/** Every capture group 1 of a global pattern in a text. */
export function captures(pattern: RegExp, text: string): readonly string[] {
  return [...text.matchAll(pattern)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

const GENERIC_DECLARATION =
  /^\s*(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:function\*?\s+|(?:const|let|var)\s+|class\s+|interface\s+|type\s+|enum\s+|def\s+|fn\s+|func\s+)([A-Za-z_$][\w$]*)/u;

/**
 * A declaration by keyword (`function`, `const`, `class`, `def`, `fn`, `func`, …): the reading
 * every language started with, and the default of one that has nothing better.
 */
export function genericDeclaredName(line: string): string | null {
  return GENERIC_DECLARATION.exec(line)?.[1] ?? null;
}

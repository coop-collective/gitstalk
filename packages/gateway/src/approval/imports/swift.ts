/**
 * Swift: imports and declarations for `bean-links.ts` (`language.ts`). Swift imports
 * modules, not files, so `import ShopCore` links the files under a `ShopCore` directory
 * (`Sources/ShopCore/…`), `import struct ShopCore.Price` only `Price.swift` there, and files
 * of one module see each other without an import, so a file of the same module
 * (`Sources/<Module>/`, or the same directory outside a package) whose stem or the type it
 * extends (`Price+Format.swift`) appears as an identifier is linked too.
 */
import type { Language } from './language';

export const swift: Language = {
  id: 'swift',
  extensions: ['.swift'],
  importedFiles: (path, text, candidates) => {
    const sources = [...candidates].filter(
      (candidate) => isSwiftFile(candidate) && candidate !== path,
    );
    const code = withoutComments(text);
    const identifiers = new Set(code.match(IDENTIFIER_PATTERN) ?? []);
    const imports = importDeclarations(code);
    const ownModule = moduleRootOf(path);
    return sources.filter(
      (candidate) =>
        imports.some((declaration) => isImportedBy(declaration, candidate)) ||
        (moduleRootOf(candidate) === ownModule &&
          typeNames(candidate).some((name) => identifiers.has(name))),
    );
  },
  declaredName: (line) => DECLARATION.exec(line)?.[1] ?? null,
};

/** `import ShopCore` (`symbol` null) or `import struct ShopCore.Price`. */
type ImportDeclaration = { readonly module: string; readonly symbol: string | null };

const IDENTIFIER_PATTERN = /[A-Za-z_]\w*/gu;
const IMPORT_DECLARATION =
  /^\s*(?:@\w+(?:\([^)]*\))?\s+)*import\s+(?:(typealias|struct|class|enum|protocol|let|var|func|actor)\s+)?([A-Za-z_]\w*)((?:\.[A-Za-z_]\w*)*)/gmu;

const ATTRIBUTES = '(?:@\\w+(?:\\([^)]*\\))?\\s+)*';
const MODIFIERS =
  '(?:(?:public|private|fileprivate|internal|open|package|static|final|override|mutating|nonmutating|lazy|weak|unowned|indirect|convenience|required|dynamic|nonisolated|distributed|optional|prefix|postfix|infix)(?:\\([^)]*\\))?\\s+|class\\s+(?=(?:func|var|let|override|final)\\b))*';
const DECLARATION = new RegExp(
  `^\\s*${ATTRIBUTES}${MODIFIERS}(?:func|class|struct|enum|protocol|extension|actor|typealias|let|var)\\s+\`?([A-Za-z_]\\w*)`,
  'u',
);

function importDeclarations(code: string): readonly ImportDeclaration[] {
  return [...code.matchAll(IMPORT_DECLARATION)].flatMap(([, kind, module, path]) => {
    if (module === undefined) return [];
    const symbol = kind === undefined ? null : (path?.split('.').at(-1) ?? null);
    return [{ module, symbol: symbol === '' ? null : symbol }];
  });
}

function isImportedBy(declaration: ImportDeclaration, candidate: string): boolean {
  const directories = candidate.split('/').slice(0, -1);
  if (!directories.includes(declaration.module)) return false;
  return declaration.symbol === null || typeNames(candidate).includes(declaration.symbol);
}

/**
 * The directory that holds a file's module: `Sources/<Module>` or `Tests/<Module>` in a
 * Swift package, else the file's own directory (an Xcode group).
 */
function moduleRootOf(path: string): string {
  const directories = path.split('/').slice(0, -1);
  const packageRoot = directories.findIndex(
    (segment, index) =>
      (segment === 'Sources' || segment === 'Tests') && index + 1 < directories.length,
  );
  const depth = packageRoot < 0 ? directories.length : packageRoot + 2;
  return directories.slice(0, depth).join('/');
}

/** The type names a file is named after: `Price.swift` and `Price+Format.swift` (`Price`). */
function typeNames(path: string): readonly string[] {
  const stem = (path.split('/').at(-1) ?? '').replace(/\.swift$/iu, '');
  const extended = stem.split('+')[0] ?? stem;
  return [...new Set([stem, extended])].filter((name) => /^[A-Za-z_]\w*$/u.test(name));
}

function isSwiftFile(path: string): boolean {
  return path.toLowerCase().endsWith('.swift');
}

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/\/\/.*$/gmu, '');
}

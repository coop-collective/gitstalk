/**
 * JavaScript and TypeScript: relative `import … from`, `export … from`, side-effect `import`,
 * `require()` and `import()`, resolved the way TypeScript resolves them
 * (`repo/import-closure.ts`), a TypeScript file's import of a module with a declaration file
 * to that `.d.ts` (TypeScript reads it before a `.js`), and declarations by keyword. A
 * `const`, `let` or `var` counts only at the top level: one inside a function is a local
 * (`const res = …`), whose name says nothing about a contract.
 */
import { importSpecifiers, resolveImport } from '../../repo/import-closure';
import type { Language } from './language';
import { genericDeclaredName, joinPath } from './language';

const TYPESCRIPT = /\.(?:[cm]?ts|tsx)$/u;
const LOCAL_BINDING = /^\s+(?:const|let|var)\s/u;

export const javascript: Language = {
  id: 'javascript',
  extensions: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'],
  importedFiles: (path, text, candidates) =>
    importSpecifiers(text).flatMap((specifier) => {
      const target =
        (TYPESCRIPT.test(path) ? declarationFile(path, specifier, candidates) : null) ??
        resolveImport(path, specifier, candidates);
      return target === null ? [] : [target];
    }),
  declaredName: (line) => (LOCAL_BINDING.test(line) ? null : genericDeclaredName(line)),
};

/** The `.d.ts` a TypeScript import names, when that file is a candidate. */
function declarationFile(
  path: string,
  specifier: string,
  candidates: ReadonlySet<string>,
): string | null {
  const target = joinPath(path, specifier);
  if (target === null) return null;
  const stem = target.replace(/\.[cm]?js$/u, '');
  return [`${stem}.d.ts`, `${stem}/index.d.ts`].find((file) => candidates.has(file)) ?? null;
}

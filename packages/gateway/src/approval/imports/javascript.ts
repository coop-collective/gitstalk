/**
 * JavaScript and TypeScript: relative `import … from`, `export … from`, side-effect `import`,
 * `require()` and `import()`, resolved the way TypeScript resolves them
 * (`repo/import-closure.ts`), and declarations by keyword.
 */
import { importSpecifiers, resolveImport } from '../../repo/import-closure';
import type { Language } from './language';
import { genericDeclaredName } from './language';

export const javascript: Language = {
  id: 'javascript',
  extensions: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'],
  importedFiles: (path, text, candidates) =>
    importSpecifiers(text).flatMap((specifier) => {
      const target = resolveImport(path, specifier, candidates);
      return target === null ? [] : [target];
    }),
  declaredName: genericDeclaredName,
};

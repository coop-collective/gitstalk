/**
 * Go: imports and declarations for `bean-links.ts` (`language.ts`). Not built yet: no
 * imports, and declarations by keyword only.
 */
import type { Language } from './language';
import { genericDeclaredName } from './language';

export const go: Language = {
  id: 'go',
  extensions: ['.go'],
  importedFiles: () => [],
  declaredName: genericDeclaredName,
};

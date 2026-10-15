/**
 * Swift: imports and declarations for `bean-links.ts` (`language.ts`). Not built yet: no
 * imports, and declarations by keyword only.
 */
import type { Language } from './language';
import { genericDeclaredName } from './language';

export const swift: Language = {
  id: 'swift',
  extensions: ['.swift'],
  importedFiles: () => [],
  declaredName: genericDeclaredName,
};

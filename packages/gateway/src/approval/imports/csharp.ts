/**
 * C#: imports and declarations for `bean-links.ts` (`language.ts`). Not built yet: no
 * imports, and declarations by keyword only.
 */
import type { Language } from './language';
import { genericDeclaredName } from './language';

export const csharp: Language = {
  id: 'csharp',
  extensions: ['.cs'],
  importedFiles: () => [],
  declaredName: genericDeclaredName,
};

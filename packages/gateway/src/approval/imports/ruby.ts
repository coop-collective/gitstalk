/**
 * Ruby: imports and declarations for `bean-links.ts` (`language.ts`). Not built yet: no
 * imports, and declarations by keyword only.
 */
import type { Language } from './language';
import { genericDeclaredName } from './language';

export const ruby: Language = {
  id: 'ruby',
  extensions: ['.rb'],
  importedFiles: () => [],
  declaredName: genericDeclaredName,
};

/**
 * Kotlin: imports and declarations for `bean-links.ts` (`language.ts`). Imports read as in Java
 * (`java.ts`), but a Kotlin file need not be named after its class and may hold top-level
 * functions, so an import that finds no file named after its class, or names a lower-case
 * member (`import com.shop.price`), falls back to any Kotlin file in the package directory.
 * Kotlin imports Java classes too, so a `.java` file named after the class counts.
 */
import type { Language } from './language';
import { bySuffix, captures } from './language';
import { filesInDirectory, jvmImportedFiles, jvmName } from './java';

export const kotlin: Language = {
  id: 'kotlin',
  extensions: ['.kt', '.kts'],
  importedFiles: (path, text, candidates) =>
    jvmImportedFiles(path, text, {
      candidates,
      imports: captures(KOTLIN_IMPORT, text).map((name) => name.replaceAll('`', '')),
      resolve: resolveKotlinImport,
    }),
  declaredName: kotlinDeclaredName,
};

const KOTLIN_IMPORT = /^\s*import\s+([\w.`]+(?:\.\*)?)/gmu;
const KOTLIN_EXTENSIONS = ['.kt', '.kts'];

function resolveKotlinImport(name: string, candidates: ReadonlySet<string>): readonly string[] {
  const { packagePath, classPath } = jvmName(name);
  if (classPath !== null) {
    const named = [
      ...bySuffix(`${classPath}.kt`, candidates),
      ...bySuffix(`${classPath}.java`, candidates),
    ];
    if (named.length > 0) return named;
  }
  return filesInDirectory(packagePath, KOTLIN_EXTENSIONS, candidates);
}

const MODIFIERS = String.raw`(?:(?:public|private|internal|protected|open|abstract|final|override|suspend|inline|noinline|crossinline|data|sealed|enum|annotation|inner|value|const|lateinit|operator|infix|tailrec|external|expect|actual|companion|fun)\s+)*`;
const ANNOTATIONS = String.raw`(?:@[\w.:]+(?:\([^)]*\))?\s+)*`;
const NAME = String.raw`([A-Za-z_]\w*)`;

const KOTLIN_FUNCTION = new RegExp(
  String.raw`^\s*${ANNOTATIONS}${MODIFIERS}fun\s+(?:<[^(]*?>\s*)?(?:[^\s(]+\.)?${NAME}\s*\(`,
  'u',
);
const KOTLIN_TYPE = new RegExp(
  String.raw`^\s*${ANNOTATIONS}${MODIFIERS}(?:class|object|interface|typealias)\s+${NAME}`,
  'u',
);
const KOTLIN_PROPERTY = new RegExp(
  String.raw`^\s*${ANNOTATIONS}${MODIFIERS}(?:val|var)\s+(?:<[^>]*>\s*)?(?:[^\s(=:]+\.)?${NAME}`,
  'u',
);

/** A `fun`, `class`, `object`, `interface`, `typealias`, `val`, `var` or `const val`. */
function kotlinDeclaredName(line: string): string | null {
  for (const pattern of [KOTLIN_FUNCTION, KOTLIN_TYPE, KOTLIN_PROPERTY]) {
    const name = pattern.exec(line)?.[1];
    if (name !== undefined) return name;
  }
  return null;
}

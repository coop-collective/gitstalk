/**
 * Java: imports and declarations for `bean-links.ts` (`language.ts`). An import names a class
 * by package path (`import com.shop.Price;` is `com/shop/Price.java` under any source root),
 * a static import names a member of one, a wildcard names a package directory, and a class in
 * the same package needs no import at all, so a sibling file whose class the text names counts.
 * The JVM helpers here are shared with `kotlin.ts`.
 */
import type { Language } from './language';
import { bySuffix, captures } from './language';

export const java: Language = {
  id: 'java',
  extensions: ['.java'],
  importedFiles: (path, text, candidates) =>
    jvmImportedFiles(path, text, {
      candidates,
      imports: captures(JAVA_IMPORT, text),
      resolve: resolveJavaImport,
    }),
  declaredName: javaDeclaredName,
};

/** What `jvmImportedFiles` needs beyond the file: its imports and how one resolves. */
export type JvmImportReading = {
  readonly candidates: ReadonlySet<string>;
  /** Dotted import names as written, a wildcard ending in `.*`. */
  readonly imports: readonly string[];
  readonly resolve: (name: string, candidates: ReadonlySet<string>) => readonly string[];
};

/** A dotted import split at its class: the package and the class path, if any segment is one. */
export type JvmName = {
  readonly packagePath: string;
  /** `com/shop/Price` for `com.shop.Price.amount`; null when no segment is capitalised. */
  readonly classPath: string | null;
  readonly isWildcard: boolean;
};

/**
 * The candidates a JVM file imports: each import's resolution, plus same-package files (the
 * file's own directory) whose class name appears as an identifier in the text. Never the file.
 */
export function jvmImportedFiles(
  path: string,
  text: string,
  reading: JvmImportReading,
): readonly string[] {
  const others = new Set([...reading.candidates].filter((candidate) => candidate !== path));
  const imported = reading.imports.flatMap((name) => reading.resolve(name, others));
  return [...new Set([...imported, ...samePackageFiles(path, text, others)])];
}

/**
 * Splits a dotted name at its first capitalised segment, the Java convention for a class
 * (`com.shop.Price.Inner` is class path `com/shop/Price` in package `com/shop`).
 */
export function jvmName(dotted: string): JvmName {
  const isWildcard = dotted.endsWith('.*');
  const segments = (isWildcard ? dotted.slice(0, -2) : dotted).split('.');
  const classIndex = segments.findIndex((segment) => /^[A-Z]/u.test(segment));
  if (classIndex < 0) {
    const packageSegments = isWildcard ? segments : segments.slice(0, -1);
    return { packagePath: packageSegments.join('/'), classPath: null, isWildcard };
  }
  return {
    packagePath: segments.slice(0, classIndex).join('/'),
    classPath: segments.slice(0, classIndex + 1).join('/'),
    isWildcard,
  };
}

/** The candidates with one of `extensions` directly in a directory under any source root. */
export function filesInDirectory(
  directory: string,
  extensions: readonly string[],
  candidates: ReadonlySet<string>,
): readonly string[] {
  return [...candidates].filter((candidate) => {
    const parent = directoryOf(candidate);
    const isInDirectory = parent === directory || parent.endsWith(`/${directory}`);
    return isInDirectory && extensions.some((extension) => candidate.endsWith(extension));
  });
}

const JAVA_IMPORT = /^\s*import\s+(?:static\s+)?([\w$.]+(?:\.\*)?)\s*;/gmu;
const JAVA_EXTENSIONS = ['.java'];

function resolveJavaImport(name: string, candidates: ReadonlySet<string>): readonly string[] {
  const { packagePath, classPath, isWildcard } = jvmName(name);
  if (classPath !== null) return bySuffix(`${classPath}.java`, candidates);
  return isWildcard ? filesInDirectory(packagePath, JAVA_EXTENSIONS, candidates) : [];
}

/** Candidates beside the file whose file stem the text uses as an identifier. */
function samePackageFiles(
  path: string,
  text: string,
  candidates: ReadonlySet<string>,
): readonly string[] {
  const directory = directoryOf(path);
  const identifiers = new Set(text.match(/[A-Za-z_$][\w$]*/gu) ?? []);
  return [...candidates].filter(
    (candidate) => directoryOf(candidate) === directory && identifiers.has(stemOf(candidate)),
  );
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function stemOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.indexOf('.');
  return dot < 0 ? name : name.slice(0, dot);
}

const ANNOTATIONS = String.raw`(?:@[\w$.]+(?:\([^)]*\))?\s+)*`;
const MODIFIERS = String.raw`((?:(?:public|protected|private|abstract|static|final|sealed|non-sealed|strictfp|default|synchronized|native|transient|volatile)\s+)*)`;
const NAME = String.raw`([A-Za-z_$][\w$]*)`;
const TYPE = String.raw`([\w$.]+(?:<[^()=;]*?>)?(?:\[\])*)`;

const JAVA_TYPE_DECLARATION = new RegExp(
  String.raw`^\s*${ANNOTATIONS}${MODIFIERS}(?:@interface|class|interface|enum|record)\s+${NAME}`,
  'u',
);
const JAVA_METHOD = new RegExp(
  String.raw`^\s*${ANNOTATIONS}${MODIFIERS}(?:<[^()]*?>\s+)?${TYPE}\s+${NAME}\s*\(`,
  'u',
);
const JAVA_CONSTRUCTOR = new RegExp(
  String.raw`^\s*${ANNOTATIONS}${MODIFIERS}(?:<[^()]*?>\s+)?${NAME}\s*\(`,
  'u',
);
const JAVA_FIELD = new RegExp(
  String.raw`^\s*${ANNOTATIONS}${MODIFIERS}${TYPE}\s+${NAME}\s*[=;]`,
  'u',
);

/** Words that can sit where a return type or a method name would, in a statement. */
const STATEMENT_WORDS = new Set([
  'return',
  'new',
  'throw',
  'else',
  'case',
  'yield',
  'assert',
  'package',
  'import',
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'synchronized',
  'super',
  'this',
  'do',
  'try',
]);

/** A class, interface, enum, record, method, constructor or `static final` constant. */
function javaDeclaredName(line: string): string | null {
  const type = JAVA_TYPE_DECLARATION.exec(line);
  if (type?.[2] !== undefined) return type[2];
  const method = JAVA_METHOD.exec(line);
  if (method?.[2] !== undefined && method[3] !== undefined) {
    const isStatement = STATEMENT_WORDS.has(method[2]) || STATEMENT_WORDS.has(method[3]);
    if (!isStatement) return method[3];
  }
  const constructor = JAVA_CONSTRUCTOR.exec(line);
  if (constructor?.[1] && constructor[2] !== undefined && !STATEMENT_WORDS.has(constructor[2])) {
    return constructor[2];
  }
  const field = JAVA_FIELD.exec(line);
  const isConstant = /\bstatic\b/u.test(field?.[1] ?? '') && /\bfinal\b/u.test(field?.[1] ?? '');
  return isConstant && field?.[3] !== undefined ? field[3] : null;
}

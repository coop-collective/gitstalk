/**
 * Python: imports and declarations for `bean-links.ts` (`language.ts`). Relative imports
 * (`from .price import price`, `from .. import pkg`) resolve exactly from the importing file;
 * absolute ones (`import shop.price`, `from shop.price import price`) by path suffix, since the
 * source root (`src/`, the repo root, …) is unknown. A module is `shop/price.py` or
 * `shop/price/__init__.py`, and each name a `from` import brings in may itself be a submodule.
 */
import type { Language } from './language';
import { bySuffix, joinPath } from './language';

export const python: Language = {
  id: 'python',
  extensions: ['.py'],
  importedFiles: (path, text, candidates) => {
    const targets = importedModules(codeOf(text)).flatMap((module) =>
      moduleFiles(path, module, candidates),
    );
    return [...new Set(targets)].filter((target) => target !== path);
  },
  declaredName,
};

/** A module an import names: leading dots (0 for absolute) and its slash-joined path. */
type ModuleName = { readonly dots: number; readonly path: string };

const STRING_OR_COMMENT =
  /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|#[^\n]*/gu;
const LINE_CONTINUATION = /\\\n/gu;
const FROM_IMPORT = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n;]*)/gmu;
const PLAIN_IMPORT = /^[ \t]*import[ \t]+([^\n;]+)/gmu;
const LEADING_NAME = /^[\w.]+/u;

const FUNCTION_OR_CLASS = /^\s*(?:async\s+def|def|class)\s+([A-Za-z_]\w*)/u;
const UPPER_CASE_CONSTANT = /^([A-Z_][A-Z0-9_]*)\s*(?::[^=]*)?=(?!=)/u;
const ANNOTATED_NAME = /^([A-Za-z_]\w*)\s*:[^=]+=(?!=)/u;
/** Keywords that a column-0 `name: … = …` line can start with without declaring anything. */
const COLON_KEYWORDS: ReadonlySet<string> = new Set(['else', 'try', 'finally', 'lambda']);

/** `def`/`async def`/`class` at any depth, and module-level UPPER_CASE or annotated names. */
function declaredName(line: string): string | null {
  const definition = FUNCTION_OR_CLASS.exec(line)?.[1];
  if (definition !== undefined) return definition;
  const constant = UPPER_CASE_CONSTANT.exec(line)?.[1];
  if (constant !== undefined) return constant;
  const annotated = ANNOTATED_NAME.exec(line)?.[1];
  return annotated === undefined || COLON_KEYWORDS.has(annotated) ? null : annotated;
}

/** The text with strings and comments blanked (newlines kept) and continuations joined. */
function codeOf(text: string): string {
  return text
    .replace(STRING_OR_COMMENT, (literal) => literal.replace(/[^\n]/gu, ''))
    .replace(LINE_CONTINUATION, ' ');
}

function importedModules(code: string): readonly ModuleName[] {
  const fromImports = [...code.matchAll(FROM_IMPORT)].flatMap((match) => {
    const dots = (match[1] ?? '').length;
    const base = slashed(match[2] ?? '');
    const names = importedNames(match[3] ?? '').map((name) => joined(base, slashed(name)));
    return [base, ...names].map((path) => ({ dots, path }));
  });
  const plainImports = [...code.matchAll(PLAIN_IMPORT)].flatMap((match) =>
    importedNames(match[1] ?? '').map((name) => ({ dots: 0, path: slashed(name) })),
  );
  return [...fromImports, ...plainImports].filter((module) => module.dots > 0 || module.path);
}

/** `a, b as c` or `(a,\n b)`: the names before any `as`, without `*`. */
function importedNames(list: string): readonly string[] {
  return list
    .replace(/[()]/gu, '')
    .split(',')
    .flatMap((item) => LEADING_NAME.exec(item.trim())?.[0] ?? []);
}

function moduleFiles(
  fromFile: string,
  module: ModuleName,
  candidates: ReadonlySet<string>,
): readonly string[] {
  if (module.dots === 0) {
    return fileNames(module.path).flatMap((suffix) => bySuffix(suffix, candidates));
  }
  const specifier = [...Array<string>(module.dots - 1).fill('..'), module.path].join('/');
  const directory = joinPath(fromFile, specifier);
  if (directory === null) return [];
  return fileNames(directory).filter((file) => candidates.has(file));
}

/** The files a module path can be: a module file or a package's `__init__.py`. */
function fileNames(modulePath: string): readonly string[] {
  return modulePath === '' ? ['__init__.py'] : [`${modulePath}.py`, `${modulePath}/__init__.py`];
}

function slashed(dotted: string): string {
  return dotted.split('.').filter(Boolean).join('/');
}

function joined(base: string, name: string): string {
  return base === '' ? name : `${base}/${name}`;
}

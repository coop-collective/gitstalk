/**
 * C#: imports and declarations for `bean-links.ts` (`language.ts`). C# imports namespaces,
 * not files, so a `using` links the files whose directory spells the namespace
 * (`using Shop.Pricing;` → `src/Shop/Pricing/Price.cs` or `Shop.Pricing/Price.cs`), a
 * `using static` or alias links the type's own file, and because files often share a
 * namespace and need no `using` at all, a file whose stem (`Price.cs`) appears as an
 * identifier in the text is linked too.
 */
import type { Language } from './language';

export const csharp: Language = {
  id: 'csharp',
  extensions: ['.cs'],
  importedFiles: (path, text, candidates) => {
    const sources = [...candidates].filter(
      (candidate) => isCSharpFile(candidate) && candidate !== path,
    );
    const code = withoutComments(text);
    const identifiers = new Set(code.match(IDENTIFIER_PATTERN) ?? []);
    const usings = usingDirectives(code);
    return sources.filter(
      (candidate) =>
        usings.some((using) => isImportedBy(using, candidate)) ||
        typeNames(candidate).some((name) => identifiers.has(name)),
    );
  },
  declaredName: (line) =>
    TYPE_DECLARATION.exec(line)?.[1] ??
    CONSTANT_DECLARATION.exec(line)?.[1] ??
    memberName(MODIFIED_MEMBER.exec(line)) ??
    CONSTRUCTOR_DECLARATION.exec(line)?.[1] ??
    memberName(BARE_METHOD.exec(line)),
};

/** A `using` directive: a namespace, or a type (`using static`, `using Alias = …`). */
type UsingDirective = { readonly kind: 'namespace' | 'type' | 'either'; readonly name: string };

const IDENTIFIER_PATTERN = /[A-Za-z_]\w*/gu;
const USING_DIRECTIVE =
  /^\s*(?:global\s+)?using\s+(static\s+)?(?:(@?[A-Za-z_]\w*)\s*=\s*)?([A-Za-z_][\w.]*)\s*;/gmu;

const MODIFIERS =
  '(?:\\[[^\\]]*\\]\\s*)*(?:(?:public|private|protected|internal|static|abstract|sealed|partial|readonly|virtual|override|async|extern|unsafe|new|file|required|volatile|event|delegate)\\s+)';
const TYPE = '[A-Za-z_][\\w.]*(?:<[^;()=]*>)?(?:\\[[,\\s]*\\])*\\??';
const NAME = '@?([A-Za-z_]\\w*)';

const TYPE_DECLARATION = new RegExp(
  `^\\s*${MODIFIERS}*(?:class|struct|interface|enum|record(?:\\s+(?:class|struct))?)\\s+${NAME}`,
  'u',
);
const CONSTANT_DECLARATION = new RegExp(`^\\s*${MODIFIERS}*const\\s+${TYPE}\\s+${NAME}\\s*=`, 'u');
/** A method, property or field after at least one modifier: `public int Total { get; }`. */
const MODIFIED_MEMBER = new RegExp(
  `^\\s*${MODIFIERS}+(?:ref\\s+)?(${TYPE})\\s+${NAME}\\s*(?:<[^()]*>\\s*)?(?:\\(|\\{|=>|=|;)`,
  'u',
);
/** `public Price(decimal amount)`; `new Price(…)` alone on a line is a call. */
const CONSTRUCTOR_DECLARATION = new RegExp(`^\\s*(?!new\\s)${MODIFIERS}+${NAME}\\s*\\(`, 'u');
/** A method with a return type and no modifier (an interface member, a local function). */
const BARE_METHOD = new RegExp(`^\\s*(${TYPE})\\s+${NAME}\\s*(?:<[^()]*>\\s*)?\\(`, 'u');

/** Words that start statements and expressions, never a member's type or name. */
const KEYWORDS: ReadonlySet<string> = new Set([
  'await',
  'case',
  'catch',
  'else',
  'fixed',
  'for',
  'foreach',
  'goto',
  'if',
  'is',
  'lock',
  'nameof',
  'new',
  'return',
  'sizeof',
  'switch',
  'throw',
  'typeof',
  'using',
  'when',
  'while',
  'yield',
]);

/** The member name of a `(type) (name)` match, unless either is a statement keyword. */
function memberName(match: RegExpExecArray | null): string | null {
  const [, type, name] = match ?? [];
  if (type === undefined || name === undefined) return null;
  return KEYWORDS.has(type) || KEYWORDS.has(name) ? null : name;
}

function usingDirectives(code: string): readonly UsingDirective[] {
  return [...code.matchAll(USING_DIRECTIVE)].flatMap(
    ([, isStatic, alias, name]): UsingDirective[] => {
      if (name === undefined) return [];
      if (isStatic !== undefined) return [{ kind: 'type', name }];
      return [{ kind: alias === undefined ? 'namespace' : 'either', name }];
    },
  );
}

function isImportedBy(using: UsingDirective, candidate: string): boolean {
  const directory = directoryOf(candidate);
  const namespaceNamesDirectory = isNamespaceDirectory(using.name, directory);
  if (using.kind === 'namespace') return namespaceNamesDirectory;
  const segments = using.name.split('.');
  const typeName = segments.at(-1) ?? '';
  const typeIsFile =
    typeNames(candidate).includes(typeName) &&
    isNamespaceDirectory(segments.slice(0, -1).join('.'), directory);
  return typeIsFile || (using.kind === 'either' && namespaceNamesDirectory);
}

/**
 * Whether a directory spells a namespace: `Shop.Pricing` is `…/Shop/Pricing`, a dotted
 * project directory `…/Shop.Pricing`, or a mix of both `…/Shop/Pricing` under `Shop`.
 */
function isNamespaceDirectory(namespace: string, directory: string): boolean {
  if (namespace === '') return false;
  const segments = namespace.split('.');
  return segments.some((_, split) => {
    const project = segments.slice(0, split + 1).join('.');
    const folders = segments.slice(split + 1);
    const suffix = [project, ...folders].join('/');
    return directory === suffix || directory.endsWith(`/${suffix}`);
  });
}

/** The type names a file is named after: `Price.cs` and `Order.Designer.cs` (`Order`). */
function typeNames(path: string): readonly string[] {
  const stem = (path.split('/').at(-1) ?? '').replace(/\.cs$/iu, '');
  const first = stem.split('.')[0] ?? stem;
  return [...new Set([stem, first])].filter((name) => /^[A-Za-z_]\w*$/u.test(name));
}

function directoryOf(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

function isCSharpFile(path: string): boolean {
  return path.toLowerCase().endsWith('.cs');
}

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/\/\/.*$/gmu, '');
}

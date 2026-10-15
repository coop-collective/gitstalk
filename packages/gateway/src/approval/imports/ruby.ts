/**
 * Ruby: imports and declarations for `bean-links.ts` (`language.ts`). `require_relative`
 * resolves exactly from the requiring file; `require`, `load` and `autoload` name a path on the
 * load path (usually `lib/`), so they resolve by suffix: `require 'shop/price'` is any
 * `…/shop/price.rb`. Specifiers built at run time (`File.join`, `#{}`) are left out.
 */
import type { Language } from './language';
import { bySuffix, joinPath } from './language';

export const ruby: Language = {
  id: 'ruby',
  extensions: ['.rb'],
  importedFiles: (path, text, candidates) => {
    const targets = requires(text.replace(BLOCK_COMMENT, '')).flatMap((required) =>
      requiredFiles(path, required, candidates),
    );
    return [...new Set(targets)].filter((target) => target !== path);
  },
  declaredName,
};

type Require = { readonly kind: 'relative' | 'load-path'; readonly specifier: string };

const BLOCK_COMMENT = /^=begin\b[\s\S]*?^=end\b[^\n]*/gmu;
/** At a line's start, so commented-out requires (`# require …`) never match. */
const REQUIRE =
  /^[ \t]*(require_relative|require|load|autoload)\b[ \t(]*(?::\w+[ \t]*,[ \t]*)?(['"])([^'"\n]+)\2/gmu;

const METHOD = /^\s*def\s+(?:(?:self|[A-Za-z_]\w*)\.)?([A-Za-z_]\w*)/u;
const CLASS_OR_MODULE = /^\s*(?:class|module)\s+(?:[A-Z]\w*::)*([A-Z]\w*)/u;
const CONSTANT = /^\s*([A-Z]\w*)\s*(?:\|\|)?=(?![=~>])/u;

/**
 * `def name` / `def self.name` (without a trailing `?`, `!` or `=`, as callers' identifiers
 * read), the last segment of `class`/`module A::B`, and `CONSTANT =`.
 */
function declaredName(line: string): string | null {
  return (
    METHOD.exec(line)?.[1] ?? CLASS_OR_MODULE.exec(line)?.[1] ?? CONSTANT.exec(line)?.[1] ?? null
  );
}

function requires(code: string): readonly Require[] {
  return [...code.matchAll(REQUIRE)].flatMap((match): Require[] => {
    const specifier = match[3] ?? '';
    if (specifier.includes('#{')) return [];
    const kind = match[1] === 'require_relative' ? 'relative' : 'load-path';
    return [{ kind, specifier }];
  });
}

function requiredFiles(
  fromFile: string,
  required: Require,
  candidates: ReadonlySet<string>,
): readonly string[] {
  const file = required.specifier.endsWith('.rb') ? required.specifier : `${required.specifier}.rb`;
  if (required.kind === 'load-path') return bySuffix(file.replace(/^\.\//u, ''), candidates);
  const target = joinPath(fromFile, file);
  return target !== null && candidates.has(target) ? [target] : [];
}

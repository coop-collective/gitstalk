/**
 * PHP: imports and declarations for `bean-links.ts` (`language.ts`). `require`/`include` of a
 * string literal resolves against the file (`__DIR__ . '/x.php'` too), then by suffix. A `use`
 * of a class, function or constant maps PSR-4 style: `App\Pricing\Price` is a file ending in
 * `Pricing/Price.php`, under whatever root (`src/`, `app/`) the autoloader maps `App\` to.
 */
import type { Language } from './language';
import { bySuffix, joinPath } from './language';

const REQUIRE =
  /\b(?:require|include)(?:_once)?\s*\(?\s*(?:(?:__DIR__|dirname\s*\(\s*__FILE__\s*\))\s*\.\s*)?(['"])([^'"\n]+)\1/gu;
const USE = /^\s*use\s+(?:function\s+|const\s+)?([\w\\\s,{}]+);/gmu;
const GROUP = /^([\w\\]*)\\\s*\{([^}]*)\}$/u;

const DECLARATION =
  /^\s*(?:(?:abstract|final|readonly|public|protected|private|static)\s+)*(?:function\s+&?([A-Za-z_]\w*)\s*\(|(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)|const\s+(?:[\w\\?|]+\s+)?([A-Za-z_]\w*)\s*=)/u;
const DEFINE = /^\s*define\s*\(\s*['"]([A-Za-z_]\w*)['"]/u;

export const php: Language = {
  id: 'php',
  extensions: ['.php'],
  importedFiles: (path, text, candidates) => {
    const required = [...text.matchAll(REQUIRE)].flatMap(([, , specifier]) =>
      specifier === undefined ? [] : requiredFiles(path, specifier, candidates),
    );
    const used = [...text.matchAll(USE)].flatMap(([, clause]) =>
      clause === undefined
        ? []
        : importedNames(clause).flatMap((name) => bySuffix(psr4Suffix(name), candidates)),
    );
    return [...new Set([...required, ...used])].filter((target) => target !== path);
  },
  declaredName: (line) => {
    const match = DECLARATION.exec(line);
    return match?.[1] ?? match?.[2] ?? match?.[3] ?? DEFINE.exec(line)?.[1] ?? null;
  },
};

function requiredFiles(
  path: string,
  specifier: string,
  candidates: ReadonlySet<string>,
): readonly string[] {
  const relative = joinPath(path, specifier);
  if (relative !== null && candidates.has(relative)) return [relative];
  return bySuffix(specifier.replace(/^(?:\.{0,2}\/)+/u, ''), candidates);
}

/** The qualified names a `use` clause imports: `A\B, C\{D, E as F}` gives `A\B`, `C\D`, `C\E`. */
function importedNames(clause: string): readonly string[] {
  return splitTopLevel(clause).flatMap((part) => {
    const group = GROUP.exec(part);
    if (group === null) return [withoutAlias(part)];
    const prefix = group[1] ?? '';
    return (group[2] ?? '')
      .split(',')
      .map((item) => withoutAlias(item.replace(/^\s*(?:function|const)\s+/u, '')))
      .filter((item) => item !== '')
      .map((item) => `${prefix}\\${item}`);
  });
}

/** Commas outside braces separate a `use` clause's imports. */
function splitTopLevel(clause: string): readonly string[] {
  return (clause.match(/(?:[^,{]|\{[^}]*\})+/gu) ?? []).map((part) => part.trim());
}

function withoutAlias(name: string): string {
  return name.replace(/\s+as\s+\w+\s*$/u, '').trim();
}

/** `App\Pricing\Price` as the file suffix `Pricing/Price.php`: the root namespace is mapped. */
function psr4Suffix(name: string): string {
  const segments = name.split('\\').filter((segment) => segment !== '');
  return `${segments.slice(-2).join('/')}.php`;
}

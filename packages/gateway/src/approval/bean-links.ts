/**
 * How two beans' changes reach each other, beyond shared files (`docs/claude-opus/32-approval-
 * rules.md` §4.1): a file one changed imports a file the other changed, or a name one changed
 * (the function, class or constant around its changed lines) appears in the other's new lines.
 * Read from the two diffs alone, no other file: `price-dollars` changed `price()` in
 * `src/price.mjs`, and `shipping`'s new line in `src/checkout.mjs` (which imports it) calls
 * `price()`. Heuristic on purpose: it points Clef at a contract; it never decides.
 */
import type { FileChange } from '../git/diff-text';
import { lineHunks } from '../git/diff-text';
import type { Language } from './imports/language';
import { languageOf } from './imports/languages';

/**
 * Names too generic to link two beans: single letters and the parameter and variable names every
 * module uses. A real-history replay (fastify, 2026-10-16) linked beans by `res`, `server` and
 * `session`, and those false links pushed two compatible pairs over the recheck threshold.
 */
const GENERIC_NAMES: ReadonlySet<string> = new Set([
  'cb',
  'el',
  'fn',
  'id',
  'ok',
  'app',
  'arg',
  'ctx',
  'err',
  'msg',
  'obj',
  'opt',
  'req',
  'res',
  'ret',
  'tmp',
  'val',
  'args',
  'body',
  'callback',
  'config',
  'context',
  'data',
  'done',
  'error',
  'event',
  'handler',
  'headers',
  'index',
  'input',
  'item',
  'items',
  'key',
  'keys',
  'list',
  'main',
  'name',
  'next',
  'opts',
  'options',
  'output',
  'params',
  'path',
  'payload',
  'reply',
  'request',
  'response',
  'result',
  'self',
  'server',
  'session',
  'state',
  'this',
  'type',
  'value',
  'values',
]);
/** Single-letter names (`i`, `x`) never link; two-letter API names (`Price.of`) do. */
const MIN_NAME_LENGTH = 2;

/** Entries of each list Clef reads; past it, the link is plain enough. */
const LINKS_LIMIT = 12;
const IDENTIFIER = /[A-Za-z_$][\w$]*/gu;

/** The links between the bean being judged ("this") and one landed bean ("theirs"). */
export type BeanLinks = {
  /** `from -> to`: a file this bean changed imports a file theirs changed. */
  readonly thisImportsTheirs: readonly string[];
  readonly theirsImportsThis: readonly string[];
  /** Names theirs changed that this bean's new lines use. */
  readonly theyChangedThisUses: readonly string[];
  readonly thisChangedTheyUse: readonly string[];
};

export const NO_LINKS: BeanLinks = {
  thisImportsTheirs: [],
  theirsImportsThis: [],
  theyChangedThisUses: [],
  thisChangedTheyUse: [],
};

/** Both directions of import and name links between two beans' diffs. */
export function beanLinks(mine: readonly FileChange[], theirs: readonly FileChange[]): BeanLinks {
  return {
    thisImportsTheirs: importLinks(mine, theirs),
    theirsImportsThis: importLinks(theirs, mine),
    theyChangedThisUses: nameLinks(theirs, mine),
    thisChangedTheyUse: nameLinks(mine, theirs),
  };
}

/** A name specific enough that one bean changing it and the other using it is a contract. */
function isSpecificName(name: string): boolean {
  return name.length >= MIN_NAME_LENGTH && !GENERIC_NAMES.has(name.toLowerCase());
}

/** How many links there are, to put the most connected landed beans first. */
export function linkCount(links: BeanLinks): number {
  return Object.values(links).reduce((sum, list: readonly string[]) => sum + list.length, 0);
}

/** `from -> to` for each file of `from` whose current text imports a file `to` changed. */
function importLinks(from: readonly FileChange[], to: readonly FileChange[]): string[] {
  const targets = new Set(to.map((change) => change.path));
  const links = codeFiles(from).flatMap(({ change, language }) =>
    language
      .importedFiles(change.path, change.after ?? '', targets)
      .filter((target) => target !== change.path)
      .map((target) => `${change.path} -> ${target}`),
  );
  return [...new Set(links)].slice(0, LINKS_LIMIT);
}

/** Names `changer` changed that appear in `user`'s new or changed lines. */
function nameLinks(changer: readonly FileChange[], user: readonly FileChange[]): string[] {
  const changed = new Set(codeFiles(changer).flatMap(changedNames).filter(isSpecificName));
  const used = new Set(codeFiles(user).flatMap(({ change }) => newIdentifiers(change)));
  return [...changed].filter((name) => used.has(name)).slice(0, LINKS_LIMIT);
}

/**
 * The declarations a file's change touched: each changed line's own declaration, or the
 * nearest one above it that is indented less (the function a `return` sits in).
 */
function changedNames(file: CodeFile): string[] {
  const { change, language } = file;
  const names = new Set<string>();
  for (const side of [sideOf(change, 'before'), sideOf(change, 'after')]) {
    for (const line of side.changed) {
      const name = enclosingName(language, side.lines, line);
      if (name !== null) names.add(name);
    }
  }
  return [...names];
}

/** The identifiers on a file's new or changed lines. */
function newIdentifiers(change: FileChange): string[] {
  const side = sideOf(change, 'after');
  return side.changed.flatMap((line) =>
    [...(side.lines[line] ?? '').matchAll(IDENTIFIER)].map(String),
  );
}

function enclosingName(language: Language, lines: readonly string[], at: number): string | null {
  const own = language.declaredName(lines[at] ?? '');
  if (own !== null) return own;
  const indent = indentOf(lines[at] ?? '');
  for (let line = at - 1; line >= 0; line -= 1) {
    const text = lines[line] ?? '';
    if (text.trim() === '' || indentOf(text) >= indent) continue;
    const name = language.declaredName(text);
    if (name !== null) return name;
  }
  return null;
}

/** One side's lines and the indexes of its changed lines. */
function sideOf(
  change: FileChange,
  side: 'before' | 'after',
): { readonly lines: readonly string[]; readonly changed: readonly number[] } {
  const text = change[side] ?? '';
  const lines = text.split('\n');
  const changed = lineHunks(change.before, change.after).flatMap((hunk) => {
    const [start, end] =
      side === 'after' ? [hunk.newStart, hunk.newEnd] : [hunk.oldStart, hunk.oldEnd];
    return Array.from({ length: end - start }, (_, offset) => start + offset);
  });
  return { lines, changed };
}

/** A changed file in a language the links read. */
type CodeFile = { readonly change: FileChange; readonly language: Language };

function codeFiles(changes: readonly FileChange[]): readonly CodeFile[] {
  return changes.flatMap((change) => {
    const language = change.binary === true ? null : languageOf(change.path);
    return language === null ? [] : [{ change, language }];
  });
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * The one way Gitstalk reads its own YAML configuration (`.gitstalk/policy.yml`,
 * `.gitstalk/checks.yml`): YAML 1.2 core schema (`no` stays a string), unique keys, no anchors,
 * aliases or merge keys, so a file reads as written. Every problem has a line and column when
 * the document has one, and a parsed document can say where any of its values or keys is, so
 * schema errors name their line too.
 */
import { LineCounter, isAlias, isMap, isNode, isScalar, parseDocument, visit } from 'yaml';
import type { Document } from 'yaml';

/** A line and column, both from 1. */
export type YamlPosition = { readonly line: number; readonly column: number };

/** A syntax problem: where (when known) and what. */
export type YamlProblem = { readonly position: YamlPosition | null; readonly message: string };

/** A path into the document: map keys and sequence indexes. */
export type YamlPath = readonly (string | number)[];

/** Where things are in a parsed document. */
export type YamlLocator = {
  /** The value at `path`, or the nearest ancestor the document has. */
  readonly value: (path: YamlPath) => YamlPosition | null;
  /** The key at the end of `path` (an unknown key's name), else its map. */
  readonly key: (path: YamlPath) => YamlPosition | null;
};

export type StrictYaml =
  | { readonly ok: true; readonly value: unknown; readonly at: YamlLocator }
  | { readonly ok: false; readonly problems: readonly YamlProblem[] };

/** Parses `text` strictly; an empty document is `null`. Never throws. */
export function parseStrictYaml(text: string): StrictYaml {
  const counter = new LineCounter();
  const document = parseDocument(text, {
    version: '1.2',
    schema: 'core',
    strict: true,
    uniqueKeys: true,
    merge: false,
    prettyErrors: false,
    lineCounter: counter,
  });
  const syntax = [...document.errors, ...document.warnings].map((error) => ({
    position: positionOf(counter, error.pos[0]),
    message: firstLine(error.message),
  }));
  if (syntax.length > 0) return { ok: false, problems: syntax };
  const shared = anchorsAndAliases(document, counter);
  if (shared.length > 0) return { ok: false, problems: shared };
  return {
    ok: true,
    value: document.toJS(),
    at: {
      value: (path) => locate(document, counter, path),
      key: (path) => keyPosition(document, counter, path),
    },
  };
}

/** A zod issue's path as a YAML path (symbols, which zod never puts there, dropped). */
export function yamlPathOf(path: readonly PropertyKey[]): YamlPath {
  return path.filter((part): part is string | number => typeof part !== 'symbol');
}

/** A path as a field name: `classes[2].match.paths`. */
export function fieldOf(path: YamlPath): string {
  return path.reduce<string>((text, part) => {
    if (typeof part === 'number') return `${text}[${part}]`;
    return text === '' ? part : `${text}.${part}`;
  }, '');
}

function firstLine(message: string): string {
  return message.split('\n')[0] ?? message;
}

function positionOf(counter: LineCounter, offset: number | undefined): YamlPosition | null {
  if (offset === undefined) return null;
  const { line, col } = counter.linePos(offset);
  return { line, column: col };
}

/** Anchors (`&a`) and aliases (`*a`, which `<<` merge keys need) are refused: files read as written. */
function anchorsAndAliases(document: Document, counter: LineCounter): YamlProblem[] {
  const problems: YamlProblem[] = [];
  visit(document, (_key, node) => {
    if (isAlias(node))
      problems.push({
        position: positionOf(counter, node.range?.[0]),
        message: 'aliases (*name) and merge keys are not allowed; write each value out',
      });
    else if (isNode(node) && node.anchor !== undefined)
      problems.push({
        position: positionOf(counter, node.range?.[0]),
        message: 'anchors (&name) are not allowed; write each value out',
      });
  });
  return problems;
}

function locate(document: Document, counter: LineCounter, path: YamlPath): YamlPosition | null {
  for (let depth = path.length; depth >= 0; depth -= 1) {
    const node: unknown = document.getIn(path.slice(0, depth), true);
    if (isNode(node)) return positionOf(counter, node.range?.[0]);
  }
  return null;
}

function keyPosition(
  document: Document,
  counter: LineCounter,
  path: YamlPath,
): YamlPosition | null {
  const parent: unknown = document.getIn(path.slice(0, -1), true);
  const key = path.at(-1);
  if (isMap(parent)) {
    const pair = parent.items.find((item) => isScalar(item.key) && item.key.value === key);
    if (pair !== undefined && isNode(pair.key)) return positionOf(counter, pair.key.range?.[0]);
  }
  return locate(document, counter, path.slice(0, -1));
}

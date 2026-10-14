/**
 * An automation draft is its YAML text: the form reads its fields from the parsed text and
 * writes each change back into it with the `yaml` package's Document API, so comments, key
 * order and quoting survive and a save's diff is the field that changed (doc 25 §4.2). The
 * same text is what the YAML pane edits, so the two can never drift apart.
 */
import type { GitstalkEvent } from '@gitstalk/shared-race/actions';
import { GITSTALK_EVENTS } from '@gitstalk/shared-race/actions';
import { Document, LineCounter, isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml';
import type { Node, YAMLMap } from 'yaml';

import { minimalEdit } from './minimal-edit';

/** A key path into the file: `['name']`, `['on', 'bean_red']`, `['permissions', 'beans']`. */
export type FieldPath = readonly string[];

/** The text as YAML: its plain value, or its syntax errors with their lines. */
export type ParsedDraft =
  | { readonly kind: 'ok'; readonly value: Readonly<Record<string, unknown>> }
  | { readonly kind: 'syntax'; readonly errors: readonly SyntaxProblem[] };

export type SyntaxProblem = { readonly line: number; readonly message: string };

/** One Gitstalk event's filters (empty lists: every bean, every author, any files). */
export type EventFilter = {
  readonly beans: readonly string[];
  readonly authors: readonly string[];
  /** Changed-file globs; only landings and reverts take them (`PATH_FILTERED_EVENTS`). */
  readonly paths: readonly string[];
};

export const NO_FILTER: EventFilter = { beans: [], authors: [], paths: [] };

/** What the form shows, read leniently: the validator reports what is wrong. */
export type DraftForm = {
  readonly name: string;
  readonly events: Readonly<Partial<Record<GitstalkEvent, EventFilter>>>;
  readonly crons: readonly string[];
  readonly harness: 'agent' | 'shell';
  readonly model: string;
  readonly prompt: string;
  readonly run: string;
  readonly beansWrite: boolean;
  readonly secrets: readonly string[];
  readonly timeoutMinutes: number | null;
  readonly maxTurns: number | null;
  readonly maxCostUsd: number | null;
  readonly memory: boolean;
};

/** Parses the text; never throws. */
export function readDraft(source: string): ParsedDraft {
  const counter = new LineCounter();
  const document = parseDocument(source, { lineCounter: counter, prettyErrors: false });
  if (document.errors.length > 0)
    return {
      kind: 'syntax',
      errors: document.errors.map((error) => ({
        line: counter.linePos(error.pos[0]).line,
        message: error.message.split('\n')[0] ?? error.message,
      })),
    };
  const value: unknown = document.toJS();
  return { kind: 'ok', value: isRecord(value) ? value : {} };
}

/** The form's fields from a parsed value. */
export function formOf(value: Readonly<Record<string, unknown>>): DraftForm {
  const on = onEntries(value['on']);
  const events: Partial<Record<GitstalkEvent, EventFilter>> = {};
  for (const [event, filter] of on) {
    const known = GITSTALK_EVENTS.find((candidate) => candidate === event);
    if (known !== undefined) events[known] = filterOf(filter);
  }
  const schedule = on.find(([event]) => event === 'schedule')?.[1];
  const permissions = value['permissions'];
  return {
    name: text(value['name']),
    events,
    crons: Array.isArray(schedule)
      ? schedule.flatMap((entry: unknown) =>
          isRecord(entry) && typeof entry['cron'] === 'string' ? [entry['cron']] : [],
        )
      : [],
    harness: value['harness'] === 'shell' ? 'shell' : 'agent',
    model: text(value['model']),
    prompt: text(value['prompt']),
    run: text(value['run']),
    beansWrite: isRecord(permissions) && permissions['beans'] === 'write',
    secrets: strings(value['secrets']),
    timeoutMinutes: numberOrNull(value['timeout-minutes']),
    maxTurns: numberOrNull(value['max-turns']),
    maxCostUsd: numberOrNull(value['max-cost-usd']),
    memory: value['memory'] !== false,
  };
}

/**
 * The text with one field set (or removed, for `undefined`), keeping every other byte the
 * document's own: comments, order and the style of a scalar that is replaced. A text that does
 * not parse is returned as it is (the form is read-only until the YAML is fixed).
 */
export function setField(source: string, path: FieldPath, value: unknown): string {
  const parsed = parseDocument(source);
  if (parsed.errors.length > 0) return source;
  // Setting a field to the value it has already is no edit: the bytes, comments included, stay.
  if (isSameValue(parsed, path, value)) return source;
  // An empty file (or one that is not a mapping) starts as an empty mapping.
  const document: Document = isMap(parsed.contents) ? parsed : new Document({});
  if (path[0] === 'on') normaliseOn(document);
  if (value === undefined) removeField(document, path);
  else writeField(document, path, value);
  return minimalEdit(source, render(document), path);
}

/** Turns a Gitstalk event on (no filters) or off; with none left, the file runs by hand only. */
export function setEvent(source: string, event: GitstalkEvent, isOn: boolean): string {
  const next = setField(source, ['on', event], isOn ? null : undefined);
  return withManualFallback(next);
}

/** Sets an event's filters: none is the bare event. */
export function setEventFilter(source: string, event: GitstalkEvent, filter: EventFilter): string {
  const value: Record<string, readonly string[]> = {};
  if (filter.beans.length > 0) value['beans'] = filter.beans;
  if (filter.authors.length > 0) value['authors'] = filter.authors;
  if (filter.paths.length > 0) value['paths'] = filter.paths;
  return setField(source, ['on', event], Object.keys(value).length === 0 ? null : value);
}

/** Sets the schedule's crons (none removes the schedule). */
export function setCrons(source: string, crons: readonly string[]): string {
  const next = setField(
    source,
    ['on', 'schedule'],
    crons.length === 0 ? undefined : crons.map((cron) => ({ cron })),
  );
  return withManualFallback(next);
}

/** `on:` as `[event, value]` pairs: a name, a list of names, or a mapping (the parser's forms). */
export function onEntries(on: unknown): readonly (readonly [string, unknown])[] {
  if (typeof on === 'string') return [[on, null]];
  if (Array.isArray(on))
    return on.flatMap((item: unknown) => (typeof item === 'string' ? [[item, null] as const] : []));
  if (isRecord(on)) return Object.entries(on);
  return [];
}

// Writing -----------------------------------------------------------------------------------

/** `on: bean_red` or `on: [a, b]` becomes a mapping before a trigger is set inside it. */
function normaliseOn(document: Document): void {
  const node = document.get('on', true);
  if (isMap(node)) return;
  const entries = onEntries(document.toJS()?.['on']);
  const map: Record<string, unknown> = {};
  for (const [event, filter] of entries) map[event] = filter;
  document.set('on', document.createNode(map));
}

function removeField(document: Document, path: FieldPath): void {
  if (!document.hasIn(path)) return;
  document.deleteIn(path);
  const parent = path.slice(0, -1);
  // An empty `permissions:` mapping says nothing; `on:` is kept (the manual fallback fills it).
  if (parent.length === 1 && parent[0] === 'permissions') {
    const node = document.getIn(parent, true);
    if (isMap(node) && node.items.length === 0) document.deleteIn(parent);
  }
}

function writeField(document: Document, path: FieldPath, value: unknown): void {
  const existing = document.getIn(path, true);
  if (isScalar(existing) && isPrimitive(value)) {
    existing.value = value;
    if (typeof value === 'string' && value.includes('\n')) existing.type = 'BLOCK_LITERAL';
    return;
  }
  document.setIn(path, nodeOf(document, value));
}

/** A new node: block text for multi-line strings, flow style for short lists of scalars. */
function nodeOf(document: Document, value: unknown): Node {
  const node = document.createNode(value);
  if (isScalar(node) && typeof value === 'string' && value.includes('\n'))
    node.type = 'BLOCK_LITERAL';
  if (isSeq(node)) {
    node.flow = true;
    for (const item of node.items) if (isMap(item)) quoteCrons(item);
  }
  if (isMap(node)) for (const pair of node.items) if (isSeq(pair.value)) pair.value.flow = true;
  return node;
}

/** `cron:` values read best quoted, as GitHub's docs write them: `{ cron: "0 9 * * 1" }`. */
function quoteCrons(map: YAMLMap): void {
  for (const pair of map.items)
    if (isScalar(pair.key) && pair.key.value === 'cron' && isScalar(pair.value))
      pair.value.type = 'QUOTE_DOUBLE';
}

/** With no trigger left, `on:` names `workflow_dispatch`: the file stays valid, run by hand. */
function withManualFallback(source: string): string {
  const parsed = readDraft(source);
  if (parsed.kind !== 'ok') return source;
  const entries = onEntries(parsed.value['on']);
  const hasTrigger = entries.some(([event]) => event !== 'workflow_dispatch');
  const hasManual = entries.some(([event]) => event === 'workflow_dispatch');
  if (!hasTrigger && !hasManual) return setField(source, ['on', 'workflow_dispatch'], null);
  if (hasTrigger && hasManual) return setField(source, ['on', 'workflow_dispatch'], undefined);
  return source;
}

/** Empty values print as `key:` (a bare event), never `key: null`. */
function render(document: Document): string {
  return document.toString({ nullStr: '', lineWidth: 0 });
}

/**
 * Whether the field at `path` already holds `value` (`undefined`: it is absent). A bare key
 * (`workflow_dispatch:`) is present with a null value, so it never matches `undefined`.
 */
function isSameValue(document: Document, path: FieldPath, value: unknown): boolean {
  if (!isMap(document.contents)) return false;
  if (!document.hasIn(path)) return value === undefined;
  if (value === undefined) return false;
  const node: unknown = document.getIn(path, true);
  const current: unknown = isNode(node) ? node.toJSON() : node;
  return JSON.stringify(current ?? null) === JSON.stringify(value);
}

// Reading -----------------------------------------------------------------------------------

function filterOf(value: unknown): EventFilter {
  if (!isRecord(value)) return NO_FILTER;
  return {
    beans: strings(value['beans']),
    authors: strings(value['authors']),
    paths: strings(value['paths']),
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item: unknown) => (typeof item === 'string' ? [item] : []))
    : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

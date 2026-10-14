/**
 * `repo_read`: code for agents without a checkout, over the gateway's repository reads
 * (`repoFile`, `repoTree`, `repoGrep`). Files with an optional line range, a tree listing for a
 * directory or a glob, or a search shaped like `rg --json` with context lines, bounded to about
 * 8k tokens a page and continued with a cursor. Read-only; the caller's context decides access
 * exactly as for `ask_repo`.
 */
import { z } from 'zod';

import { unwrap } from '@gitstalk/shared-ask/forge/gateway-rpc';
import { isForgeError } from '@gitstalk/shared-ask/forge/forge-errors';

import { ToolError } from '../mcp/tool-result';
import { globMatcher, globRoot } from './path-glob';
import type { ToolContext } from './tool-context';

/** Files `paths` may name in one call. */
export const MAX_READ_PATHS = 20;
/** Characters of file content in one answer (about 25k tokens); the rest is read by range. */
const MAX_FILE_CHARS = 100_000;
/** Characters of search output in one page (about 8k tokens). */
const MAX_GREP_CHARS = 32_000;
const MAX_TREE_ENTRIES = 500;
/** Files whose text a search page reads for context lines. */
const MAX_CONTEXT_FILES = 20;
const CONTEXT_LINES = 2;
const MAX_LINE_CHARS = 300;

export type RepoReadInput = {
  readonly ref?: string | undefined;
  readonly path?: string | undefined;
  readonly paths?: readonly string[] | undefined;
  readonly glob?: string | undefined;
  readonly grep?: string | undefined;
  readonly start?: number | undefined;
  readonly end?: number | undefined;
  readonly cursor?: string | undefined;
};

const TreeAnswer = z.object({
  commit: z.string().optional(),
  entries: z.array(z.object({ path: z.string(), type: z.string() })),
  truncated: z.boolean().optional(),
});
const FileAnswer = z.object({
  commit: z.string().optional(),
  path: z.string(),
  size: z.number(),
  binary: z.boolean(),
  content: z.string().nullable(),
  truncated: z.boolean(),
});
type FileAnswer = z.infer<typeof FileAnswer>;
const GrepAnswer = z.object({
  commit: z.string().optional(),
  matches: z.array(z.object({ path: z.string(), line: z.number(), text: z.string() })),
  files_scanned: z.number().optional(),
  truncated: z.boolean().optional(),
});
type GrepMatch = z.infer<typeof GrepAnswer>['matches'][number];

/** Reads what the input asks for: a search, files, or a listing. */
export async function repoRead(ctx: ToolContext, input: RepoReadInput): Promise<object> {
  const ref = refOf(input.ref);
  if (input.grep !== undefined) return search(ctx, { ...input, ref, grep: input.grep });
  if (input.paths !== undefined) return readFiles(ctx, { ...input, ref, paths: input.paths });
  if (input.path !== undefined && input.glob === undefined)
    return readPath(ctx, { ...input, ref, path: input.path });
  return listTree(ctx, { ...input, ref });
}

/** `sprout` by default; a session's `bean/<name>` is the engine's `beans/<name>`. */
function refOf(ref: string | undefined): string {
  const named = ref?.trim() ?? '';
  if (named === '') return 'sprout';
  return named.replace(/^bean\//, 'beans/');
}

type Ranged = RepoReadInput & { readonly ref: string };

/** One path: a file, or (when no file is there) the directory's listing. */
async function readPath(ctx: ToolContext, input: Ranged & { readonly path: string }) {
  const path = trimPath(input.path);
  if (path === '') return listTree(ctx, { ...input, path });
  const file = await fileAt(ctx, { ref: input.ref, path });
  if (!('error' in file)) return filesAnswer(input, [file]);
  if (isForgeError(file.cause, 'not_found')) return listTree(ctx, { ...input, path });
  throw file.cause;
}

async function readFiles(ctx: ToolContext, input: Ranged & { readonly paths: readonly string[] }) {
  if (input.paths.length === 0 || input.paths.length > MAX_READ_PATHS)
    throw new ToolError(`paths takes 1 to ${MAX_READ_PATHS} files`);
  const read = await Promise.all(
    input.paths.map(async (path) => fileAt(ctx, { ref: input.ref, path: trimPath(path) })),
  );
  return filesAnswer(input, read);
}

/** The files read, each cut to its range and all to the answer's budget. */
function filesAnswer(input: Ranged, read: readonly FileRead[]) {
  let budget = MAX_FILE_CHARS;
  let commit: string | null = null;
  const files = read.map((file) => {
    if ('error' in file) return { path: file.path, error: file.error };
    commit ??= file.found.commit ?? null;
    const shown = ranged(file.found, { start: input.start, end: input.end, budget });
    budget = Math.max(0, budget - (shown.content?.length ?? 0));
    return shown;
  });
  const cut = files.filter((file) => 'next_start' in file && file.next_start !== null).length;
  const count = `${files.length} file${files.length === 1 ? '' : 's'}`;
  return {
    mode: 'files',
    ref: input.ref,
    commit,
    files,
    summary: `${count} at ${input.ref}${cut === 0 ? '' : `; ${cut} cut to fit: read on with start: next_start`}`,
  };
}

type FileRead =
  | { readonly path: string; readonly found: FileAnswer }
  | { readonly path: string; readonly error: string; readonly cause: unknown };

async function fileAt(
  ctx: ToolContext,
  at: { readonly ref: string; readonly path: string },
): Promise<FileRead> {
  try {
    const found = unwrap(await ctx.gateway.repoFile(ctx.run, at.ref, at.path), FileAnswer);
    return { path: at.path, found };
  } catch (error: unknown) {
    if (!isForgeError(error)) throw error;
    return { path: at.path, error: error.message, cause: error };
  }
}

/** The file's lines `start`..`end` (1-based, inclusive), cut to the answer's budget. */
function ranged(
  file: FileAnswer,
  range: {
    readonly start?: number | undefined;
    readonly end?: number | undefined;
    readonly budget: number;
  },
) {
  // `truncated`: the gateway reads at most 256 KiB of a file; lines past that are not served.
  const base = { path: file.path, size: file.size, binary: file.binary, truncated: file.truncated };
  if (file.content === null) return { ...base, content: null, next_start: null };
  const lines = linesOf(file.content);
  const first = Math.max(1, range.start ?? 1);
  const wanted = lines.slice(first - 1, Math.min(lines.length, range.end ?? lines.length));
  const kept: string[] = [];
  let used = 0;
  for (const line of wanted) {
    if (used + line.length + 1 > range.budget && (kept.length > 0 || range.budget === 0)) break;
    kept.push(line);
    used += line.length + 1;
  }
  const last = first + kept.length - 1;
  const more = kept.length < wanted.length;
  return {
    ...base,
    lines: lines.length,
    start: first,
    end: last,
    content: kept.join('\n'),
    next_start: more ? last + 1 : null,
  };
}

/** A directory's entries, or with a glob the files under it that match. */
async function listTree(ctx: ToolContext, input: Ranged) {
  const base = trimPath(input.path ?? '');
  const glob = input.glob;
  const root = glob === undefined ? base : globRoot(glob, base);
  const tree = unwrap(
    await ctx.gateway.repoTree(ctx.run, input.ref, root, glob !== undefined),
    TreeAnswer,
  );
  const matches = glob === undefined ? () => true : globMatcher(glob, base);
  const entries = tree.entries
    .filter((entry) => glob === undefined || (entry.type !== 'tree' && matches(entry.path)))
    .map(({ path, type }) => ({ path, type }));
  const shown = entries.slice(0, MAX_TREE_ENTRIES);
  const truncated = shown.length < entries.length || tree.truncated === true;
  return {
    mode: 'tree',
    ref: input.ref,
    commit: tree.commit ?? null,
    path: root,
    glob: glob ?? null,
    entries: shown,
    truncated,
    summary: `${shown.length} entries${glob === undefined ? ` in ${root === '' ? 'the root' : root}` : ` matching ${glob}`}${truncated ? ' (cut: narrow with path or glob)' : ''}`,
  };
}

/** `"/re/"` is a safe-subset regular expression; anything else is a literal. */
function patternOf(grep: string): { readonly pattern: string; readonly regex: boolean } {
  const isRegex = grep.length > 2 && grep.startsWith('/') && grep.endsWith('/');
  return isRegex ? { pattern: grep.slice(1, -1), regex: true } : { pattern: grep, regex: false };
}

type Cursor = { readonly ref: string; readonly offset: number };

function cursorOf(cursor: string | undefined, ref: string): Cursor {
  if (cursor === undefined) return { ref, offset: 0 };
  const split = cursor.lastIndexOf(':');
  const offset = Number(cursor.slice(split + 1));
  if (split <= 0 || !Number.isInteger(offset) || offset < 0)
    throw new ToolError('cursor is not one repo_read gave (pass next_cursor as it came)');
  return { ref: cursor.slice(0, split), offset };
}

async function search(ctx: ToolContext, input: Ranged & { readonly grep: string }) {
  const { pattern, regex } = patternOf(input.grep);
  const at = cursorOf(input.cursor, input.ref);
  const scope = searchScope(input);
  const found = unwrap(
    await ctx.gateway.repoGrep(ctx.run, at.ref, pattern, scope.prefixes, regex),
    GrepAnswer,
  );
  const matches = found.matches.filter((match) => scope.matches(match.path));
  const page = pageOf(matches, at.offset);
  const texts = await contextTexts(ctx, { ref: found.commit ?? at.ref, matches: page });
  const messages = rgMessages(page, { texts, submatch: submatcher(pattern, regex) });
  const offset = at.offset + page.length;
  const next = offset < matches.length ? `${found.commit ?? at.ref}:${offset}` : null;
  const files = new Set(page.map((match) => match.path)).size;
  return {
    mode: 'grep',
    ref: input.ref,
    commit: found.commit ?? null,
    pattern,
    regex,
    messages,
    matches: matches.length,
    shown: page.length,
    files_scanned: found.files_scanned ?? null,
    search_truncated: found.truncated === true,
    next_cursor: next,
    summary: `${matches.length} matching lines${found.truncated === true ? ' (the search stopped early: narrow with path, paths or glob)' : ''}; ${page.length} shown from ${files} files${next === null ? '' : ', more with cursor: next_cursor'}`,
  };
}

function searchScope(input: RepoReadInput): {
  readonly prefixes: readonly string[] | undefined;
  readonly matches: (path: string) => boolean;
} {
  const base = trimPath(input.path ?? '');
  const named = (input.paths ?? (base === '' ? [] : [base])).map(trimPath);
  const glob = input.glob;
  const globBase = input.paths === undefined ? base : '';
  const matcher = glob === undefined ? undefined : globMatcher(glob, globBase);
  const globbed =
    glob === undefined ? [] : [globRoot(glob, globBase)].filter((root) => root !== '');
  const prefixes = named.length > 0 ? named : globbed;
  return {
    prefixes: prefixes.length === 0 ? undefined : prefixes,
    matches: (path) => matcher === undefined || matcher(path),
  };
}

/** Matches from `offset` while the page stays near 8k tokens. */
function pageOf(matches: readonly GrepMatch[], offset: number): readonly GrepMatch[] {
  const page: GrepMatch[] = [];
  let used = 0;
  for (const match of matches.slice(offset)) {
    // A match with its context lines and path takes about this much JSON.
    const cost = (match.text.length + match.path.length + 80) * (1 + CONTEXT_LINES);
    if (used + cost > MAX_GREP_CHARS && page.length > 0) break;
    page.push(match);
    used += cost;
  }
  return page;
}

/** The text of the first files a page touches, for context lines; none when a read fails. */
async function contextTexts(
  ctx: ToolContext,
  input: { readonly ref: string; readonly matches: readonly GrepMatch[] },
): Promise<ReadonlyMap<string, readonly string[]>> {
  const paths = [...new Set(input.matches.map((match) => match.path))].slice(0, MAX_CONTEXT_FILES);
  const read = await Promise.all(paths.map(async (path) => fileAt(ctx, { ref: input.ref, path })));
  const texts = new Map<string, readonly string[]>();
  for (const file of read)
    if ('found' in file && file.found.content !== null)
      texts.set(file.path, linesOf(file.found.content));
  return texts;
}

type Submatch = {
  readonly match: { readonly text: string };
  readonly start: number;
  readonly end: number;
};

/** Where the pattern matches in a line, as `rg --json` reports `submatches`. */
function submatcher(pattern: string, regex: boolean): (line: string) => readonly Submatch[] {
  if (!regex) return (line) => literalHits(line, pattern);
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern, 'g');
  } catch {
    return () => [];
  }
  return (line) =>
    [...line.matchAll(compiled)]
      .filter((hit) => hit[0].length > 0)
      .map((hit) => ({
        match: { text: hit[0] },
        start: hit.index,
        end: hit.index + hit[0].length,
      }));
}

function literalHits(line: string, needle: string): readonly Submatch[] {
  const hits: Submatch[] = [];
  let from = line.indexOf(needle);
  while (from !== -1) {
    hits.push({ match: { text: needle }, start: from, end: from + needle.length });
    from = line.indexOf(needle, from + needle.length);
  }
  return hits;
}

/** `begin`, `context`, `match` and `end` messages per file, as `rg --json -C 2` prints. */
function rgMessages(
  page: readonly GrepMatch[],
  input: {
    readonly texts: ReadonlyMap<string, readonly string[]>;
    readonly submatch: (line: string) => readonly Submatch[];
  },
): readonly object[] {
  const byPath = new Map<string, GrepMatch[]>();
  for (const match of page) {
    const listed = byPath.get(match.path);
    if (listed === undefined) byPath.set(match.path, [match]);
    else listed.push(match);
  }
  return [...byPath].flatMap(([path, matches]) =>
    fileMessages({ path, matches, lines: input.texts.get(path), submatch: input.submatch }),
  );
}

function fileMessages(file: {
  readonly path: string;
  readonly matches: readonly GrepMatch[];
  readonly lines: readonly string[] | undefined;
  readonly submatch: (line: string) => readonly Submatch[];
}): readonly object[] {
  const { path, matches, lines } = file;
  const hit = new Map(matches.map((match) => [match.line, match.text]));
  const numbers =
    lines === undefined ? [...hit.keys()] : withContext([...hit.keys()], lines.length);
  const body = numbers.map((number) => {
    const text = clipLine(lines?.[number - 1] ?? hit.get(number) ?? '');
    const isMatch = hit.has(number);
    return {
      type: isMatch ? 'match' : 'context',
      data: {
        path: { text: path },
        lines: { text },
        line_number: number,
        submatches: isMatch ? file.submatch(text) : [],
      },
    };
  });
  return [
    { type: 'begin', data: { path: { text: path } } },
    ...body,
    { type: 'end', data: { path: { text: path }, stats: { matched_lines: matches.length } } },
  ];
}

/** The matched line numbers with `CONTEXT_LINES` around each, merged and in order. */
function withContext(hits: readonly number[], total: number): readonly number[] {
  const shown = new Set<number>();
  for (const line of hits)
    for (let near = line - CONTEXT_LINES; near <= line + CONTEXT_LINES; near += 1)
      if (near >= 1 && near <= total) shown.add(near);
  return [...shown].toSorted((a, b) => a - b);
}

function clipLine(line: string): string {
  return line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS - 1)}…`;
}

/** A text's lines; the newline that ends the last one starts no line of its own. */
function linesOf(text: string): readonly string[] {
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.slice(0, -1) : lines;
}

function trimPath(path: string): string {
  return path
    .trim()
    .replace(/^\.?\/+/, '')
    .replace(/\/+$/, '');
}

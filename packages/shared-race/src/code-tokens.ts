/**
 * Whether a change to a source file touches only comments and whitespace (the `comment-only`
 * class of the approval rules, `approval-policy.ts`). Computed by code, never by a model: each
 * side is lexed into code tokens with comments and whitespace dropped, and the two streams are
 * compared. The lexer knows C-family comments (`//`, `/* *\/`), string and template literals
 * (with `${}` nesting), JavaScript regular-expression literals by the usual "an operand cannot
 * be here" rule, and Rust's raw strings, byte strings, char literals, lifetimes and nested block
 * comments.
 *
 * Every doubt answers "not comment-only", which only sends a change to a stricter route:
 * - a file the lexer does not know: only TypeScript and JavaScript (not JSX, where `//` can be
 *   text), Rust, C and C++, Java and Go are judged;
 * - an added, deleted or binary file;
 * - an unterminated string, comment, template or regular expression on either side;
 * - punctuation that whitespace split differently (`) + (` against `)+(`): punctuation runs are
 *   kept whole, so `a+ +b` never equals `a++b`, at the price of calling such a reformat code.
 */

/** How a file is lexed, by its extension; null for a file this module does not judge. */
export type SourceDialect = 'js' | 'rust' | 'c';

const DIALECTS: Readonly<Record<string, SourceDialect>> = {
  ts: 'js',
  mts: 'js',
  cts: 'js',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cc: 'c',
  cpp: 'c',
  cxx: 'c',
  hpp: 'c',
  hh: 'c',
  java: 'c',
  go: 'c',
};

/** Longest file judged; a larger one is "not comment-only" (bounded work per check). */
export const MAX_LEXED_CHARS = 512 * 1024;

/** The dialect of `path`, or null when its changes are never judged comment-only. */
export function dialectOf(path: string): SourceDialect | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return DIALECTS[name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Whether `before` and `after` of `path` differ only in comments and whitespace. Null contents
 * (an added or deleted file) and unknown dialects are never comment-only.
 */
export function isCommentOnlyChange(
  path: string,
  before: string | null,
  after: string | null,
): boolean {
  const dialect = dialectOf(path);
  if (dialect === null || before === null || after === null) return false;
  const [left, right] = [codeTokens(before, dialect), codeTokens(after, dialect)];
  if (left === null || right === null) return false;
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

/**
 * The code tokens of `source`: words, literals and punctuation runs, without comments or
 * whitespace. Null when the source cannot be lexed (an unterminated literal or comment, or
 * too long).
 */
export function codeTokens(source: string, dialect: SourceDialect): readonly string[] | null {
  if (source.length > MAX_LEXED_CHARS) return null;
  const lexer = new Lexer(source, dialect);
  return lexer.run() ? lexer.tokens : null;
}

const WORD = /[\p{L}\p{N}_$]/u;
const SPACE = /\s/u;
/** Keywords after which a `/` starts a regular expression, not a division. */
const REGEX_AFTER_WORDS: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);
/** Characters after which a `/` divides: the end of an operand. */
const OPERAND_END = /[\p{L}\p{N}_$)\]}'"`]/u;

class Lexer {
  readonly tokens: string[] = [];
  readonly #source: string;
  readonly #dialect: SourceDialect;
  #at = 0;
  /** Open `${` of template literals, by brace depth at which each closes. */
  readonly #templates: number[] = [];
  #braces = 0;

  constructor(source: string, dialect: SourceDialect) {
    this.#source = source;
    this.#dialect = dialect;
  }

  /** Lexes the whole source; false when something is unterminated. */
  run(): boolean {
    while (this.#at < this.#source.length) {
      if (!this.#step()) return false;
    }
    this.#breakRun();
    return this.#templates.length === 0;
  }

  #step(): boolean {
    const char = this.#source[this.#at] ?? '';
    const next = this.#source[this.#at + 1] ?? '';
    if (SPACE.test(char)) {
      this.#at += 1;
      this.#breakRun();
      return true;
    }
    if (char === '/' && next === '/') return this.#lineComment();
    if (char === '/' && next === '*') return this.#blockComment();
    if (this.#dialect === 'rust') {
      const rust = this.#rustLiteral();
      if (rust !== null) return rust;
    }
    if (char === '"' || (char === "'" && this.#dialect !== 'rust')) return this.#quoted(char);
    if (char === '`' && this.#dialect === 'js') return this.#template();
    if (char === '`' && this.#dialect === 'c') return this.#rawBackquoted();
    if (char === '/' && this.#dialect === 'js' && this.#regexMayStart()) return this.#regex();
    if (WORD.test(char)) return this.#word();
    return this.#punctuation(char);
  }

  /** The run being built is punctuation; whitespace or a comment ends it. */
  #run: string | null = null;

  #breakRun(): void {
    if (this.#run !== null) this.tokens.push(this.#run);
    this.#run = null;
  }

  #emit(token: string): void {
    this.#breakRun();
    this.tokens.push(token);
  }

  #lineComment(): boolean {
    const end = this.#source.indexOf('\n', this.#at);
    this.#at = end === -1 ? this.#source.length : end;
    this.#breakRun();
    return true;
  }

  #blockComment(): boolean {
    const nests = this.#dialect === 'rust';
    let depth = 0;
    while (this.#at < this.#source.length) {
      const pair = this.#source.slice(this.#at, this.#at + 2);
      if (pair === '/*' && (nests || depth === 0)) {
        depth += 1;
        this.#at += 2;
      } else if (pair === '*/') {
        depth -= 1;
        this.#at += 2;
        if (depth === 0) {
          this.#breakRun();
          return true;
        }
      } else this.#at += 1;
    }
    return false;
  }

  #quoted(quote: string): boolean {
    const start = this.#at;
    this.#at += 1;
    while (this.#at < this.#source.length) {
      const char = this.#source[this.#at];
      if (char === '\\') this.#at += 2;
      else if (char === quote) {
        this.#at += 1;
        this.#emit(this.#source.slice(start, this.#at));
        return true;
      } else if (char === '\n' && this.#dialect === 'js') return false;
      else this.#at += 1;
    }
    return false;
  }

  /** A template literal up to its end or its first `${`, whose `}` resumes it. */
  #template(): boolean {
    const start = this.#at;
    this.#at += 1;
    while (this.#at < this.#source.length) {
      const char = this.#source[this.#at];
      if (char === '\\') this.#at += 2;
      else if (char === '`') {
        this.#at += 1;
        this.#emit(this.#source.slice(start, this.#at));
        return true;
      } else if (char === '$' && this.#source[this.#at + 1] === '{') {
        this.#at += 2;
        this.#emit(this.#source.slice(start, this.#at));
        this.#templates.push(this.#braces);
        this.#braces += 1;
        return true;
      } else this.#at += 1;
    }
    return false;
  }

  /** Go's raw string: no escapes, ends at the next backquote. */
  #rawBackquoted(): boolean {
    const end = this.#source.indexOf('`', this.#at + 1);
    if (end === -1) return false;
    const start = this.#at;
    this.#at = end + 1;
    this.#emit(this.#source.slice(start, this.#at));
    return true;
  }

  #regexMayStart(): boolean {
    const previous = this.#lastSignificant();
    if (previous === null) return true;
    if (WORD.test(previous.slice(-1))) return REGEX_AFTER_WORDS.has(previous);
    return !OPERAND_END.test(previous.slice(-1));
  }

  #lastSignificant(): string | null {
    if (this.#run !== null) return this.#run;
    return this.tokens.at(-1) ?? null;
  }

  #regex(): boolean {
    const start = this.#at;
    this.#at += 1;
    let inClass = false;
    while (this.#at < this.#source.length) {
      const char = this.#source[this.#at];
      if (char === '\\') this.#at += 2;
      else if (char === '\n') return false;
      else {
        if (char === '[') inClass = true;
        else if (char === ']') inClass = false;
        this.#at += 1;
        if (char === '/' && !inClass) {
          while (WORD.test(this.#source[this.#at] ?? '')) this.#at += 1;
          this.#emit(this.#source.slice(start, this.#at));
          return true;
        }
      }
    }
    return false;
  }

  #word(): boolean {
    const start = this.#at;
    while (WORD.test(this.#source[this.#at] ?? '')) this.#at += 1;
    this.#emit(this.#source.slice(start, this.#at));
    return true;
  }

  #punctuation(char: string): boolean {
    this.#at += 1;
    if (char === '{') this.#braces += 1;
    if (char === '}') {
      this.#braces -= 1;
      if (this.#templates.at(-1) === this.#braces) {
        this.#templates.pop();
        this.#at -= 1;
        return this.#templateResume();
      }
    }
    this.#run = (this.#run ?? '') + char;
    return true;
  }

  /** After the `}` that closes a `${`: the template goes on to its end or its next `${`. */
  #templateResume(): boolean {
    this.#breakRun();
    const start = this.#at;
    this.#at += 1;
    while (this.#at < this.#source.length) {
      const char = this.#source[this.#at];
      if (char === '\\') this.#at += 2;
      else if (char === '`') {
        this.#at += 1;
        this.#emit(this.#source.slice(start, this.#at));
        return true;
      } else if (char === '$' && this.#source[this.#at + 1] === '{') {
        this.#at += 2;
        this.#emit(this.#source.slice(start, this.#at));
        this.#templates.push(this.#braces);
        this.#braces += 1;
        return true;
      } else this.#at += 1;
    }
    return false;
  }

  /** Rust literals that start like a word or a quote: raw and byte strings, chars, lifetimes. */
  #rustLiteral(): boolean | null {
    const rest = this.#source.slice(this.#at, this.#at + 4);
    const raw = /^(?:b|c)?r(#*)"/u.exec(rest);
    if (raw !== null && !this.#inWord()) return this.#rawString(raw[0].length, raw[1] ?? '');
    if (/^(?:b|c)"/u.test(rest) && !this.#inWord()) {
      this.#at += 1;
      return this.#quotedFrom(this.#at - 1);
    }
    if (rest.startsWith("b'") && !this.#inWord()) {
      this.#at += 1;
      return this.#charOrLifetime(this.#at - 1);
    }
    if (rest.startsWith("'")) return this.#charOrLifetime(this.#at);
    return null;
  }

  #inWord(): boolean {
    return this.#at > 0 && WORD.test(this.#source[this.#at - 1] ?? '');
  }

  #quotedFrom(start: number): boolean {
    const quoteAt = this.#at;
    const found = this.#quoted('"');
    if (!found) return false;
    const token = this.tokens.pop() ?? '';
    this.tokens.push(this.#source.slice(start, quoteAt) + token);
    return true;
  }

  #rawString(openLength: number, hashes: string): boolean {
    const start = this.#at;
    const close = `"${hashes}`;
    const end = this.#source.indexOf(close, this.#at + openLength);
    if (end === -1) return false;
    this.#at = end + close.length;
    this.#emit(this.#source.slice(start, this.#at));
    return true;
  }

  /** `'a'`, `'\n'`, `'\u{1F600}'` are chars; `'a` (no closing quote next) is a lifetime. */
  #charOrLifetime(start: number): boolean {
    const quote = this.#at;
    const char = /^'(?:\\u\{[0-9a-fA-F]{1,6}\}|\\.|[^\\'\n])'/u.exec(this.#source.slice(quote));
    if (char !== null) {
      this.#at = quote + char[0].length;
      this.#emit(this.#source.slice(start, this.#at));
      return true;
    }
    const lifetime = /^'[\p{L}_][\p{L}\p{N}_]*/u.exec(this.#source.slice(quote));
    if (lifetime === null) return false;
    this.#at = quote + lifetime[0].length;
    this.#emit(this.#source.slice(start, this.#at));
    return true;
  }
}

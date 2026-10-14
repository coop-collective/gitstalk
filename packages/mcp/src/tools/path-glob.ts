/**
 * Path globs for `repo_read`, as agents write them for ripgrep: `*` within a segment, `**`
 * across segments, `?` one character, `{a,b}` alternatives. A glob without a slash matches a
 * file name at any depth (`*.ts`), as `rg -g` does.
 */

const WILDCARD = /[*?{[]/;

/** The matcher for repository paths; `base` (a directory) is where a relative glob starts. */
export function globMatcher(glob: string, base = ''): (path: string) => boolean {
  const pattern = anchored(glob.trim().replace(/^\.?\//, ''), base);
  const regex = new RegExp(`^${translate(pattern)}$`);
  return (path) => regex.test(path);
}

/** The directory a glob cannot match outside of (`src/app` for `src/app/*.ts`), or ''. */
export function globRoot(glob: string, base = ''): string {
  const segments = anchored(glob.trim().replace(/^\.?\//, ''), base).split('/');
  const fixed: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    if (WILDCARD.test(segment)) break;
    fixed.push(segment);
  }
  return fixed.join('/');
}

function anchored(glob: string, base: string): string {
  const scoped = glob.includes('/') ? glob : `**/${glob}`;
  const dir = base.replace(/^\/+|\/+$/g, '');
  return dir === '' ? scoped : `${dir}/${scoped}`;
}

function translate(glob: string): string {
  let out = '';
  let index = 0;
  while (index < glob.length) {
    const rest = glob.slice(index);
    const step = token(rest);
    out += step.regex;
    index += step.length;
  }
  return out;
}

function token(rest: string): { readonly regex: string; readonly length: number } {
  if (rest.startsWith('**/')) return { regex: '(?:.*/)?', length: 3 };
  if (rest.startsWith('**')) return { regex: '.*', length: 2 };
  const char = rest.charAt(0);
  if (char === '*') return { regex: '[^/]*', length: 1 };
  if (char === '?') return { regex: '[^/]', length: 1 };
  if (char === '{') {
    const close = rest.indexOf('}');
    if (close > 0) {
      const options = rest.slice(1, close).split(',').map(translate);
      return { regex: `(?:${options.join('|')})`, length: close + 1 };
    }
  }
  return { regex: char.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`), length: 1 };
}

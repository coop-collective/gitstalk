/**
 * Where the Code tab is open, read from its URL: a folder (`<base>`, `<base>/tree/<path>`) or a
 * file (`<base>/blob/<path>`), at a ref (`?ref=`), a Markdown file as its source (`?plain=1`).
 * The Code workspace opens folders and files in the browser by writing these URLs to the
 * history (`history.pushState`), so the URL, not a page render, says what the main pane shows.
 * Pure, so it is tested without a router.
 */
import { PRODUCT_NAME } from '../site/page-metadata';
import type { CodeView, RefChoice } from './tree';
import { codeHref, readRef, refLabel } from './tree';

/** A folder or a file to open, at the ref already browsed. */
export type CodeTarget = {
  readonly view: CodeView;
  readonly path: string;
  /** A Markdown file shown as its source (`?plain=1`); folders ignore it. */
  readonly plain?: boolean;
};

/** A folder or a file at a ref: what one Code URL names. */
export type OpenLocation = {
  readonly view: CodeView;
  readonly path: string;
  readonly ref: RefChoice;
  readonly plain: boolean;
};

/**
 * The location a URL of the repository at `base` (`/<owner>/<repo>`, as `repositoryPath`
 * encodes it) names, or null when it is not a Code URL of that repository (another tab, another
 * repository, a malformed escape). Segments compare decoded, so `%7E` and `~` are the same.
 */
export function locationOfUrl(base: string, pathname: string, search: string): OpenLocation | null {
  const own = segmentsOf(base);
  const segments = segmentsOf(pathname);
  if (own === null || segments === null) return null;
  if (!own.every((segment, index) => segments[index] === segment)) return null;
  const [view, ...path] = segments.slice(own.length);
  const query = new URLSearchParams(search);
  const at = { ref: readRef(query.get('ref') ?? undefined), plain: query.get('plain') === '1' };
  if (view === undefined) return { view: 'tree', path: '', ...at };
  if (view !== 'tree' && view !== 'blob') return null;
  if (view === 'blob' && path.length === 0) return null;
  return { view, path: path.join('/'), ...at };
}

/** Whether two locations show the same thing (`plain` counts only on a file). */
export function isSameLocation(a: OpenLocation, b: OpenLocation): boolean {
  return (
    a.view === b.view &&
    a.path === b.path &&
    refLabel(a.ref) === refLabel(b.ref) &&
    (a.view === 'tree' || a.plain === b.plain)
  );
}

/** The location `target` names at `ref`. */
export function locationAt(target: CodeTarget, ref: RefChoice): OpenLocation {
  return { view: target.view, path: target.path, ref, plain: target.plain === true };
}

/** The URL of `location` in the repository at `base`. */
export function hrefOf(base: string, location: OpenLocation): string {
  const href = codeHref(base, location.view, location.path, location.ref);
  if (location.view === 'tree' || !location.plain) return href;
  return `${href}${href.includes('?') ? '&' : '?'}plain=1`;
}

/** The document title the Code pages give `location` (their `generateMetadata`, with the root template). */
export function codeTitle(location: OpenLocation, owner: string, repo: string): string {
  const where = location.path === '' ? '' : `${location.path}, `;
  return `${where}${owner}/${repo} · ${PRODUCT_NAME}`;
}

/** A path's segments, decoded; null when one is not a valid escape. */
function segmentsOf(pathname: string): readonly string[] | null {
  try {
    return pathname
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => decodeURIComponent(segment));
  } catch {
    // A malformed escape (`%E0%A4%A`) names no location; the router keeps such a URL.
    return null;
  }
}

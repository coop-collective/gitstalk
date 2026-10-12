import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * vinext runs the layouts above a route's first `loading.tsx` before it streams, and nothing
 * below it: a 404 or redirect thrown under a loading boundary can no longer set the status, so
 * the browser gets a 200 skeleton followed by a not-found page (or a redirect in the page). These
 * tests read the route tree and the sources and keep every status-deciding call where it counts.
 */

/**
 * The calls that end a request with a status: Next's own, and the server helpers that make
 * them. For each, the gate a layout at or above a page's first loading boundary must already
 * call (the helpers are memoised per request, so the page's own call reuses that answer), or
 * null when the call depends on the page and may not run under a loading boundary at all.
 */
const STATUS_CALLS: Readonly<Record<string, string | null>> = {
  notFound: null,
  redirect: null,
  permanentRedirect: null,
  // A section the viewer may not open redirects to another: that depends on the page.
  repositorySettings: null,
  orgSettings: null,
  accountPage: null,
  requirePlatformAdmin: null,
  redirectToAdmin: null,
  repositoryPage: 'repositoryPage',
  repositoryTab: 'repositoryPage',
  actionsPage: 'repositoryPage',
  engineTab: 'engineTab',
  askPage: 'askPage',
  settingsAccess: 'settingsAccess',
  pageOwner: 'pageOwner',
  signedInUser: 'signedInUser',
};

/**
 * Every module outside `app/` that imports a status call from `next/navigation`, and the
 * exported helpers it adds to `STATUS_CALLS`. A new one fails the test until it is placed here.
 */
const STATUS_MODULES: Readonly<Record<string, readonly string[]>> = {
  'src/server/repository-page.ts': ['repositoryPage'],
  'src/server/repository-tab.ts': ['engineTab'],
  'src/server/ask-page.ts': ['askPage'],
  'src/server/repository-settings.ts': ['settingsAccess', 'repositorySettings'],
  'src/server/owner-page.ts': ['pageOwner'],
  'src/server/signed-in.ts': ['signedInUser'],
  'src/server/account-page.ts': ['accountPage'],
  'src/server/org-settings.ts': ['orgSettings'],
  'src/admin/admin-gate.ts': ['requirePlatformAdmin', 'redirectToAdmin'],
  // Server actions answer a form's post, never a page's render.
  'src/server/actions.ts': [],
  'src/server/collaborator-actions.ts': [],
  'src/server/org-actions.ts': [],
  'src/server/repository-actions.ts': [],
  'src/server/workflow-actions.ts': [],
  // A query that names something missing (`?bean=`, `?file=`, `?t=`) deep in the explorers:
  // under a skeleton, the not-found page inside a 200 (known; the addresses themselves answer).
  'components/home/repository-home.tsx': [],
  'components/explorer/files-explorer.tsx': [],
};

/** Late status calls accepted on purpose, with the reason. */
const KNOWN_LATE: Readonly<Record<string, string>> = {
  '[owner]/(profile)/page.tsx notFound':
    'an org deleted between the layout resolving its handle and the page reading it',
};

const webDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
const appDir = join(webDir, 'app');

describe('the app routes', () => {
  const tree = readTree(appDir);
  const dirsWith = (name: string) => withFile(tree, name);

  it('put no layout under a loading boundary', () => {
    const loadings = dirsWith('loading.tsx');
    const late = dirsWith('layout.tsx').filter((layout) =>
      loadings.some((loading) => isStrictlyInside(layout, loading)),
    );
    expect(late).toEqual([]);
  });

  it('decide every status before streaming', () => {
    const late = lateStatusCalls(tree).filter((call) => KNOWN_LATE[call] === undefined);
    expect(late).toEqual([]);
  });

  it('check access in the layouts above the skeletons and the settings', () => {
    const gates = [
      ['[owner]/[repo]/layout.tsx', 'repositoryPage('],
      ['[owner]/[repo]/settings/layout.tsx', 'settingsAccess('],
      ['[owner]/[repo]/changes/layout.tsx', 'engineTab('],
      ['[owner]/[repo]/history/layout.tsx', 'engineTab('],
      ['[owner]/[repo]/ask/layout.tsx', 'askPage('],
      ['[owner]/(profile)/layout.tsx', 'pageOwner('],
      ['orgs/(list)/layout.tsx', 'signedInUser('],
    ] as const;
    for (const [layout, check] of gates) expect(tree.get(layout), layout).toContain(check);
  });

  it('put repository settings, run pages and a bean under no skeleton', () => {
    const loadings = dirsWith('loading.tsx');
    const pages = [
      '[owner]/[repo]/settings/general',
      '[owner]/[repo]/changes/[bean]',
      '[owner]/[repo]/actions/runs/[run]',
      '[owner]/[repo]/automations/runs/[run]',
      '[owner]/[repo]/automations/edit/[file]',
      '[owner]/[repo]/stalk',
    ];
    for (const page of pages) {
      expect(tree.has(`${page}/page.tsx`), page).toBe(true);
      expect(
        loadings.filter((loading) => isInsideOrSelf(page, loading)),
        page,
      ).toEqual([]);
    }
  });
});

describe('the status check', () => {
  it('catches a check made in a page under a loading boundary', () => {
    // The tree before the settings moved out from under the repository's skeleton.
    const tree = new Map([
      ['[owner]/[repo]/layout.tsx', 'await repositoryPage(params);'],
      ['[owner]/[repo]/loading.tsx', ''],
      ['[owner]/[repo]/page.tsx', 'const tab = await repositoryTab(params);'],
      ['[owner]/[repo]/settings/page.tsx', "await repositorySettings(params, 'landing');"],
      ['[owner]/[repo]/changes/page.tsx', 'if (tab.reads === null) redirect(tab.base);'],
    ]);
    expect(lateStatusCalls(tree)).toEqual([
      '[owner]/[repo]/changes/page.tsx redirect',
      '[owner]/[repo]/settings/page.tsx repositorySettings',
    ]);
  });

  it('accepts a check a layout above the boundary already made', () => {
    const tree = new Map([
      ['[owner]/[repo]/layout.tsx', 'await repositoryPage(params);'],
      ['[owner]/[repo]/changes/layout.tsx', 'await engineTab(params);'],
      ['[owner]/[repo]/changes/loading.tsx', ''],
      ['[owner]/[repo]/changes/page.tsx', 'const tab = await engineTab(params);'],
      ['[owner]/[repo]/history/loading.tsx', ''],
      ['[owner]/[repo]/history/page.tsx', 'const tab = await engineTab(params);'],
    ]);
    expect(lateStatusCalls(tree)).toEqual(['[owner]/[repo]/history/page.tsx engineTab']);
  });
});

describe('the status helpers', () => {
  it('are all known, with what each one adds', () => {
    const modules = [...readTree(webDir, ['src', 'components'])]
      .filter(([path, source]) => !path.endsWith('.test.ts') && importsStatusCall(source))
      .map(([path]) => path)
      .toSorted();
    expect(modules).toEqual(Object.keys(STATUS_MODULES).toSorted());
    for (const helper of Object.values(STATUS_MODULES).flat())
      expect(Object.keys(STATUS_CALLS), helper).toContain(helper);
  });
});

/**
 * `<page> <call>` for each status call a page under a loading boundary makes without a layout
 * at or above its first boundary having made the gate. `tree` maps paths under `app/` to sources.
 */
function lateStatusCalls(tree: ReadonlyMap<string, string>): string[] {
  const loadings = withFile(tree, 'loading.tsx');
  const layouts = withFile(tree, 'layout.tsx');
  return withFile(tree, 'page.tsx').flatMap((page) => {
    const boundary = loadings
      .filter((loading) => isInsideOrSelf(page, loading))
      .toSorted((a, b) => a.length - b.length)[0];
    if (boundary === undefined) return [];
    const preStream = layouts
      .filter((layout) => isInsideOrSelf(boundary, layout))
      .map((layout) => tree.get(fileIn(layout, 'layout.tsx')) ?? '');
    const source = tree.get(fileIn(page, 'page.tsx')) ?? '';
    return Object.entries(STATUS_CALLS)
      .filter(([call]) => calls(source, call))
      .filter(([, gate]) => gate === null || !preStream.some((layout) => calls(layout, gate)))
      .map(([call]) => `${fileIn(page, 'page.tsx')} ${call}`);
  });
}

function calls(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\(`).test(source);
}

function importsStatusCall(source: string): boolean {
  const imported = /import\s*\{([^}]*)\}\s*from\s*'next\/navigation'/.exec(source)?.[1] ?? '';
  return /\b(notFound|redirect|permanentRedirect)\b/.test(imported);
}

/** The directories (relative, `.` for the root) holding a file named `name`. */
function withFile(tree: ReadonlyMap<string, string>, name: string): string[] {
  return [...tree.keys()]
    .filter((file) => file === name || file.endsWith(`/${name}`))
    .map((file) => dirname(file))
    .toSorted();
}

function fileIn(dir: string, name: string): string {
  return dir === '.' ? name : `${dir}/${name}`;
}

/** Every file under `root` (or under its `subdirs`), by `/`-separated path relative to it. */
function readTree(root: string, subdirs: readonly string[] = ['.']): Map<string, string> {
  const paths = subdirs.flatMap((subdir) => listFiles(join(root, subdir)));
  return new Map(
    paths
      .filter((path) => /\.(tsx?|css)$/.test(path))
      .map((path) => [relative(root, path).split(sep).join('/'), readFileSync(path, 'utf8')]),
  );
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

function isStrictlyInside(dir: string, ancestor: string): boolean {
  return ancestor === '.' ? dir !== '.' : dir.startsWith(`${ancestor}/`);
}

function isInsideOrSelf(dir: string, ancestor: string): boolean {
  return dir === ancestor || isStrictlyInside(dir, ancestor);
}

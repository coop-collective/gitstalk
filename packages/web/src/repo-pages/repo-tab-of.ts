/**
 * Which repository tab an address shows, for the header the repository layout keeps mounted
 * across tabs (components/repo-tabs/repository-frame.tsx): it reads the tab from the URL, as
 * the pages under it no longer draw the header themselves. Pure, so client and tests share it.
 */
import type { RepoTab } from '../../components/home/repo-head';
import type { RepoSettingsFacts } from '../settings/sections';
import { firstRepoSection, repoSettingsPath } from '../settings/sections';

/** Query keys that open the Ask view on the repository's root rather than the Code tab. */
export const ASK_KEYS = ['q', 'bean', 't', 'removed'] as const;

/** The tab of each first path segment under `/<owner>/<repo>`. */
const TAB_OF_SEGMENT: Readonly<Record<string, RepoTab>> = {
  tree: 'code',
  blob: 'code',
  files: 'ask',
  changes: 'changes',
  history: 'history',
  stalk: 'history',
  actions: 'automations',
  automations: 'automations',
  ask: 'ask',
  people: 'people',
  settings: 'settings',
};

/**
 * The tab `pathname` shows under the repository at `base` (null when it is not under it or
 * names no tab). The root is Code, or Ask when the query carries one of the Ask view's keys.
 */
export function repoTabOf(
  base: string,
  pathname: string,
  query: { has(key: string): boolean },
): RepoTab | null {
  const rest = relativePath(base, pathname);
  if (rest === null) return null;
  if (rest === '') return ASK_KEYS.some((key) => query.has(key)) ? 'ask' : 'code';
  return TAB_OF_SEGMENT[rest.split('/')[0] ?? ''] ?? null;
}

/**
 * Where the Settings tab links: the first section this viewer may open, so the click is one
 * navigation instead of `/settings` and its redirect. Actions never change which section is
 * first, so the header needs only the role and the archive state.
 */
export function settingsTabHref(
  base: string,
  facts: Pick<RepoSettingsFacts, 'role' | 'isArchived'>,
): string {
  return repoSettingsPath(base, firstRepoSection({ ...facts, hasActions: false }));
}

/** The path after `base` without its leading slash, or null when `pathname` is elsewhere. */
function relativePath(base: string, pathname: string): string | null {
  const path = safeDecode(pathname).replace(/\/+$/, '');
  const root = safeDecode(base).replace(/\/+$/, '');
  if (path === root) return '';
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}

function safeDecode(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    // A malformed escape is compared as it is.
    return path;
  }
}

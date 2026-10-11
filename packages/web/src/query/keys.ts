/**
 * The one query-key factory for client data (TanStack Query). Every key that holds private
 * data starts with its area and the viewer's id, so one person's cache never answers for
 * another: signing in or out changes every key, and `QueryProvider` also clears the cache.
 *
 * Keys are arrays from the general to the specific, so a prefix invalidates a whole area:
 * `invalidateQueries({ queryKey: qk.repo(uid, owner, repo).all })` refreshes every query of
 * that repository for that viewer.
 */

/** The viewer segment of a key when nobody is signed in. */
export const ANONYMOUS_VIEWER = 'anon';

/** A signed-in person's id, or `ANONYMOUS_VIEWER`. */
export type ViewerKey = string;

/** The viewer segment of a key: the user's id, or `'anon'` when signed out. */
export function viewerKey(userId: string | null | undefined): ViewerKey {
  return userId === null || userId === undefined || userId === '' ? ANONYMOUS_VIEWER : userId;
}

/** Query keys by area. Pass the user's id (or null when signed out) as `uid`. */
export const qk = {
  /** The signed-in person's own account data. */
  viewer: (uid: string | null) => {
    const all = ['viewer', viewerKey(uid)] as const;
    return {
      all,
      /** Connected agent sessions. */
      sessions: () => [...all, 'sessions'] as const,
    };
  },
  /** The home page's panels. */
  home: (uid: string | null) => {
    const all = ['home', viewerKey(uid)] as const;
    return {
      all,
      /** Recent activity across the viewer's repositories. */
      activity: () => [...all, 'activity'] as const,
      /** Growth figures (repositories, beans, landings over time). */
      growth: () => [...all, 'growth'] as const,
    };
  },
  /** One repository as one viewer sees it. */
  repo: (uid: string | null, owner: string, repo: string) => {
    const all = ['repo', viewerKey(uid), owner, repo] as const;
    return {
      all,
      /** The engine's event feed (ordered by `seq`, appended by the live feed). */
      events: () => [...all, 'events'] as const,
      /** Recent pushes. */
      pushed: () => [...all, 'pushed'] as const,
      /** One bean's detail, by name. */
      bean: (name: string) => [...all, 'bean', name] as const,
      /** One Actions run, by id. */
      run: (runId: string) => [...all, 'run', runId] as const,
    };
  },
} as const;

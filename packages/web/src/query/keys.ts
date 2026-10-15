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
      /** One finished job's log: never changes once the job is done. */
      jobLog: (runId: string, jobId: string) =>
        [...all, 'run', runId, 'job', jobId, 'log'] as const,
      /** Actions runs under one filter (`?status=…&workflow=…`, as the page encodes it). */
      runs: (filter: string) => [...all, 'runs', filter] as const,
      /** The diff between two commits: immutable, whatever bean it belongs to. */
      diff: (base: string, head: string) => [...all, 'diff', base, head] as const,
      /** The whole tree at a commit sha. */
      tree: (sha: string) => [...all, 'tree', sha] as const,
      /** One file at a commit sha. */
      file: (sha: string, path: string) => [...all, 'file', sha, path] as const,
      /** One folder's entries at a commit sha (the Code tab's file tree; '' is the root). */
      folder: (sha: string, path: string) => [...all, 'folder', sha, path] as const,
      /** Every file's path at a commit sha (Go to file). */
      paths: (sha: string) => [...all, 'paths', sha] as const,
      /**
       * The Code tab's stalk as last drawn, so the next page shows it while its own streams in.
       * Kept in memory only: it moves with every landing.
       */
      stalk: () => [...all, 'stalk'] as const,
      /**
       * The events after `seq`, for a page that watches the feed without the whole log (the
       * Code and History tabs' head watcher).
       */
      tail: (seq: number) => [...all, 'tail', seq] as const,
    };
  },
} as const;

'use client';

/**
 * `useActionState` for a server action whose success changes client data: once the action
 * returns a state that `isSuccess` accepts, the given queries are invalidated (and refetched
 * where they are on screen). The server action is passed to React untouched, so the form
 * still submits before hydration (progressive enhancement); invalidation then happens on
 * the next page's own fetch.
 *
 * ```tsx
 * const [state, formAction, isPending] = useActionWithInvalidation(revokeSession, idle, {
 *   isSuccess: (result) => result.kind === 'done',
 *   invalidate: [qk.viewer(uid).sessions()],
 * });
 * return <form action={formAction}>…</form>;
 * ```
 *
 * Server-rendered data is refreshed by the action itself (`revalidatePath`, `redirect`);
 * this hook covers the TanStack Query cache, which the server cannot see.
 */
import type { QueryKey } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useActionState, useEffect, useRef } from 'react';

export type InvalidationOptions<State> = {
  /** Whether a returned state means the mutation happened. */
  readonly isSuccess: (state: State) => boolean;
  /** The queries to invalidate (prefixes match: `qk.repo(...).all` covers the repository). */
  readonly invalidate: readonly QueryKey[] | ((state: State) => readonly QueryKey[]);
  /** `useActionState`'s permalink, for forms submitted before hydration. */
  readonly permalink?: string;
};

export function useActionWithInvalidation<State, Payload>(
  action: (state: Awaited<State>, payload: Payload) => State | Promise<State>,
  initialState: Awaited<State>,
  options: InvalidationOptions<Awaited<State>>,
): [state: Awaited<State>, dispatch: (payload: Payload) => void, isPending: boolean] {
  const queryClient = useQueryClient();
  const [state, dispatch, isPending] = useActionState(action, initialState, options.permalink);
  // The state already handled: the initial one, so a success-shaped initial state does nothing.
  const handled = useRef(state);
  const { isSuccess, invalidate } = options;

  useEffect(() => {
    if (state === handled.current) return;
    handled.current = state;
    if (!isSuccess(state)) return;
    const keys = typeof invalidate === 'function' ? invalidate(state) : invalidate;
    // invalidateQueries does not reject (refetch errors land on the queries themselves).
    void Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  }, [state, isSuccess, invalidate, queryClient]);

  return [state, dispatch, isPending];
}

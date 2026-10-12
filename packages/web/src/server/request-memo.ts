/**
 * Reads shared by everything one request renders, by key. vinext probes a route's layouts
 * (above its first `loading.tsx`) before it renders them, outside React's render, so React's
 * `cache()` does not carry a read from the probe into the render; `cacheForRequest` does, so a
 * layout's access check, the page under it and the header each cost one read. Outside a
 * request (tests, build time) nothing is kept. Server-only.
 */
import { cacheForRequest } from 'vinext/cache';

/** The first call for a key reads; later calls in the same request share its promise. */
export type KeyedRead<T> = (key: string, read: () => Promise<T>) => Promise<T>;

export function keyedForRequest<T>(): KeyedRead<T> {
  const requestReads = cacheForRequest(() => new Map<string, Promise<T>>());
  return (key, read) => sharedRead(requestReads(), key, read);
}

/** The read held under `key`, or a new one held there (also when it rejects: same outcome). */
export function sharedRead<T>(
  held: Map<string, Promise<T>>,
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  const existing = held.get(key);
  if (existing !== undefined) return existing;
  const started = read();
  held.set(key, started);
  return started;
}

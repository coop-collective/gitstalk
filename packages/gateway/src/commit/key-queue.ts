/**
 * One key's work at a time, in one Durable Object: a double-clicked save sends two requests
 * with the same idempotency key at once, and the second must find the first's recorded result
 * (a replay), not push a second bean. Keys are independent; nothing is held between tries.
 */

/** Runs `work` once every earlier call with the same `id` has settled. */
export type KeyQueue = <T>(id: string, work: () => Promise<T>) => Promise<T>;

export function keyQueue(): KeyQueue {
  const tails = new Map<string, Promise<void>>();
  return async <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const previous = tails.get(id) ?? Promise.resolve();
    const done = Promise.withResolvers<void>();
    tails.set(id, done.promise);
    await previous;
    try {
      return await work();
    } finally {
      done.resolve();
      if (tails.get(id) === done.promise) tails.delete(id);
    }
  };
}

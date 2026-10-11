/**
 * `Array.map` for async work with at most `limit` calls in flight, results in input order.
 * Home uses it for the per-repository fallback reads, so one account with many repositories
 * cannot open dozens of gateway calls at once.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await work(item);
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}

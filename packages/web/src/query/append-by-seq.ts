/**
 * Merging a live feed's batches into the events a query already holds. Events carry a
 * strictly increasing `seq` from the server; batches can repeat events (a reconnect resumes
 * from the last id the browser saw), arrive out of order, or skip some (a dropped message).
 */

/** Anything a feed delivers: an event with the server's sequence number. */
export type Sequenced = { readonly seq: number };

/**
 * What a batch did to the held events:
 * - `unchanged`: every event was already held (the same array comes back);
 * - `appended`: new events, contiguous with what was held;
 * - `gap`: new events, but a seq right before one of them is missing, so the caller should
 *   refetch the whole list (the merged events are still returned in order).
 */
export type AppendOutcome<T extends Sequenced> =
  | { readonly kind: 'unchanged'; readonly events: readonly T[] }
  | { readonly kind: 'appended'; readonly events: readonly T[] }
  | { readonly kind: 'gap'; readonly events: readonly T[] };

/**
 * Merges `batch` into `held`: drops events whose seq is already held (the held copy wins),
 * keeps the result sorted by seq, and reports whether the seqs stay contiguous. `held` is
 * assumed sorted (it always is when every write goes through here). A feed that restarts
 * from scratch is not detectable from seqs alone: replace the list instead (`setQueryData`
 * with the new snapshot, or `invalidateQueries`).
 */
export function appendBySeq<T extends Sequenced>(
  held: readonly T[],
  batch: readonly T[],
): AppendOutcome<T> {
  const heldSeqs = new Set(held.map((event) => event.seq));
  const fresh = uniqueBySeq(batch).filter((event) => !heldSeqs.has(event.seq));
  if (fresh.length === 0) return { kind: 'unchanged', events: held };
  const events = mergeSorted(held, fresh);
  const freshSeqs = new Set(fresh.map((event) => event.seq));
  return { kind: opensGap(events, freshSeqs) ? 'gap' : 'appended', events };
}

/** The last seq held, or `fallback` when nothing is (a feed's `?after=` cursor). */
export function lastSeq(events: readonly Sequenced[], fallback = 0): number {
  return events.at(-1)?.seq ?? fallback;
}

/** The batch sorted by seq with repeats dropped (the first copy wins). */
function uniqueBySeq<T extends Sequenced>(batch: readonly T[]): readonly T[] {
  const bySeq = new Map<number, T>();
  for (const event of batch) if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);
  return [...bySeq.values()].toSorted((a, b) => a.seq - b.seq);
}

/** Two seq-sorted lists without common seqs, merged into one. */
function mergeSorted<T extends Sequenced>(left: readonly T[], right: readonly T[]): readonly T[] {
  const lastLeft = left.at(-1);
  const firstRight = right[0];
  // The live case: everything new comes after everything held.
  if (lastLeft === undefined || firstRight === undefined || lastLeft.seq < firstRight.seq)
    return [...left, ...right];
  return [...left, ...right].toSorted((a, b) => a.seq - b.seq);
}

/**
 * Whether a new event does not directly follow the one before it. Holes the held list already
 * had (a snapshot that skips seqs) are not reported again on every batch.
 */
function opensGap(events: readonly Sequenced[], freshSeqs: ReadonlySet<number>): boolean {
  return events.some((event, index) => {
    const previous = events[index - 1];
    return previous !== undefined && freshSeqs.has(event.seq) && event.seq !== previous.seq + 1;
  });
}

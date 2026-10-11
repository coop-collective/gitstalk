/**
 * One line about what a repository's engine has grown, for the home's repository list: read
 * from the run read RPC (`runView`) keyed by the repository's engine id. An engine that does
 * not answer (not opened yet, or the stub) reads as "nothing grown yet", never as an error.
 */
import { z } from 'zod';

export type Growth =
  | { readonly kind: 'none' }
  /** Not read: the account has more repositories than Home asks engines about one by one. */
  | { readonly kind: 'unknown' }
  | { readonly kind: 'grown'; readonly onStalk: number; readonly growing: number };

const View = z.object({ tasks: z.record(z.string(), z.number()) });

/** The binding's `runView`, if it has one. */
type RunViewer = { runView(run: string): Promise<unknown> };

/** A summary must answer within this, or the home lists the repository without it. */
const SUMMARY_TIMEOUT_MS = 1500;

export async function growthOf(binding: object, engineId: string): Promise<Growth> {
  if (!hasRunView(binding)) return { kind: 'none' };
  try {
    const result = await Promise.race([
      binding.runView(engineId),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SUMMARY_TIMEOUT_MS)),
    ]);
    return growthFromView(result);
  } catch {
    // The list still renders without the line; the repository page shows the details.
    return { kind: 'none' };
  }
}

/** Counts from a `runView` result: beans landed or validated, and beans in flight. */
export function growthFromView(result: unknown): Growth {
  const ok = z.object({ ok: z.literal(true), value: View }).safeParse(result);
  if (!ok.success) return { kind: 'none' };
  return growthFromCounts(ok.data.value.tasks);
}

/** Counts by bean status (a view's or an engine feed's): landed or validated, and in flight. */
export function growthFromCounts(tasks: Readonly<Record<string, number>>): Growth {
  const count = (...statuses: string[]): number =>
    statuses.reduce((total, status) => total + (tasks[status] ?? 0), 0);
  const onStalk = count('landed', 'green');
  const growing = count('running', 'queued', 'testing', 'rework');
  return onStalk + growing === 0 ? { kind: 'none' } : { kind: 'grown', onStalk, growing };
}

/** Counts from the repo-events index (`repositoryGrowth`). */
export function growthFromIndex(line: {
  readonly landed: number;
  readonly growing: number;
}): Growth {
  return line.landed + line.growing === 0
    ? { kind: 'none' }
    : { kind: 'grown', onStalk: line.landed, growing: line.growing };
}

export function growthText(growth: Growth): string {
  if (growth.kind === 'unknown') return '—';
  if (growth.kind === 'none') return 'Nothing grown yet';
  const landed = `${growth.onStalk} ${growth.onStalk === 1 ? 'bean' : 'beans'} landed`;
  return growth.growing === 0 ? landed : `${landed}, ${growth.growing} growing`;
}

function hasRunView(binding: object): binding is RunViewer {
  return typeof Reflect.get(binding, 'runView') === 'function';
}

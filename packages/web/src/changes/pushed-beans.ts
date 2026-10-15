/**
 * A repository's pushed beans as the gateway's `pushedBeans` lists them (who pushed each,
 * its title, its phase, its head and landing, its approval hold), validated before a page trusts them. Anything
 * but a valid answer (an older gateway, a race's engine) reads as "no pushed beans", so the
 * pages fall back to the engine's own record of its beans.
 */
import { z } from 'zod';

import { BeanHold, RevisionApproval } from '@gitstalk/shared-race/bean-approval';

import { log } from '../log';

export const PushedBean = z.object({
  bean: z.string(),
  title: z.string(),
  task: z.string().nullable(),
  actor: z.string(),
  head: z.string(),
  pushes: z.number().int(),
  phase: z.enum(['checking', 'landed', 'green', 'red', 'conflict', 'waiting', 'parked', 'dropped']),
  reason: z.string(),
  landed_sha: z.string().nullable(),
  verdict: z.array(z.string()),
  /** Held for a person's approval, or approved (a gateway before approvals sends none). */
  hold: BeanHold.nullable().default(null),
  /** Every approval of its revisions, oldest first, for its journey (an older gateway: none). */
  approvals: z.array(RevisionApproval).default([]),
});
export type PushedBean = z.infer<typeof PushedBean>;

const Answer = z.union([
  z.object({ ok: z.literal(true), value: z.array(PushedBean) }),
  z.object({ ok: z.literal(false) }),
]);

export async function readPushedBeans(
  binding: object,
  engineId: string,
): Promise<readonly PushedBean[]> {
  const method: unknown = Reflect.get(binding, 'pushedBeans');
  if (typeof method !== 'function') return [];
  try {
    const answer = Answer.safeParse(await Reflect.apply(method, binding, [engineId]));
    return answer.success && answer.data.ok ? answer.data.value : [];
  } catch (error: unknown) {
    log.warn('pushed beans unreadable; the page shows the engine record only', { engineId, error });
    return [];
  }
}

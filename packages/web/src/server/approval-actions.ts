'use server';

/**
 * Approve on a held bean's page (`docs/claude-opus/32-approval-rules.md` §5): the form is
 * checked (same origin, session, CSRF), the person must be able to see the repository, and then
 * the gateway's `approveBean`, the same RPC MCP `bean_approve` calls, decides: the owner and
 * maintainers approve, a stale revision is refused, and the approval is audited and the bean
 * re-submitted. The page follows the result through its live queries.
 */
import { env } from 'cloudflare:workers';
import { revalidatePath } from 'next/cache';

import type { BeanApproval } from '@gitstalk/shared-race/bean-approval';

import { approveBeanOn } from '../changes/approval-client';
import { log } from '../log';
import { lookupRepository } from '../repositories/flows';
import { repositoryPath } from '../repositories/paths';
import { registryClient } from '../repositories/registry-client';
import { field, signedInForm } from './signed-in-form';

export type ApprovalState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'approved';
      readonly revision: string;
      readonly approval: BeanApproval;
      readonly resubmitted: boolean;
    }
  | { readonly kind: 'refused'; readonly message: string };

/** Approves the bean the form names (`owner`, `name`, `bean`, `revision`, `note`). */
export async function approveBeanAction(
  _previous: ApprovalState,
  form: FormData,
): Promise<ApprovalState> {
  const checked = await signedInForm(form);
  if ('kind' in checked) return checked;
  const { user } = checked.session;
  const found = await lookupRepository(
    field(form, 'owner'),
    field(form, 'name'),
    user,
    registryClient(env.GATEWAY),
  );
  if (found.kind === 'not-found') return refused('No such repository.');
  const bean = field(form, 'bean');
  const note = field(form, 'note').trim();
  const key = field(form, 'idempotencyKey');
  const outcome = await approveBeanOn(env.GATEWAY, {
    engineId: found.record.engine_id,
    bean,
    request: {
      approver: user.id,
      revision: field(form, 'revision'),
      ...(note === '' ? {} : { note }),
      client: { kind: 'web' },
      ...(key === '' ? {} : { idempotency_key: key }),
    },
  });
  if (!outcome.ok) {
    log.warn('bean approval refused', { repo: found.record.id, bean, code: outcome.code });
    return refused(outcome.message);
  }
  log.info('bean approved', { repo: found.record.id, bean, revision: outcome.value.revision });
  // The client router keeps pages for 30 s; the Changes list must not show it held.
  revalidatePath(
    `${repositoryPath(found.record.owner.handle, found.record.name)}/changes`,
    'layout',
  );
  return {
    kind: 'approved',
    revision: outcome.value.revision,
    approval: outcome.value.approval,
    resubmitted: outcome.value.resubmitted,
  };
}

function refused(message: string): ApprovalState {
  return { kind: 'refused', message };
}

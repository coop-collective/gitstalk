'use server';

/**
 * Server actions: opening and closing the demo gate (platform admins only), and answering a
 * decision card. The gateway does not authenticate RPC calls (the binding is the trust
 * boundary), so every decision is checked against the signed session here first.
 */
import { env } from 'cloudflare:workers';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';

import { RunId, TaskId } from '@gitstalk/shared-race/ids';

import { SESSION_COOKIE, SESSION_SECONDS, isDemoPassword, sessionToken } from '../auth/session';
import { forgeForRun } from '../forge/sources';
import { log } from '../log';
import { CardId } from '@gitstalk/shared-ask/race/race-events';
import { currentUser } from '../auth/user';
import { engineVerdict } from '../repositories/engine-guard';
import { viewerIsPlatformAdmin } from '../admin/admin-gate';
import { ADMIN_DEMO_GATE, ADMIN_RUNS } from '../admin/admin-paths';
import { demoPassword, isDemoGateOpen } from './viewer';

/** Where to go after signing in: a path on this site only. */
const NextPath = z
  .string()
  .regex(/^\/(?!\/)[\w\-./?=&%]*$/)
  .catch('/');

/** Opens the demo gate for this browser: an admin who knows the demo password. */
export async function openDemoGate(formData: FormData): Promise<void> {
  if (!(await viewerIsPlatformAdmin())) notFound();
  const next = NextPath.parse(formData.get('next') ?? ADMIN_RUNS);
  const attempt = formData.get('password');
  const password = demoPassword();
  if (typeof attempt !== 'string' || !(await isDemoPassword(attempt, password))) {
    redirect(`${ADMIN_DEMO_GATE}?error=1&next=${encodeURIComponent(next)}`);
  }
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const jar = await cookies();
  jar.set(SESSION_COOKIE, await sessionToken(password, expiresAt), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_SECONDS,
  });
  redirect(next);
}

/** Closes the demo gate in this browser (only ever removes a cookie). */
export async function closeDemoGate(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect(ADMIN_DEMO_GATE);
}

export type DecisionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'decided'; readonly winner: string }
  | { readonly kind: 'refused'; readonly message: string };

const DecisionForm = z.strictObject({
  run: RunId,
  card: CardId,
  winner: TaskId,
  /** The decision in one line, optional; the gateway keeps at most 2,000 characters. */
  text: z.string().trim().max(2000).optional(),
});

export async function decideCard(
  _previous: DecisionState,
  formData: FormData,
): Promise<DecisionState> {
  const parsed = DecisionForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { kind: 'refused', message: 'That is not a card of this run.' };
  const { run, card, winner, text } = parsed.data;
  const decider = await deciderOf(run);
  if (decider.kind === 'refused') return decider;
  const answer = {
    winner,
    actor: decider.actor,
    ...(text === undefined || text === '' ? {} : { text }),
  };
  const outcome = await forgeForRun(env.GATEWAY, run).decide(run, card, answer);
  if (!outcome.ok) {
    log.warn('decision refused', { run, card, winner, code: outcome.code });
    return { kind: 'refused', message: outcome.message };
  }
  log.info('decision made', { run, card, winner });
  // Pages the client router kept (staleTimes) would otherwise show the card still open.
  revalidatePath('/', 'layout');
  return { kind: 'decided', winner };
}

type Refusal = Extract<DecisionState, { readonly kind: 'refused' }>;

/**
 * Who answers a card. A persistent repository's cards are its maintainers' and owner's (the
 * gateway decides: `mayUseEngine`'s `decide`), answered as their handle; a race's cards are
 * a platform admin's, behind the demo gate too.
 */
async function deciderOf(
  run: string,
): Promise<{ readonly kind: 'allowed'; readonly actor: string } | Refusal> {
  const user = await currentUser();
  const verdict = await engineVerdict(env.GATEWAY, {
    run,
    viewer: user?.id ?? null,
    action: 'decide',
  });
  if (verdict.kind === 'repository' && user !== null)
    return { kind: 'allowed', actor: user.handle };
  if (verdict.kind === 'refused')
    return {
      kind: 'refused',
      message:
        verdict.code === 'forbidden'
          ? 'Answering decisions needs the maintain role on this repository.'
          : 'That is not a card of this run.',
    };
  if (!(await viewerIsPlatformAdmin()))
    return { kind: 'refused', message: 'That is not a card of this run.' };
  if (!(await isDemoGateOpen())) return { kind: 'refused', message: 'Open the demo gate first.' };
  return { kind: 'allowed', actor: 'demo' };
}

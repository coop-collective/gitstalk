/**
 * The admin area's gate, server-only. Anyone who is not a platform admin (signed out included)
 * gets the ordinary 404: the area is never revealed by a 403 or a sign-in prompt.
 */
import { env } from 'cloudflare:workers';
import { notFound, redirect } from 'next/navigation';

import type { User } from '../auth/user';
import type { RunAccess } from '../changes/bean-diff-answer';
import { currentUser, getUser } from '../auth/user';
import { engineVerdict } from '../repositories/engine-guard';
import { adminPathOf } from './admin-paths';
import { isPlatformAdmin } from './platform-admins';

/** The PLATFORM_ADMINS var ('' when unset: nobody is an admin). */
export function configuredPlatformAdmins(): string {
  return typeof env.PLATFORM_ADMINS === 'string' ? env.PLATFORM_ADMINS : '';
}

/** Whether the person signed in on this request (server components, actions) is an admin. */
export async function viewerIsPlatformAdmin(): Promise<boolean> {
  return isPlatformAdmin(await currentUser(), configuredPlatformAdmins());
}

/** The signed-in admin; anyone else gets the not-found page. Every admin page calls this. */
export async function requirePlatformAdmin(): Promise<User> {
  const user = await currentUser();
  if (user === null || !isPlatformAdmin(user, configuredPlatformAdmins())) notFound();
  return user;
}

/** A route handler's signed-in platform admin; null for anyone else (answer them with a 404). */
export async function platformAdminOf(request: Request): Promise<User | null> {
  const user = await getUser(request);
  return isPlatformAdmin(user, configuredPlatformAdmins()) ? user : null;
}

/**
 * What the run routes (`/api/runs/<run>/…`) serve of this engine to the requester. A
 * repository's engine is a run too, and its canvas, Ask page and decision cards stream through
 * these routes, so anyone who may read the repository gets it, with the repository's
 * visibility and cache epoch (which decide whether, and under which keys, its objects may be
 * edge-cached); a benchmark race is the admin area's. Everyone else is refused (answer them
 * with a 404).
 */
export async function runAccess(request: Request, run: string): Promise<RunAccess> {
  const user = await getUser(request);
  const verdict = await engineVerdict(env.GATEWAY, {
    run,
    viewer: user?.id ?? null,
    action: 'read',
  });
  if (verdict.kind === 'repository') {
    const { visibility, updated_at } = verdict.repository;
    return { kind: 'repository', repository: { visibility, updated_at } };
  }
  if (verdict.kind === 'race' && isPlatformAdmin(user, configuredPlatformAdmins()))
    return { kind: 'race' };
  return { kind: 'refused' };
}

/** Whether the run routes serve this engine to the requester at all (`runAccess`). */
export async function mayStreamRun(request: Request, run: string): Promise<boolean> {
  return (await runAccess(request, run)).kind !== 'refused';
}

/** An old public race URL: admins go to its admin page, everyone else gets the 404. */
export async function redirectToAdmin(publicPath: string, query: URLSearchParams): Promise<never> {
  const target = adminPathOf(publicPath, query);
  if (target === null || !(await viewerIsPlatformAdmin())) notFound();
  redirect(target);
}

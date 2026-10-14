/**
 * Who may change a repository's protected paths (`protected_paths` in `.gitstalk/checks.toml`,
 * and `.gitstalk/checks.toml` always): a person with the maintain role or the owner, pushing with
 * their own credential (a personal token or an SSH key). Agent sessions, deploy tokens and
 * engine tokens never may, whoever they act for: what counts as green is a person's decision.
 */
import { z } from 'zod';

import type { SessionVia, ViewerRole } from '@gitstalk/shared-race/collaborators';

import type { GitCredential } from '../auth/git-credential';

/**
 * What a push may do to protected paths, and who it was, for the bean's `remote:` lines; and
 * which credential pushed (`pusher`), for the approval rules' self-approval check
 * (`approval/self-approval.ts`): `oauth:<client>` for an agent session of an OAuth client (its
 * git credential or its server-side commit), `web` for the web editor, `<via>:<id>` for any
 * other credential, `engine` for engine and job tokens, null when unknown (stored before).
 */
export const ProtectedAccess = z.object({
  allowed: z.boolean(),
  who: z.string(),
  pusher: z.string().nullable().default(null),
});
export type ProtectedAccess = z.infer<typeof ProtectedAccess>;

/** Nobody vouched for the push (a bean stored before protected paths existed). */
export const NO_PROTECTED_ACCESS: ProtectedAccess = {
  allowed: false,
  who: 'this push',
  pusher: null,
};

const PEOPLES_OWN: ReadonlySet<SessionVia> = new Set(['personal-token', 'ssh-key']);
const DECIDING_ROLES: ReadonlySet<ViewerRole> = new Set(['owner', 'maintain']);

const VIA_NAMES: Readonly<Record<SessionVia, string>> = {
  'personal-token': 'a personal token',
  'agent-session': 'an agent session token',
  'ssh-key': 'an SSH key',
  'deploy-token': 'a deploy token',
  mcp: 'an MCP session',
};

/** The push's access, from its credential and its person's role on the repository. */
export function protectedAccessOf(
  credential: GitCredential,
  role: ViewerRole | null,
): ProtectedAccess {
  const via = credential.session?.via ?? null;
  const handle = `@${credential.user.handle}`;
  const who =
    credential.engine !== null
      ? `${via === null ? 'an engine token' : VIA_NAMES[via]} acting for ${handle}`
      : `${handle} (${role ?? 'no role'}, with ${via === null ? 'an engine token' : VIA_NAMES[via]})`;
  const allowed = via !== null && PEOPLES_OWN.has(via) && role !== null && DECIDING_ROLES.has(role);
  return { allowed, who, pusher: pusherOf(credential) };
}

/** The credential as the self-approval check names it (see `ProtectedAccess`). */
export function pusherOf(credential: GitCredential): string {
  const { session } = credential;
  if (session === null) return 'engine';
  const client = session.client ?? null;
  if (session.via === 'agent-session' && client !== null) return `oauth:${client}`;
  return `${session.via}:${session.id}`;
}

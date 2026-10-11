/**
 * Deleting an account. What happens is decided from facts the caller gathers (organisations
 * from accounts, repositories from the gateway), so the rule is testable on its own:
 *
 * - The sole owner of an organisation cannot delete their account: the organisation would be
 *   left with nobody to run it. They add another owner or delete the organisation first.
 * - Otherwise the person's own repositories are deleted with the account (the page lists
 *   them), they leave every repository and organisation they belong to, their agents are
 *   disconnected, and their passkeys, sessions, tokens, keys and retired handles go with the
 *   user row. Audit rows stay (ids, not secrets) so a deletion is traceable.
 */
import { auditStatement } from './audit';
import type { IdentityEnv } from './identity-env';

/** An organisation the person owns, with how many other owners it has. */
export type OwnedOrganization = { readonly handle: string; readonly otherOwners: number };

export type AccountFacts = {
  readonly handle: string;
  readonly organizations: readonly OwnedOrganization[];
  /** The person's own repositories (active and archived), by name. */
  readonly repositories: readonly string[];
};

export type DeletionPlan =
  | { readonly kind: 'blocked'; readonly soleOwnerOf: readonly string[] }
  | { readonly kind: 'allowed'; readonly repositories: readonly string[] };

export function deletionPlan(facts: AccountFacts): DeletionPlan {
  const soleOwnerOf = facts.organizations
    .filter((organization) => organization.otherOwners === 0)
    .map((organization) => organization.handle);
  if (soleOwnerOf.length > 0) return { kind: 'blocked', soleOwnerOf };
  return { kind: 'allowed', repositories: facts.repositories };
}

/** Whether what the person typed is their handle (any case, with or without the @). */
export function isDeletionConfirmed(typed: string, handle: string): boolean {
  return typed.trim().replace(/^@/, '').toLowerCase() === handle.toLowerCase();
}

/**
 * Deletes the user row and what hangs off it, in one batch with the audit line. Answers false
 * when there was no such user. The caller has already removed what lives elsewhere
 * (repositories, R2 pictures, agent grants).
 */
export async function deleteUser(
  env: IdentityEnv,
  input: { readonly userId: string; readonly ip: string | null; readonly now: number },
): Promise<boolean> {
  const db = env.IDENTITY_DB;
  const user = await db
    .prepare('SELECT handle, email FROM users WHERE id = ?')
    .bind(input.userId)
    .first<{ handle: string; email: string | null }>();
  if (user === null) return false;
  await db.batch([
    await auditStatement(
      env,
      {
        action: 'user.delete',
        actorUserId: input.userId,
        target: input.userId,
        ip: input.ip,
        detail: { handle: user.handle },
      },
      input.now,
    ),
    db.prepare('DELETE FROM auth_challenges WHERE user_id = ?').bind(input.userId),
    db.prepare('DELETE FROM email_codes WHERE email = ?').bind(user.email ?? ''),
    // Passkeys, sessions, tokens, SSH keys and requests, retired handles: ON DELETE CASCADE.
    db.prepare('DELETE FROM users WHERE id = ?').bind(input.userId),
  ]);
  return true;
}

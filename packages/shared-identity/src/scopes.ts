/**
 * What a token or an agent session may do. One vocabulary for personal tokens, session
 * tokens and OAuth grants:
 * - `read`: read repositories and run state (MCP read tools, Actions runs and logs, secret
 *   names, git fetch/clone);
 * - `collaborate`: post on beans, answer requests, use the inbox (no code);
 * - `write`: push code to the caller's own beans (git push, bean updates); with the maintain
 *   role, also run, re-run and cancel workflows and automations;
 * - `secrets`: with the maintain role, set and delete Actions secrets and variables. Opt-in on
 *   the consent page, never pre-ticked: a secret value an agent sets passes through its model;
 * - `create`: create repositories in namespaces where the person may create them (their own,
 *   and organizations whose repository setting lets their role), with the `repo_create` tool,
 *   `POST /api/repos`, or by pushing to an address that does not exist yet (push-to-create).
 *   New repositories are private unless asked otherwise. Ticked when an agent asks for it.
 * Landing on the stalk and repository settings are never grantable to a token.
 */
import { z } from 'zod';

export const SCOPES = ['read', 'collaborate', 'write', 'secrets', 'create'] as const;
export const Scope = z.enum(SCOPES);
export type Scope = z.infer<typeof Scope>;

/** Scopes from free text (space- or comma-separated); unknown words are dropped. */
export function parseScopes(text: string | readonly string[]): readonly Scope[] {
  const words = typeof text === 'string' ? text.split(/[\s,]+/) : text;
  return SCOPES.filter((scope) => words.includes(scope));
}

export function hasScope(scopes: readonly Scope[], needed: Scope): boolean {
  return scopes.includes(needed);
}

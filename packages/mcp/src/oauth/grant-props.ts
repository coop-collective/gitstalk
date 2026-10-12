/**
 * What an OAuth grant (or a personal token presented to /mcp) carries into the MCP handler:
 * the person, the client, and the scopes. Validated on the way in; props come from KV.
 */
import { z } from 'zod';

import { Scope } from '@gitstalk/shared-identity/scopes';

export const GrantProps = z.object({
  userId: z.string().min(1),
  handle: z.string().min(1),
  /** The client's display name ("Claude Code"), as the person approved it. */
  clientName: z.string(),
  /** `oauth` for a grant, `token` for a personal access token sent as a bearer. */
  via: z.enum(['oauth', 'token']),
  /** For `token`: the token's scopes. For `oauth` the token's own scopes (ctx.auth) rule. */
  scopes: z.array(Scope),
});
export type GrantProps = z.infer<typeof GrantProps>;

/**
 * Scopes a person may grant an agent session (the authorization server's `scopes_supported`);
 * landing on the stalk and repository settings are never grantable. `secrets` is opt-in: the
 * consent page never ticks it for the person.
 */
export const GRANTABLE_SCOPES = ['read', 'collaborate', 'write', 'secrets'] as const;

/**
 * What clients ask for by default: the protected resource's `scopes_supported` (RFC 9728) and
 * the `scope` of its `WWW-Authenticate` challenge, which MCP clients (Claude Code, Codex)
 * request as is. Everything an agent needs to work on a repository and follow its workflows;
 * the person can untick any but `read` on the consent page. Only `read` is enforced on `/mcp`;
 * each tool checks the scope it needs.
 */
export const DEFAULT_SCOPES = ['read', 'collaborate', 'write'];

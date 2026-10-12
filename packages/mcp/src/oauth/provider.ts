/**
 * The OAuth 2.1 authorization server and protected resource for `/mcp`, per the MCP
 * authorization spec, with Cloudflare's `@cloudflare/workers-oauth-provider`: PKCE (S256),
 * dynamic client registration, Client ID Metadata Documents, RFC 9728 protected-resource
 * metadata, RFC 8414 server metadata, refresh and revocation. Tokens are stored hashed in
 * OAUTH_KV. The consent screen is the web app's `/connect` (see ./authorize.ts).
 */
import type { OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';

import { verifyUserToken } from '@gitstalk/shared-identity/user-tokens';

import type { GrantProps } from './grant-props';
import { DEFAULT_SCOPES, GRANTABLE_SCOPES } from './grant-props';

export const AUTHORIZE_PATH = '/authorize';
export const TOKEN_PATH = '/oauth/token';
export const REGISTER_PATH = '/oauth/register';

/** Access tokens live 15 minutes; refresh keeps a session alive for 30 idle days. */
const ACCESS_TOKEN_SECONDS = 15 * 60;
const REFRESH_TOKEN_SECONDS = 30 * 24 * 3600;

export type ProviderHandlers = {
  readonly api: NonNullable<OAuthProviderOptions<Env>['apiHandler']>;
  readonly authorize: OAuthProviderOptions<Env>['defaultHandler'];
};

/** The provider's options for a deployment (its public origin comes from PUBLIC_URL). */
export function providerOptions(env: Env, handlers: ProviderHandlers): OAuthProviderOptions<Env> {
  const origin = publicOrigin(env);
  return {
    apiRoute: '/mcp',
    apiHandler: handlers.api,
    defaultHandler: handlers.authorize,
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: TOKEN_PATH,
    clientRegistrationEndpoint: REGISTER_PATH,
    accessTokenTTL: ACCESS_TOKEN_SECONDS,
    refreshTokenTTL: REFRESH_TOKEN_SECONDS,
    refreshTokenIdleTTL: REFRESH_TOKEN_SECONDS,
    scopesSupported: [...GRANTABLE_SCOPES],
    requiredScopes: DEFAULT_SCOPES,
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      resource_name: 'Gitstalk',
    },
    // A personal access token (bsu_) also works as the bearer, for clients without OAuth.
    resolveExternalToken: async ({ token, env: tokenEnv }) => {
      const verified = await verifyUserToken(tokenEnv, token);
      // A token bound to one repository is a git credential (`git_credentials`), not a session.
      if (verified === null || verified.token.repository !== null) return null;
      const props: GrantProps = {
        userId: verified.user.id,
        handle: verified.user.handle,
        clientName: verified.token.kind === 'personal' ? 'personal token' : 'session token',
        via: 'token',
        scopes: [...verified.scopes],
      };
      return { props, audience: `${origin}/mcp` };
    },
  };
}

/** PUBLIC_URL without a trailing slash, lowercased host: the issuer and resource origin. */
export function publicOrigin(env: Env): string {
  return new URL(env.PUBLIC_URL).origin;
}

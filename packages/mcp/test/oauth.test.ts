import { env, SELF } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { listAudit } from '@gitstalk/shared-identity/audit';
import { base64UrlEncode, randomSecret } from '@gitstalk/shared-identity/secrets';
import {
  PersonalTokenInput,
  createPersonalToken,
  verifyUserToken,
} from '@gitstalk/shared-identity/user-tokens';
import { insertUser } from '@gitstalk/shared-identity/users';

import { repository, slug } from './repo-fixtures';

const ORIGIN = 'https://gitstalk-mcp.example.workers.dev';
const WEB_URL = 'https://gitstalk-web.example.workers.dev';
const REDIRECT = 'http://localhost:33418/callback';

type Mcp = {
  consentRequest(id: string, user: { id: string; handle: string }): Promise<unknown>;
  approveConsent(
    id: string,
    user: { id: string; handle: string },
    scopes: readonly string[],
    ip: string | null,
  ): Promise<{ redirectTo: string } | null>;
  denyConsent(
    id: string,
    user: { id: string; handle: string },
    ip: string | null,
  ): Promise<{ redirectTo: string } | null>;
  agentSessions(
    userId: string,
  ): Promise<readonly { grantId: string; clientName: string; scopes: readonly string[] }[]>;
  revokeAgentSession(userId: string, grantId: string, ip: string | null): Promise<boolean>;
};

/** The Worker's own entrypoint, as the web app's service binding sees it. */
function mcp(): Mcp {
  const entry: unknown = Reflect.get(exports, 'default');
  if ((typeof entry !== 'object' && typeof entry !== 'function') || entry === null)
    throw new Error('the Worker has no default entrypoint');
  return {
    consentRequest: (...args) => Reflect.apply(Reflect.get(entry, 'consentRequest'), entry, args),
    approveConsent: (...args) => Reflect.apply(Reflect.get(entry, 'approveConsent'), entry, args),
    denyConsent: (...args) => Reflect.apply(Reflect.get(entry, 'denyConsent'), entry, args),
    agentSessions: (...args) => Reflect.apply(Reflect.get(entry, 'agentSessions'), entry, args),
    revokeAgentSession: (...args) =>
      Reflect.apply(Reflect.get(entry, 'revokeAgentSession'), entry, args),
  };
}

let userCount = 0;
async function newUser(): Promise<{ id: string; handle: string }> {
  userCount += 1;
  const user = { id: `u_oauthtest${userCount}`, handle: `oauth-person-${userCount}` };
  await insertUser(env, { ...user, email: null }, Date.now()).run();
  return user;
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomSecret();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

const Registered = z.object({ client_id: z.string() });
const Tokens = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
  scope: z.string(),
});

async function register(redirectUris: readonly string[] = [REDIRECT]): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude Code',
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  expect(response.status).toBe(201);
  return Registered.parse(await response.json()).client_id;
}

function authorizeUrl(
  clientId: string,
  challenge: string,
  overrides: Record<string, string> = {},
): string {
  const url = new URL(`${ORIGIN}/authorize`);
  const params = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: 'read',
    state: 'state-123',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${ORIGIN}/mcp`,
    ...overrides,
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** /authorize → the web app's consent page; returns the pending request id. */
async function startAuthorization(clientId: string, challenge: string): Promise<string> {
  const response = await SELF.fetch(authorizeUrl(clientId, challenge), { redirect: 'manual' });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location') ?? '');
  expect(`${location.origin}${location.pathname}`).toBe(`${WEB_URL}/connect`);
  return location.searchParams.get('request') ?? '';
}

async function token(body: Record<string, string>): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
}

/** The whole flow, as Claude Code drives it: register, authorize, approve, exchange. */
async function connectAgent(scopes: readonly string[] = ['read']) {
  const user = await newUser();
  const clientId = await register();
  const { verifier, challenge } = await pkce();
  const request = await startAuthorization(clientId, challenge);
  const approved = await mcp().approveConsent(request, user, scopes, '203.0.113.5');
  const redirect = new URL(approved?.redirectTo ?? '');
  const code = redirect.searchParams.get('code') ?? '';
  const exchanged = await token({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource: `${ORIGIN}/mcp`,
  });
  expect(exchanged.status).toBe(200);
  return { user, clientId, tokens: Tokens.parse(await exchanged.json()) };
}

async function mcpClient(bearer: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    fetch: (input, init) => SELF.fetch(delivered(new Request(input, init))),
  });
  const client = new Client({ name: 'oauth-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

async function callTool(
  client: Client,
  name: string,
  input: Record<string, unknown> = {},
): Promise<unknown> {
  const result = await client.callTool({ name, arguments: input });
  const [content] = z
    .array(z.object({ type: z.literal('text'), text: z.string() }))
    .parse(result.content);
  if (result.isError === true) throw new Error(content?.text);
  return JSON.parse(content?.text ?? 'null');
}

function postMcp(bearer: string | null): Promise<Response> {
  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  });
  if (bearer !== null) headers.set('authorization', `Bearer ${bearer}`);
  return SELF.fetch(
    delivered(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    ),
  );
}

/** As the platform delivers a request: with a Host header (the MCP transport checks it). */
function delivered(request: Request): Request {
  const copy = new Request(request);
  copy.headers.set('host', new URL(request.url).host);
  return copy;
}

describe('discovery (MCP authorization spec)', () => {
  it('names itself gitstalk-mcp and asks browsers for https only', async () => {
    const response = await SELF.fetch(`${ORIGIN}/`);
    expect(await response.json()).toMatchObject({ name: 'gitstalk-mcp', mcp: '/mcp' });
    expect(response.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });

  it('challenges an unauthenticated /mcp request with the protected-resource metadata URL', async () => {
    const response = await postMcp(null);
    expect(response.status).toBe(401);
    const challenge = response.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    // Clients request what the challenge names: everything but the opt-in secrets scope.
    expect(challenge).toContain('scope="read collaborate write"');
  });

  it('publishes protected-resource metadata naming this server as the authorization server', async () => {
    const response = await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
    expect(await response.json()).toMatchObject({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [ORIGIN],
      scopes_supported: ['read', 'collaborate', 'write'],
    });
  });

  it('publishes authorization-server metadata with PKCE S256, registration and revocation', async () => {
    const response = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
    expect(await response.json()).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      revocation_endpoint: `${ORIGIN}/oauth/token`,
      code_challenge_methods_supported: expect.arrayContaining(['S256']),
      scopes_supported: ['read', 'collaborate', 'write', 'secrets'],
      client_id_metadata_document_supported: true,
    });
  });
});

describe('the authorization code flow', () => {
  it('grants the opt-in secrets scope only when the person ticks it', async () => {
    const { tokens } = await connectAgent(['read', 'collaborate', 'write', 'secrets']);
    expect(tokens.scope).toBe('read collaborate write secrets');
    const client = await mcpClient(tokens.access_token);
    expect(await callTool(client, 'whoami')).toMatchObject({
      scopes: ['read', 'collaborate', 'write', 'secrets'],
    });
    await client.close();
    const without = await connectAgent(['read', 'collaborate', 'write']);
    expect(without.tokens.scope).toBe('read collaborate write');
  });

  it('completes register → authorize → consent → token, and the token opens /mcp', async () => {
    const { user, tokens } = await connectAgent(['read', 'write']);
    expect(tokens).toMatchObject({ token_type: 'bearer', expires_in: 900, scope: 'read write' });
    const client = await mcpClient(tokens.access_token);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['ask_repo', 'run_status', 'whoami', 'git_credentials', 'repo_list']),
    );
    expect(tools.map((tool) => tool.name)).not.toContain('bean_update');
    expect(await callTool(client, 'whoami')).toMatchObject({
      handle: user.handle,
      client: 'Claude Code',
      via: 'oauth',
      scopes: ['read', 'write'],
      run: 'j6boaclinn',
    });
    await client.close();
    const audit = await listAudit(env, user.id);
    expect(audit.map((event) => event.action)).toContain('oauth.grant');
  });

  it('mints a one-hour git credential for one repository, no wider than the session', async () => {
    const { user, tokens } = await connectAgent(['read', 'collaborate']);
    const repo = await repository(user);
    const client = await mcpClient(tokens.access_token);
    const minted = z
      .object({ credential: z.string(), scopes: z.array(z.string()), expires_at: z.string() })
      .parse(await callTool(client, 'git_credentials', { repo: slug(repo) }));
    await client.close();
    const token = /^password=(\S+)$/m.exec(minted.credential)?.[1] ?? '';
    expect(token).toMatch(/^bss_/);
    expect(minted.scopes).toEqual(['read']);
    expect(Date.parse(minted.expires_at) - Date.now()).toBeLessThanOrEqual(3600 * 1000);
    const verified = await verifyUserToken(env, token);
    expect(verified?.user.id).toBe(user.id);
    expect(verified?.scopes).toEqual(['read']);
    expect(verified?.token.repository).toBe(repo.engine_id);
  });

  it('refuses a code with the wrong PKCE verifier or none, and a code used twice', async () => {
    const user = await newUser();
    const clientId = await register();
    const { verifier, challenge } = await pkce();
    const request = await startAuthorization(clientId, challenge);
    const approved = await mcp().approveConsent(request, user, ['read'], null);
    const code = new URL(approved?.redirectTo ?? '').searchParams.get('code') ?? '';
    const base = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
    };
    const wrong = await token({ ...base, code_verifier: randomSecret() });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: 'invalid_grant' });
    const missing = await token(base);
    expect(missing.status).toBe(400);
    expect((await token({ ...base, code_verifier: verifier })).status).toBe(200);
    const replay = await token({ ...base, code_verifier: verifier });
    expect(replay.status).toBe(400);
  });

  it('refreshes, then revokes: the revoked token no longer opens /mcp', async () => {
    const { clientId, tokens } = await connectAgent();
    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    const next = Tokens.parse(await refreshed.json());
    expect(next.access_token).not.toBe(tokens.access_token);
    expect((await postMcp(next.access_token)).status).toBe(200);
    const revoked = await token({
      token: next.access_token,
      token_type_hint: 'access_token',
      client_id: clientId,
    });
    expect(revoked.status).toBe(200);
    expect((await postMcp(next.access_token)).status).toBe(401);
  });

  it('tells the client access_denied when the person declines', async () => {
    const user = await newUser();
    const clientId = await register();
    const { challenge } = await pkce();
    const request = await startAuthorization(clientId, challenge);
    const denied = await mcp().denyConsent(request, user, null);
    const redirect = new URL(denied?.redirectTo ?? '');
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('state')).toBe('state-123');
    expect(await mcp().approveConsent(request, user, ['read'], null)).toBeNull();
  });

  it('lets only the person who opened a consent request decide it', async () => {
    const [alice, bob] = [await newUser(), await newUser()];
    const clientId = await register();
    const { challenge } = await pkce();
    const request = await startAuthorization(clientId, challenge);
    expect(await mcp().consentRequest(request, alice)).toMatchObject({
      clientName: 'Claude Code',
      redirectHost: 'localhost',
      redirectIsLoopback: true,
      requestedScopes: ['read'],
      grantableScopes: ['read', 'collaborate', 'write', 'secrets'],
    });
    expect(await mcp().consentRequest(request, bob)).toBeNull();
    expect(await mcp().approveConsent(request, bob, ['read'], null)).toBeNull();
    expect(await mcp().consentRequest('not-a-request', alice)).toBeNull();
  });

  it('lists connected sessions and revokes one, with its session git tokens', async () => {
    const { user, tokens } = await connectAgent(['read', 'write']);
    const repo = await repository(user);
    const client = await mcpClient(tokens.access_token);
    const minted = z
      .object({ credential: z.string() })
      .parse(await callTool(client, 'git_credentials', { repo: slug(repo) }));
    await client.close();
    const gitToken = /^password=(\S+)$/m.exec(minted.credential)?.[1] ?? '';
    const [session] = await mcp().agentSessions(user.id);
    expect(session).toMatchObject({ clientName: 'Claude Code', scopes: ['read', 'write'] });
    expect(await mcp().revokeAgentSession('u_someone_else', session?.grantId ?? '', null)).toBe(
      false,
    );
    expect(await mcp().revokeAgentSession(user.id, session?.grantId ?? '', null)).toBe(true);
    expect(await mcp().agentSessions(user.id)).toEqual([]);
    expect(await verifyUserToken(env, gitToken)).toBeNull();
    expect((await postMcp(tokens.refresh_token)).status).toBe(401);
    const actions = (await listAudit(env, user.id)).map((event) => event.action);
    expect(actions).toEqual(
      expect.arrayContaining(['oauth.grant', 'session_token.mint', 'oauth.revoke']),
    );
  });
});

/** Loopback ports may vary (RFC 8252 §7.3), so another port on localhost is allowed by design. */
describe('redirect URIs (fuzz)', () => {
  const variants = [
    'http://localhost:33418/callback/../evil',
    'http://localhost:33418/callback/',
    'http://localhost:33418/callback?extra=1',
    'http://localhost:33418/Callback',
    'http://localhost.evil.test:33418/callback',
    'http://evil.test/callback',
    'https://localhost:33418/callback',
    'http://localhost:33418/callback#fragment',
    'javascript:alert(1)',
    '//evil.test/callback',
    'http://LOCALHOST:33418/callback@evil.test',
  ];

  it.each(variants)('never redirects to %s', async (redirectUri) => {
    const clientId = await register();
    const { challenge } = await pkce();
    const response = await SELF.fetch(
      authorizeUrl(clientId, challenge, { redirect_uri: redirectUri }),
      { redirect: 'manual' },
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });

  it('refuses a plain PKCE challenge and a missing one', async () => {
    const clientId = await register();
    const plain = await SELF.fetch(
      authorizeUrl(clientId, 'x'.repeat(43), { code_challenge_method: 'plain' }),
      { redirect: 'manual' },
    );
    expect(
      new URL(plain.headers.get('location') ?? `${ORIGIN}/`).searchParams.get('error') ??
        String(plain.status),
    ).toMatch(/invalid_request|400/);
    const url = new URL(authorizeUrl(clientId, 'unused'));
    url.searchParams.delete('code_challenge');
    url.searchParams.delete('code_challenge_method');
    const missing = await SELF.fetch(url, { redirect: 'manual' });
    expect(
      new URL(missing.headers.get('location') ?? `${ORIGIN}/`).searchParams.get('error') ??
        String(missing.status),
    ).toMatch(/invalid_request|400/);
  });

  it('refuses registering a remote http redirect URI', async () => {
    const response = await SELF.fetch(`${ORIGIN}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'x',
        redirect_uris: ['http://evil.test/callback'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(response.status).toBe(400);
  });
});

describe('other credentials on /mcp', () => {
  it('accepts a personal access token with read scope, and refuses one without', async () => {
    const user = await newUser();
    const read = await createPersonalToken(env, {
      userId: user.id,
      request: PersonalTokenInput.parse({ name: 'agent', scopes: ['read'], days: 7 }),
    });
    const collaborate = await createPersonalToken(env, {
      userId: user.id,
      request: PersonalTokenInput.parse({ name: 'no read', scopes: ['collaborate'], days: 7 }),
    });
    const accepted = await postMcp(read.token);
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    const refused = await postMcp(collaborate.token);
    expect(refused.status, await refused.clone().text()).toBe(403);
    expect(refused.headers.get('www-authenticate')).toContain('insufficient_scope');
  });

  it('still sends run tokens to the run-token path', async () => {
    const response = await postMcp('bst1.forged.token');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });
});

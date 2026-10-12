# @gitstalk/shared-identity

Accounts for Gitstalk: people, handles and profiles, passkeys and email sign-in codes, web
sessions, personal and session tokens, SSH keys, organizations and their members, audit logs,
Turnstile and sign-in rate limits. It is a TypeScript library over one D1 database, bound as
`IDENTITY_DB` (`gitstalk-identity`), whose schema lives here in `migrations/`. It has no Worker
of its own; it is bundled into the Workers that import it.

```
gitstalk-web     ─┐  sign-up, sign-in, sessions, settings, orgs, tokens, SSH key approval
gitstalk-gateway ─┼─> @gitstalk/shared-identity ──> D1 IDENTITY_DB (gitstalk-identity)
gitstalk-mcp     ─┘  agent sessions, session tokens, scopes
```

## Key concepts

- **Credentials**: every secret Gitstalk issues (session ids, tokens, email-code tickets,
  challenge handles) is 32 random bytes, shown once and stored only as its SHA-256
  (`secrets.ts`). Six-digit email codes are stored as an HMAC under the web's
  `EMAIL_SIGNIN_KEY`, since a plain hash of six digits is easy to reverse.
  Tokens are `bsu_` (personal, up to a year) and `bss_` (agent session, up to an hour), with
  the scopes `read`, `collaborate` and `write` (`scopes.ts`). Landing on the stalk is never
  grantable to a token.
- **Sessions and cookies**: `__Host-` cookies only, 30-day sliding web sessions.
- **Sign-in**: passkeys, verified in the Worker with `@simplewebauthn/server`, or a six-digit
  code mailed through Cloudflare Email Service (`email-codes.ts`: ten minutes, single use,
  five tries, five codes an address an hour, bound to the asking browser). A verified address
  signs its account in, or starts a sign-up whose handle step creates the account with the
  address verified (`email-sign-in.ts`). Every method opens its session through
  `openSessionStatements` (`sessions.ts`). Mail goes out through the `EmailPort` (`email.ts`);
  tests use `testing/capturing-email.ts`.
- **SSH keys**: public keys only, registered from a terminal and approved in a browser
  (`ssh-key-requests.ts`, the RFC 8628 device pattern), or pasted in Settings.
- **Organizations** share the handle namespace with people; four roles; the last owner cannot
  leave or be removed.
- **Agent sessions** (`agent-sessions.ts`): the RPC contract the MCP Worker serves to the web
  app for the consent screen and the connected-agents list.

Design: [19-accounts-and-auth.md](../../docs/claude-opus/19-accounts-and-auth.md),
[28-organizations.md](../../docs/claude-opus/28-organizations.md),
[29-settings.md](../../docs/claude-opus/29-settings.md),
[21-git-over-ssh.md](../../docs/claude-opus/21-git-over-ssh.md).

## Layout

There is no index module; import files by path, for example
`@gitstalk/shared-identity/sessions` (the `exports` map is `./*` to `./src/*.ts`).

| Path | Contents |
| --- | --- |
| `src/users.ts`, `profiles.ts`, `reserved-handles.ts`, `account-deletion.ts` | People, handles (with retired-handle redirects), profiles, deletion rules |
| `src/passkeys.ts`, `webauthn-json.ts`, `email-codes.ts`, `email-sign-in.ts`, `email.ts`, `sessions.ts`, `cookies.ts` | Sign-in (passkeys, email codes), the outgoing-mail port and web sessions |
| `src/user-tokens.ts`, `scopes.ts`, `secrets.ts` | Personal and session tokens, scopes, hashing |
| `src/ssh-keys.ts`, `ssh-key-requests.ts`, `ssh-wire.ts` | SSH public keys, browser approval, wire-format parsing and fingerprints |
| `src/orgs.ts`, `org-admin.ts`, `org-members.ts`, `org-audit.ts` | Organizations, members, invitations, org audit log |
| `src/agent-sessions.ts` | MCP Worker RPC contract for the web app |
| `src/audit.ts`, `product-events.ts` | Audit rows; product analytics through Analytics Engine (hashed ids only) |
| `src/turnstile.ts`, `rate-limit.ts`, `request-context.ts`, `transport-security.ts` | Bot checks, sign-in limits, request facts, HSTS |
| `src/identity-env.ts` | The bindings the library expects (`IdentityEnv`, `SignInEnv`) and the clock |
| `src/testing/virtual-authenticator.ts`, `capturing-email.ts` | Software passkey and a mail port that keeps messages, for tests; never imported by a Worker |
| `migrations/` | D1 schema (`0001_identity.sql` to `0007_email_codes.sql`) |
| `test/` | Tests, a test-only Worker and `wrangler.jsonc` for Miniflare |

Imported by `packages/web`, `packages/gateway` and `packages/mcp`.

## Develop

```bash
pnpm -F @gitstalk/shared-identity test        # vitest in workerd: real D1 (migrations applied) and rate limiter
pnpm -F @gitstalk/shared-identity typecheck   # tsc -p tsconfig.json
pnpm -F @gitstalk/shared-identity types       # regenerate worker-configuration.d.ts from test/wrangler.jsonc
```

There is no `dev` script and no `.dev.vars`; the test Worker needs no secrets.

## Configuration

Bindings and values the importing Worker provides (names only):

- `IDENTITY_DB` (D1, `gitstalk-identity`): bound by the web app, the gateway and the MCP
  Worker, each with `migrations_dir` pointing at `../shared-identity/migrations`.
- `SIGNIN_RATE_LIMIT` (Rate Limiting binding): web app only.
- `EMAIL` (send-email binding), `EMAIL_SENDER_DOMAIN` and the secret `EMAIL_SIGNIN_KEY`: email
  sign-in codes, off unless all three are present.
- `TURNSTILE_SITE_KEY`, `TURNSTILE_HOSTNAMES`, `TURNSTILE_TEST_KEYS` and the secret
  `TURNSTILE_SECRET_KEY`: Turnstile is on only when both the site key and the secret are set.
- `PRODUCT_EVENTS` (Analytics Engine dataset `product_events`): product analytics.

Migrations are applied when an environment is provisioned (`pnpm env:provision <env>`); see
[30-environments.md](../../docs/claude-opus/30-environments.md).

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md); run `pnpm check` at the root before sending a
change.

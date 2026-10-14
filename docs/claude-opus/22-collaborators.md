# 22 · Collaborators and visibility

Built 2026-10-07 on a worktree branch from `prototype` at `f9a2295` (lane C of persistent repositories). Repositories from `20-repositories.md` now have people besides their owner, and public repositories are really public. Backlog `16` Phase 3 plans team orgs and teams; this is the per-repository half that does not need orgs.

## 1. What a person sees

| Where | What |
|---|---|
| Settings → **Collaborators** (owner) | Invite by handle with a role; each collaborator with a role select (Change role) and Remove; pending invitations (until when, Cancel); the **Access log** (invitations, answers, role changes, removals, leaving, visibility). |
| Settings (maintainer) | Deploy tokens only, and a line saying whose the rest is. Read and write collaborators see that line; people with no role get the same 404 as a missing repository. |
| **People** tab (new, every repository) | Who has access with which role, and **Sessions and tokens**: every credential that cloned or pushed, the person it acted for, its name ("laptop git", "Claude Code", a key's machine, a deploy token), last read, last push, pushes. A collaborator can **Leave** here. A public repository's other readers are told who owns it. |
| Home | **Invitations waiting** (who invited you, to what, as what; Accept opens the repository, Decline) and **Shared with you**. |
| Visibility | Private: only the owner and people they invite. Public: anyone, signed in or not, reads and clones; pushing still needs a role. |

Roles: **read** (clone, fetch, view), **write** (also push beans), **maintain** (also answer decision cards and manage deploy tokens), **owner** (everything, settings and deletion included; not invitable). Invitations wait 14 days; a new invitation to the same person replaces the old one.

Screenshots: `exp/collaborators/01-08*.png`; the git transcript is `exp/collaborators/walk-transcript.txt`.

## 2. One rule

`mayUseEngine(principal, repository, action)` in `gateway/src/auth/git-credential.ts` is still the one place access is decided. It now answers `allowed`, `forbidden` (you can see it, your role or credential does not reach this) or `not-found` (you may not learn it exists).

- Inputs: the principal (`anonymous`, a signed-in `person` on the web, or a `credential`: token, key, agent session), and the repository facts the registry gathers (`repos/access.ts`): engine, owner, visibility, and the asking person's collaborator role.
- Actions: `read` → read role, `write` → write, `decide` and `deploy-tokens` → maintain, `administer` → owner.
- A credential bound to an engine (a run's `git` token, a deploy token) uses that engine only, as far as its scopes go; deploy tokens stay repository-scoped and independent of collaborators (removing the maintainer who made one leaves it working). Race run principals never reach repositories.
- Tokens, keys and agent sessions are their person's role capped by their scopes (`repo:read`, `bean:write`); deciding, deploy tokens and settings are never done by a token, only by a person on the web (as `19` §3 says: settings are never grantable).
- With no role, private is `not-found` and public is read-only.

Where it is applied:

| Transport | Path | Refusals |
|---|---|---|
| HTTPS git | `routes/git.ts` → `push/push-proxy.ts` `repoGit` | 404 for hidden; 403 with a `remote:` reason ("your role on this repository is read; to push beans you need the write role"); no credential: a public repository clones, anything else gets the connect hint (401) so git asks for a credential and a private repository looks missing |
| SSH git | gateway RPC `sshGit` → the same `repoGit` | same |
| MCP | `agentRepositoryAccess` RPC; `mcp/src/tools/repository-access.ts` (the helper every repository tool asks first) and the `whoami` tool with `repo` (then `repository_access`) | the gateway's 404 / 403 passed through |
| Web views | `getRepository`, `repositoryFiles`, `listRepositories` (registry RPC), the run routes `/runs/<engine>…` and `/api/runs/<engine>/…` (`engineAccess`, so a repository's engine id does not open it as a "race") | 404 page |
| Web actions | settings and delete (`administer`), deploy tokens (`deploy-tokens`), decision cards on a repository engine (`decide`, answered as the person's handle), collaborators RPC | 403 / 404 messages |

The old `canRead` and `isOwner` checks in the registry RPC and deploy tokens are gone; they ask `accessResult` → `mayUseEngine`.

## 3. Data (FORGE D1, migration `0003_collaborators.sql`)

- `repository_members` (repo, user, handle, role, added by, times). The owner stays on `repositories`.
- `repository_invitations` (one pending per person and repository; accepting moves the row into members in one batch).
- `repository_sessions`: one row per credential per repository (`<via>:<id>`, the person, last read at most once a minute, last push, pushes). Names are read from the credential when listed (token and key names from IDENTITY_DB, deploy token names from FORGE), so a renamed or removed credential shows as such.
- `repository_audit`: invite, cancel, accept, decline, role, remove, leave, visibility; each written in the same D1 batch as the change (visibility right after it). No secrets.

Deleting a repository deletes its rows in all four tables. Invitees are found by handle in IDENTITY_DB (disabled accounts are nobody).

## 4. Verified

- **Matrix** (`gateway/test/collaborators.test.ts`): every role (owner, maintain, write, read, outsider, anonymous) × visibility (private, public) × transport (HTTPS git read/write, SSH via `sshGit` read/write, MCP read/write/decide/administer, web read/decide/deploy-tokens/administer) → 200 / 401 / 403 / 404, **128 cases** from one expectation table. Plus flows: invite by handle (case and `@` ignored), unknown handle, the owner, already a member, only the owner invites, decline, cancel, someone else's invitation 404, a write collaborator's push received then refused after demotion to read, sessions and audit recorded, removal hides a private repository on every transport, leaving, the owner cannot leave, a maintainer's deploy token outlives their membership, public → private hides it everywhere with the audit line, a race engine stays "no repository".
- MCP `test/repository-access.test.ts`; web `src/repositories/collaborators.test.ts` (the run-route guard, answer validation, an older gateway). `pnpm check` exits 0.
- **Staging** (`beanstalk-{gateway,web,mcp}-staging-c` on the devaccounts workers.dev subdomain; D1 `beanstalk-forge-staging-c` and `beanstalk-identity-staging-c`, KV `beanstalk-oauth-staging-c`, Artifacts `beanstalk-race-staging-c` / `beanstalk-repos-staging-c`, runner container `beanstalk-gateway-staging-c-runner` at 4 instances), headless Chrome with a CDP virtual authenticator per person and real git, **19 of 19**: three passkey sign-ups (owner, collaborator, outsider); a public repository from the starter; anonymous clone; outsider clone, outsider push refused (403, "public to read"); invite as write; the invitation on Home, Accept; collaborator clone and `git push -o wait` of a bean: green on the merged tree in 5.6 s, LANDED, validated on the stalk; People tab lists the collaborator's "laptop git" personal token with one push; demoted to read, the next push is refused with the role line, fetch still works; made private: anonymous git asked to connect, the outsider's git gets "not found", the outsider's and an anonymous web request get the 404 page; the read collaborator still fetches; Home shows Shared with you; Settings fits a phone with no sideways scroll. Accounts `owner-nfve`, `dana-nfve`, `erin-nfve` (and an earlier `-vnoi` set, whose only failing check was the script's own 404 wording) are left on staging.

Not deployed live.

## 5. Migration for live data

Apply `beanstalk-forge` migration `0003_collaborators.sql` (`wrangler d1 migrations apply beanstalk-forge --remote` from `packages/gateway`) **before** deploying the gateway; it only adds tables, so existing repositories keep their owner and visibility and simply have no collaborators. Then deploy gateway, MCP and web together (the web and MCP read the new RPC methods; an older gateway makes the web treat every engine as a race and hide collaborators, so deploy the gateway first). No new secrets or bindings. One behaviour change on live: **public repositories now clone without a credential** (before, git without one got the connect hint).

## 6. Open

- Email invitations and invites to people without an account wait for the sender domain (`19` §6); invites are by handle only.
- Orgs and teams (Phase 3.1) would add team principals to `repository_members`; `mayUseEngine` takes the person's best role, so a team role joins as one more fact.
- Agents never decide or administer, even for an owner; if Coop wants a maintainer's agent to answer cards over MCP, it needs a grantable scope and one line in `withinScopes`.
- MCP sessions still read one run for the existing read tools; `repository_access` (now `whoami` with `repo`) is the first repository-addressed tool, and the MCP write tools lane should call `repositoryAccess` before each write.

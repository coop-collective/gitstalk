# Repositories: create, start, grow

Built 2026-10-07 on branch `worktree-agent-repos` (from `prototype`, merged up to `1d1d0f3`). This is backlog `16` items 2.2 and most of 2.7: persistent repositories owned by a person, created from the web, and the page a new user lands on. The engine and git side is `18-git-native-flow.md`; accounts are `19-accounts-and-auth.md`.

## 1. What a person sees

| Route | What it is |
|---|---|
| `/` signed in | Home: a lead sentence, your repositories (each with "N beans landed, M growing" from its engine), recent activity, New repository. A first visit shows three steps (create, connect an agent, push a bean) and the demo repository. Signed out, `/` is still the benchmark landing, which also lives at `/races`. |
| `/new` | Name (with the owner prefix), description, private or public, and how it starts: the **TypeScript starter** (default), **empty** (a README) or **import a public git URL**. Errors sit beside their field and keep what was typed. |
| `/<owner>/<repo>` before the first bean | The start page (below). |
| `/<owner>/<repo>` after | The repository home from `14` §11, unchanged: the stalk, Growing now, What happened, Ask, Files, beans, decisions, checks, read from the repository's engine. |
| `/<owner>/<repo>/files` | The Files explorer once something grew; the stalk's file list before. |
| `/<owner>/<repo>/stalk` | Redirects (308) to History, which folded the Stalk tab (§9). |
| `/<owner>/<repo>/settings` | The owner: rename and description, visibility, collaborators (`22-collaborators.md`), deploy tokens, archive (§8), delete after typing `<owner>/<name>`. Maintainers: deploy tokens. People with no role get the same 404 as a missing repository. |
| `/<owner>/<repo>/people` | Who has access, and which sessions and tokens acted for whom (`22`). |
| `/<owner>` | The owner's repositories, then an **Archived** section (for now only on your own page; listing someone else's needs a handle lookup from accounts). |

The shell names the repository once (`owner / name` plus a private or public pill), then its tabs. A race keeps its Engine tab; a repository has Settings instead. Night, day (phosphor, paper, blueprint) and phone widths all work; screenshots are in `exp/repos/`.

### The start page

The first screen after "Create repository", so it has one job: say what is there and exactly how to begin.

- **Lead:** "greeter is ready. Its stalk holds the TypeScript starter, 7 files, with tests every bean must pass before it lands."
- **Connect git** (added 2026-10-07, `19-accounts-and-auth.md` §9): three tabs, the choice remembered per viewer. **Plugin** (default): one line that installs the Claude Code plugin and runs `/gitstalk:setup <owner>/<repo>`, plus Codex's line and what to ask it. **HTTPS**: the clone command, a token from Settings at git's password prompt, and the token-in-URL last resort with its warning. **Env vars**: the owner makes a deploy token for this repository there and then, and the `GITSTALK_TOKEN` + `GIT_CONFIG_*` block (credential-helper and Bearer-header forms) is filled in with it.
- **Hand it to an agent:** the sentence to say to a connected agent, and the MCP URL for any other client.
- **Or push a bean with git:** a `bean/<name>` branch is a bean; the six commands (clone, switch, commit, `git push -o wait origin bean/first-change`) with one Copy; the rules (push only `bean/*`; without Connect git, the password is a personal token from Settings, Tokens).
- **Clone it:** the URL, `https://<web>/<owner>/<repo>.git`: git is served by the web host, as on GitHub (`GIT_ORIGIN` is the web origin; the web forwards git's three smart-HTTP endpoints to the gateway, `18` §2). `https://<gateway>/git/<owner>/<repo>.git` keeps working.
- **On the stalk** (the files, read from Artifacts by the gateway) and **What counts as green**: the stalk's effective checks from `.gitstalk/checks.toml` (what runs, image, time limit, environment, protected paths), "Default suite" (`node --test`) when there is none or it is the starter's older `[[check]]` draft, or every problem when it is invalid (`24-checks-config.md`; the same summary is on Settings → Checks).
- **The stalk column** is the real one: the root commit as a leaf, "Fertilized by <owner>", and a breathing bean socket above it: "Your first bean grows here". Once a bean starts, the page becomes the repository home.

## 2. How it works

```
web /new ──createRepository(owner, input)──▶ gateway
                                              ├─ D1 forge: reserve <owner>/<name> (unique per owner, any case)
                                              ├─ Artifacts: create repo-<id> (default branch stalk), or import
                                              ├─ seed: one root commit pushed to stalk and sprout (or point them at the import's head)
                                              ├─ openRepoEngine({ repoName, artifactsRepo, owner }) → engineId
                                              └─ D1: mark ready + "created" activity
web /<owner>/<repo> ─getRepository / repositoryFiles──▶ registry;  runView/runEvents/repoTree(engineId) ──▶ engine
git /git/<owner>/<repo>.git ──▶ registry (name → engine, owner, visibility) ──▶ mayUseEngine ──▶ engine
```

- **Registry in D1, not a Durable Object.** Every registry read is a cross-repository index (an owner's list, a handle-and-name lookup, an engine-to-repository lookup, activity across repositories), and name uniqueness is one unique index on `(owner_id, lower(name))`. A single registry DO would be a global serialisation point for every page load; the engine's hot state stays in its own DO. Tables: `repositories` and `repository_activity` (`packages/gateway/migrations/0001_repositories.sql`, binding `FORGE`).
- **Storage is named by id** (`repo-<12 chars>`), so a rename never moves git data.
- **Repositories have their own Artifacts namespace** (`beanstalk-repos`, binding `REPOS`), apart from race repos (`beanstalk-race`, binding `ARTIFACTS`). The hourly sweep lists only the race namespace, so it cannot see a person's repository, whatever its name; a repository engine's RunDO also refuses any reap or sweep (409), and picks its namespace from what it drives (`selectedArtifactsPort` in `adapters/artifacts.ts`). Test: `spend-guards.test.ts`, "never deletes a person's repository, however old" (a sweep with `older_than_hours: 0`, plus a `race-*`-named repo planted in the repositories' namespace).
- **The first commit is written in the gateway.** `src/git/seed-pack.ts` builds the blobs, trees and commit as a git pack (zlib via `CompressionStream`, SHA-1 ids, checked against `git fsck --strict`); `src/adapters/repository-storage.ts` mints a one-minute write token, pushes `stalk` and `sprout` in one receive-pack request, and revokes it. No token leaves the gateway, and the web never sees one.
- **The TypeScript starter** has no dependencies: `src/text.ts`, `test/text.test.ts` (Node's test runner on `.ts` files, Node 23.6+), `package.json` (`npm test`), `tsconfig.json`, `.gitstalk/checks.toml` (`command = ["node", "--test"]`, 120 s), README. The engine reads that file on every checked tree (`24-checks-config.md`), so the first bean's pre-land check is real.
- **A failure on the way undoes itself** (registry row and Artifacts repo removed), so the name is free again; a private import URL comes back as an error on the form.
- **Git access has one rule** (`mayUseEngine` in `gateway/src/auth/git-credential.ts`): a token bound to an engine uses that engine; a person's token (`bsu_`, `bss_`) has its person's role (owner or collaborator, `22-collaborators.md`) capped by its scopes, and reads public ones; run tokens never reach repositories. The git proxy resolves `/git/<owner>/<repo>.git` through the registry, so a renamed repository keeps its engine at its new URL; since 2026-10-09 its old URL resolves to it too (a redirect row, `28-organizations.md` §6.3), and repositories created since then get an engine keyed by their id rather than their address, so a new repository can take an address another one left. Engines opened without a registry record (the admin route) keep the derived-id path and are private.
- **Web adapters:** accounts through `src/auth/user.ts` (accounts' module; `src/server/signed-in.ts` redirects to sign in), the registry through `src/repositories/registry-client.ts` (every answer validated with Zod), the engine through the existing run read RPCs keyed by `engine_id`. The repository home and Files explorer are shared components keyed by a base path (`/runs/<run>` or `/<owner>/<repo>`), so races and repositories render the same views.

## 3. Verified

- **Tests:** gateway `test/repositories.test.ts` (create with template, empty and import; per-owner uniqueness ignoring case; invalid names; cleanup after a failed import; private visibility; rename, describe, visibility with activity; ownership; delete; git at the new name and, since 2026-10-09, the old one), `src/git/seed-pack.test.ts` (git's object ids, the commit id git computes for the same files, the receive-pack body, refusal parsing), `test/user-credentials.test.ts` (the access rule); web `src/repositories/repositories.test.ts` (the form, create, settings and delete flows, the route lookup, the start guide, growth lines). `pnpm check` exits 0.
- **Staging, end to end** on a separate stack (`beanstalk-web-staging-repos`, `beanstalk-gateway-staging-repos` with its runner, `beanstalk-mcp-staging-repos`, Artifacts namespace `beanstalk-race-staging-repos`, D1 `beanstalk-forge-staging-repos` and `beanstalk-identity-staging-repos`, KV `beanstalk-oauth-staging-repos`), driven by headless Chrome with a virtual authenticator:
  1. passkey sign-up as `coop`;
  2. New repository `greeter` from the TypeScript starter; the start page;
  3. a personal token with write access from Settings, Tokens;
  4. `git clone`, a `bean/add-truncate` commit (a function and its test), `git push -o wait`: received, pre-land check green on the merged tree in 5.9 s, landed on the sprout, validated on the stalk, **18 s** for the whole push;
  5. the repository page switched from the start page to the home with the leaf on the stalk; Home listed "1 bean landed".
  A second person (`dana`) saw the first-visit Home, got a 404 for `coop/greeter` (private), created `my-first-app`, and was told "You already have a repository named my-first-app." on a second try.

## 4. Open

- **Insights** tab (`repo_daily` holds its first counts) and org owners. (Collaborators and visibility: done, `22-collaborators.md`; repository tabs, §6; the Stalk tab, engine activity on Home from D1, archive: §7 and §8.)
- **Index lag outliers:** queue delivery took 1.3 to 6.3 s on staging, so the index was 1.5 to 7 s behind the engine (most under 5 s); one earlier pair of messages, before the engine logged its sends, arrived 45 to 50 s late, cause not found (§7).
- ~~Stalk and History overlap~~: one History tab since the integration (§9). Changes (§6) still reads the engine's event log whole per page; the D1 `beans` and `decisions` indexes can serve it.

Done 2026-10-07 (live rollout, §5): repository pages name the pushing person (`last push @coop: add-truncate`, `@coop` where a race shows `a0`, "pushed by @coop") and suggest repository questions; handles that clash with routes are refused at sign-up; the plugin install line is real.

## 5. Live

Rolled out 2026-10-07 to the live stack (`*.<sub>.workers.dev`): gateway, web, MCP, with production resources D1 `beanstalk-identity` and `beanstalk-forge` (migrations applied), KV `beanstalk-oauth`, and the Artifacts namespace `beanstalk-repos` (created by its first repository). Their ids are in the `wrangler.jsonc` files; another account replaces them (or removes `database_id` / `id` to let Wrangler provision new ones). No new secrets: sessions, passkey challenges and tokens are random values hashed in D1, and the OAuth provider encrypts grant props with keys derived from each token.

- **Reserved handles:** one list, `packages/shared-identity/src/reserved-handles.ts`, used by sign-up (`Handle`) and by the web's owner routes (`isReservedOwner`, plus static files). `web/src/repositories/reserved-routes.test.ts` reads the router's top-level directories (`app/*`) and fails if any is not refused as a handle, so a new route must be added there.
- **Claude Code plugin:** its own repository since 2026-10-11, `coop-collective/gitstalk-plugin` (`.claude-plugin/marketplace.json` at its root lists the plugin at `./`; this repository's marketplace points there for older installs). `claude plugin marketplace add coop-collective/gitstalk-plugin && claude plugin install gitstalk@gitstalk` (default branch `main`; `coop-collective/gitstalk-plugin#<branch>` names another). Before the move: Verified with Claude Code 2.1.292 from a local checkout (marketplace added, plugin installed, its MCP server listed); `#prototype` is accepted as a ref.
- **Codex:** `codex mcp add gitstalk --url <live mcp>/mcp && codex mcp login gitstalk`.
- **Races after the deploy:** a replay race (shop arena, seed 7, `--preset demo`, `--max-usd 1`) gave 25 of 40 green with 15 replay-limitation drops, the same as the integration branch's run with these flags (`runs/live-replay-after-deploy`). After the gateway was redeployed with `origin/prototype` at `9702954` (runner API 4), the first race met the old runner image mid-rollout (21 `runner_version_mismatch` drops, `-r2`); five minutes later it gave 25 of 40 again with no infrastructure drop (`-r3`), and an admin-opened repository took a pushed bean green in 4.7 s on the new image.
- **Walk-through on live, 22 of 22 checks** (headless Chrome with a CDP virtual authenticator; the script stayed in the session scratchpad): passkey sign-up as `beanstalk-smoke`; `smoke-greeter` from the TypeScript starter, whose start page shows the real install lines; a personal token with write access (masked before the screenshot); `git clone` through the credential helper; a `bean/add-truncate` commit (a function and its test), `git push -o wait`: pre-land check green on the merged tree in 5.1 s, LANDED, validated on the stalk, **17.0 s** for the push; the status ref read; the repository page with the bean, "last push @beanstalk-smoke: add-truncate" and repository-shaped Ask suggestions; Home listing it; `claude mcp add --transport http` then `claude mcp login` in a pseudo-terminal: "Needs authentication", consent as "Claude Code", "Connected", and `claude -p` calling `whoami` → `{"handle":"beanstalk-smoke","client":"Claude Code","via":"oauth","scopes":["read"],…}`; then the repository deleted (404), the token revoked and refused by git. The account is left for Coop to delete. Files: `exp/live/01-…13-*.png`, `push-transcript.txt`, `mcp-login-transcript.txt`, `whoami.txt`.
- **Engine settings per repository:** done 2026-10-07 on a staging stack, not yet live: the engine reads `.gitstalk/checks.toml` from each checked tree (`24-checks-config.md`). Deploying it changes nothing for live repositories: without the file, or with the starter's old `[[check]]` draft, they keep running the engine's `node --test` (`24` §1 and §6 item 3, decided at the integration, §9).

## 6. Repository tabs: Code, Changes, History (2026-10-07, lane A)

A person's repository no longer borrows the race views. The shell names it once (`owner / name`, visibility) and has **Code, Changes, History, Ask, People, Settings** (People from the collaborators lane; Settings for anyone with a role). No "N agents" or "run" wording: beans carry the person who pushed them (`@coop`), or `session a3` for a bean nobody pushed.

| Route | What it is |
|---|---|
| `/<owner>/<repo>` | Before the first bean, the start page (§1). After, **Code** at the stalk's root. `?q=` / `?bean=` (the Ask view's own links) open Ask. |
| `/<owner>/<repo>/tree/<path>`, `/blob/<path>` | A folder or a file. `?ref=` picks `sprout`, `bean/<name>` (the pushed head) or a 40-hex commit; the stalk is the default. The switcher lists the lines and every pushed bean (open first) with its state glyph. |
| `/<owner>/<repo>/changes` | Beans in three lists: **Open** (in check, red, conflict, waiting), **Landed** (on the sprout or the stalk), **Parked** (and fell off), each with title, `bean/<name>`, who, when, and for a red one its failing tests and the landed beans it collided with. Follows the engine live (SSE) and re-renders on each burst of events. |
| `/<owner>/<repo>/changes/<bean>` | One bean: the journey (each push, pre-land checks with failing tests, rework and collided beans, landing, validation, decisions, park or fall), the verdict the push printed, and its diff. Live while open. |
| `/<owner>/<repo>/history` | The stalk's commits (title, bean, person, time, "Fertilized by" on the root) and, above them, sprout commits not validated yet, marked as such. A sha opens the files at that commit. |
| `/<owner>/<repo>/ask` | The Nightshift explorer (stalk, Growing now, What happened, Ask) from §1; `/files` is its file explorer. |
| `/api/repos/<owner>/<repo>/live` | The repository's engine events as Server-Sent Events, behind the same access rule as the pages. |

- **Code:** syntax highlighting is a small server-side tokenizer (`web/src/code/highlight.ts`: TS/JS with regex literals, Rust, Go, Python, shell, CSS, TOML, JSON, YAML); a wrong colour is the worst case, never wrong text. READMEs render from a Markdown subset as React elements (`web/src/code/markdown.ts`): raw HTML stays text, links only to http(s), mailto or relative targets, and relative links open in the same ref. The side column has About (beans on the stalk, in check, red), the clone URL and the three Connect git tabs in compact form (with a deploy-token form for owners and maintainers).
- **Reads are fixed per page, never per bean or file** (`web/src/repo-pages/engine-reads.ts`, memoised per request): Code makes `pushedBeans`, `runEvents` (paged), one recursive `repoTree`, one `repoLog`, and one `repoFile` for the README or the file, independent ones together; Changes makes `runEvents` and `pushedBeans`; a bean page adds `beanDetail` and `repoDiff`; History adds two `repoLog` calls. `repo-pages.test.ts` counts the calls for a 42-file folder.
- **Home's activity reads the engines:** one gateway RPC, `engineFeeds(engineIds, limit)` (`gateway/src/repos/engine-feed.ts`, types in `@gitstalk/shared-race/engine-feed`), answers every repository's bean counts and its recent pushes, reds, conflicts, landings, validations, decisions, parks and falls, with who pushed each, from each engine's Durable Object in parallel. Home merges them with the registry's lines and keeps a bean's newest line (a validation hides the push and landing it implies). It replaces the per-repository `runView` calls; an older gateway without the method falls back to them. Shared repositories are included.
- **Wording:** the Files rail says "People and sessions on it now" and names pushers; the agent-activity answer says "Pushed by @coop" for a repository.
- **Errors are logged:** `web/instrumentation.ts` logs every request error the framework catches (`onRequestError`). Before it, a page that threw while rendering left no trace in Workers logs.

**Verified on a staging stack** (`beanstalk-{web,gateway,mcp}-staging-a`, Artifacts `beanstalk-race-staging-a` and `beanstalk-repos-staging-a`, D1 `beanstalk-forge-staging-a` and `beanstalk-identity-staging-a` with migrations, KV `beanstalk-oauth-staging-a`): passkey sign-up as `coop`; `greeter` from the TypeScript starter; a write token; `git push -o wait` of five beans (`add-truncate`, `slugify`, `reverse-words` and, after merging the collaborators lane, `count-words` landed and validated with 4.5 to 7 s checks; `shout` red with its failing test); every tab in night, day and phone answering 200 with no sideways scroll; the Changes page picking up a new bean while open (shot 13, "in check", no reload); every tab and the live feed a 404 for a signed-out visitor. Screenshots: `exp/repo-tabs/` (`NN-<page>-{night,day,phone}.png`). `pnpm check` exits 0.

**Open:** the event log is read whole per page (fine for hundreds of events, not for years of them: backlog 2.6's D1 indexes); no per-file "last change" column (it would cost a log per path); diffs are not syntax-highlighted.

## 7. Repository events and the Stalk tab (backlog 2.6, 2.7; 2026-10-07)

```
RunDO (repository engine) ── its own events table, cursor `repo-events-cursor` ──▶ Queue beanstalk-repo-events
   step with a published event type / alarm / wake / catchUpRepoEvents()          │ max_batch_timeout 0
                                                                                  ▼
gateway queue() ── RepoEventsMessage (Zod) ── registry.byEngine ──▶ D1 FORGE: repository_activity (engine lines),
                                                                    beans, decisions, repo_daily, repo_lines
web Home (repositoryActivity, repositoryGrowth) · Stalk tab (repositoryStalk) ◀── one D1 batch per page
```

- **What is published** (`gateway/src/repo-events/map-events.ts`): `task.start` → `bean.opened` (with the pusher and title from the push driver), `land` (a bean's own) → `bean.landed`, `rework.start`, `task.drop` / `task.parked` → `bean.ended`, `revert` → `bean.reverted`, `green.promote` → `stalk.promoted`, `green.demote` → `stalk.demoted`, `ticket.open` → `sprout.red`, `decision.request` / `decision.made`. Contract: `@gitstalk/shared-race/repo-events`.
- **Nothing is lost:** the engine sends from a cursor over its own event log (`publisher.ts`), moving it only after `sendBatch` succeeded; a failed send goes again with the next step, alarm or wake, and a reader that finds a repository missing from the index (`repo_lines` has no row) asks its engine to catch up. A repository that grew before this change sends its whole history the first time its engine wakes. Races never publish.
- **Idempotent consumer** (`consumer.ts`, `index-store.ts`): activity lines are unique by `<engine>:<seq>`; a bean's state and a line's head move only for a newer engine seq; daily counts are recounted from the activity lines; so redelivery and reordering change nothing (test: `test/repo-events.test.ts`). Messages for engines no repository owns are acked and dropped; bad messages are acked with a warning; a failed D1 write is retried by the queue (10 times).
- **Tables** (migration `0004_repo_events.sql`): `beans` (repo, bean, title, pusher, state growing/landed/promoted/reverted/dropped/parked, landed and promoted commits, reworks), `decisions`, `repo_daily`, `repo_lines`; `repository_activity` gains `event_key`, `bean`, `sha`. Home's activity now covers your repositories and those shared with you.
- **Web:** Home reads D1 first: one `repositoryGrowth` read for every repository's counts, and its activity is the registry's lines with the engines' (each bean linked to its Changes page; a bean's push and landing give way to its newer lines). Only repositories the index has not heard from yet go through §6's `engineFeeds` (and an older gateway through `runView`). The Stalk tab was one `repositoryStalk` read; since the integration that read feeds History's validation view (§9).
- **Files rail:** §6's wording stands ("People and sessions on it now", "Pushed by @coop").

**Verified on staging** (`beanstalk-gateway-staging-repoev` with runner app `beanstalk-gateway-staging-repoev-runner` at 4 × standard-4, `beanstalk-web-staging-repoev`, D1 `beanstalk-forge-staging-repoev` / `beanstalk-identity-staging-repoev`, queue `beanstalk-repo-events-staging-repoev`, Artifacts `beanstalk-race-staging-repoev` / `beanstalk-repos-staging-repoev`; headless Chrome with a CDP virtual authenticator, real git): passkey sign-up, `greeter` from the starter, a personal token, six beans pushed with `git push -o wait`, each LANDED and validated on the stalk in 11 to 25 s. Index lag (engine event to D1 row, from the Worker logs, `exp/repo-events/index-lag.txt`): 1.5 to 7.0 s across 14 messages, median about 3 s; the queue's delivery is most of it (1.3 to 6.3 s after the send); one early pair 45 to 50 s (above). Stalk tab D1 read through the web: 87 to 160 ms warm (213 ms cold), the gateway's own D1 batch 17 to 90 ms; D1's primary is in SIN. Screenshots: `exp/repo-events/03-stalk.png`, `09-stalk-phone.png` (390 px, no sideways scroll), `09-home.png`, `03-files.png`; push transcript `push-transcript.txt`. Stack torn down afterwards.

## 8. Archive (backlog 2.2)

- **Who:** the owner, from Settings ("Archive <owner>/<name>"; "Unarchive" while archived). Gateway RPC `archiveRepository(actorId, repoId, 'archived' | 'active')`, checked by `mayUseEngine`'s `administer`; an activity line each way.
- **What it does:** `mayUseEngine` refuses `write`, `decide` and `deploy-tokens` on an archived repository to everyone who could otherwise do them (`refusedByArchive`), so HTTPS and SSH pushes, MCP writes, decision answers and deploy tokens all stop in one place, with one sentence: `remote: <owner>/<name> is archived, so it is read-only: pushes are refused. Its owner can unarchive it in Settings.` Reads, clones and fetches still work (public stays public). Rename, description and visibility are refused while archived (unarchive first); collaborators and deletion still work.
- **Lists:** `listRepositories` returns active repositories by default and archived ones with `'archived'`; Home leaves them out (with "N archived" linking to your page, and its own sentence when all are archived); `/<owner>` lists them under Archived; every repository page says "Archived by its owner: read-only…" under its name.
- **Verified:** `test/repo-archive.test.ts` (owner only; out of the default list; clone 200 for owner and anonymous; push 403 with the sentence; deploy token, decision and settings refused with `archived`; unarchive takes pushes again); on staging: archived from Settings, `git push` answered with the `remote:` line above and a 403, `git fetch` fine, Home and the owner page as described, unarchived, the next push LANDED (`exp/repo-events/04-*.png` to `07-*.png`, `push-transcript.txt`).

**Live rollout:** create the queue (`wrangler queues create beanstalk-repo-events`), apply `beanstalk-forge` migration `0004_repo_events.sql` before deploying the gateway (it only adds a table set and nullable columns), then deploy the gateway and the web. Existing repositories fill their index the first time their engine wakes or their page is read.

## 9. Integration of the three lanes (2026-10-08)

Repo events (§7, §8), checks config (`24`) and accounts polish (`19` §10) merged onto `prototype` at `6a67010`, in that order, with the coordinator's decisions applied:

- **One History tab.** The Stalk tab's validated-versus-landed view is folded into History: above the commits, the stalk's head ("validated: every check green"), the sprout's ("landed: green on the merged tree") and the week's counts; each sprout commit not on the stalk carries a "landed, not validated yet" pill, and every commit a validation judged carries its verdict (validated, validation red, stalk went back here, reverted, with when); beside them, **Validation verdicts** and **Taken off or waiting**. `/<owner>/<repo>/stalk` answers 308 to `/history`, and the Stalk tab is gone from the shell. Growing beans stay on Changes.
- **Sources of truth.** Commits and beans on repository pages come from the engine (`repoLog`, `pushedBeans`, `runEvents`: what the repository really holds). Verdicts, line heads, daily counts and Home's growth and activity come from the D1 index (`repositoryStalk`, `repositoryGrowth`, `repositoryActivity`) that `repo-events` keeps; `repositoryStalk` gained `verdicts` (activity lines that name a commit: promoted, demoted, red, reverted). Home asks `engineFeeds` (§6) only for repositories the index has not heard from yet, so the index replaces it wherever it can. An index that does not answer leaves History with its commits alone.
- **MCP asks the rule git asks.** `agentRepositoryPrincipal` (`gateway/src/agent/agent-access.ts`) is the one place an MCP session becomes a `mayUseEngine` principal; the repository tools and `whoami(repo)` (then `repository_access`) both use it. Archive goes through it: `repo-archive.test.ts` checks that `bean_open` and the write access check answer the archive sentence while reads still work.
- **Protected paths:** `.gitstalk/checks.toml` is always protected, not all of `.gitstalk/`, so agents keep ticking tasks in `.gitstalk/backlog.md` (`23`) with ordinary beans.
- **Doc numbering:** `23-mcp-repository-tools.md`'s title said 22 and now says 23; checks config is `24`; no number is used twice.

**Verified.** `pnpm check` exits 0 (gateway 751 tests, web 220, MCP 63, shared-race 87, shared-identity 63); the race harness's Python tests pass (`research/race`, 162). Staging stack `beanstalk-{gateway,web,mcp}-staging-int` (runner app at 4 × standard-2), D1 `beanstalk-forge-staging-int` (migrations 0001 to 0004) and `beanstalk-identity-staging-int` (0001 to 0003), KV `beanstalk-oauth-staging-int`, queue `beanstalk-repo-events-staging-int`, Artifacts `beanstalk-repos-staging-int`, dataset `product_events_staging_int`, Turnstile unconfigured as live is; headless Chrome with a CDP virtual authenticator and real git (`exp/integration/staging-transcript.txt`, screenshots beside it):

| Check | Result |
|---|---|
| Sign-up with Turnstile unconfigured | no widget; passkey `options` for sign-up and sign-in answer 200 without a token; sign-up lands on Home |
| First-visit checklist, install commands | Home shows "Get started, 0 of 3 done"; `/signup/agent` renders the Claude Code and Codex lines for this deployment (`claude mcp add …` here, since its MCP URL is not the hosted one) |
| No checks file (`plain`, empty start) | push line `no .gitstalk/checks.toml on this tree: the repository's default suite runs: node --test (timeout 300 s)`, green 7.4 s, LANDED, validated; a bean with a failing test is RED naming it, so the suite really runs |
| Starter's older `[[check]]` draft (`legacy`) | the owner's bean adding it LANDED (protected path allowed for the owner); the next bean prints the "older [[check]] draft … default suite runs" line and LANDED in 9 s |
| New `checks.toml` (`greeter`, starter) | `checks from .gitstalk/checks.toml: node --test (image node, timeout 120 s)`, LANDED and validated; a deploy token's change to the checks file RED in 0.1 s ("refused for a deploy token"); the same token's `.gitstalk/backlog.md` change LANDED |
| History | heads, week counts, a "validated" pill on every landed commit, Validation verdicts listing each stalk move; `/stalk` → `/history`; no Stalk tab; 0 px sideways scroll at 390 px. On these idle repositories validation followed landing within a second, so the "landed, not validated yet" pill was never caught by a once-a-second poll |
| Archive `greeter` | HTTPS push 403 `int-zkrm/greeter is archived, so it is read-only: pushes are refused…`; MCP `repository_access` says `push_beans: false` with that sentence, `bean_open` and `task_claim` refused with it, `repo_status` still reads, `git_credentials` mints a read-only credential; the web shows the archived note, Settings keeps only archive, collaborators and delete, History still renders, Home says "1 archived"; unarchived, the next push LANDED |

Also checked: migration `0004_repo_events.sql` applied to a copy of the live `beanstalk-forge` (exported read-only into a throwaway D1 that already had 0001 to 0003): both repositories and both activity lines kept, the new tables present. The copy and the export were deleted. Everything on the stack was torn down (Workers, runner container application, queue, both D1, KV, the three Artifacts repositories); the dataset cannot be deleted and expires with retention.

### Live rollout (not done; for Coop)

Live today: gateway `9709edee`, web `ca742175`, MCP `05c930e5`; `beanstalk-identity` is at 0003; `beanstalk-forge` lacks only 0004; no `beanstalk-repo-events` queue exists. From `packages/gateway` with `CLOUDFLARE_ACCOUNT_ID` set:

1. `npx wrangler queues create beanstalk-repo-events` (the gateway is its producer and consumer; the deploy fails without it).
2. `npx wrangler d1 migrations apply beanstalk-forge --remote`: applies only `0004_repo_events.sql` (new tables, three nullable columns on `repository_activity`), before the gateway, which writes them.
3. Deploy the **gateway** (`pnpm env:deploy production --only gateway`, doc 30; Docker builds the runner image; runner API unchanged). Then `npx wrangler queues info beanstalk-repo-events` should list it as producer and consumer.
4. Deploy the **web** app and the **MCP** Worker (`pnpm env:deploy production --only mcp,web`), then the **site** (its install lines changed). The web reads the new gateway RPCs; an older gateway is tolerated but hides History's verdicts, so the gateway goes first.
5. Vars and secrets: none new are required. The `product_events` dataset is created by its first write. Turnstile stays off with `TURNSTILE_SITE_KEY` empty; to turn it on later, `wrangler secret put TURNSTILE_SECRET_KEY` on `beanstalk-web`, then set the site key and redeploy web (either one alone leaves it off).
6. After: existing repositories fill the index the first time their engine wakes or their page is read (Home falls back to the engines until then); push one bean to a live smoke repository (expect the default-suite or older-draft line on starter repositories, then LANDED) and open its History.

Behaviour changes on live: archive exists; History replaces the Stalk tab; the checks file is read (repositories without it, or with the older draft, keep running `node --test`); `.gitstalk/checks.toml` can be changed only by the owner or a maintainer with a personal token or SSH key, so an agent session or a deploy token that touches it gets a red. Rollback: `wrangler rollback` per Worker; the migration is additive and the queue can stay.

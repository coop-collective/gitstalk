# Lessons from Scion: designing for scale, and the Artifacts limits to ask for

Written 2026-10-14 from Anthropic's "Redesigning source control at Anthropic" (https://www.anthropic.com/engineering/redesigning-source-control) and this repo's design docs and code. The owner can ask the Artifacts team to raise limits, so this note designs for the target scale first and then derives the limits that scale needs (§7), instead of shaping the design around today's limits. "Estimate" marks my arithmetic; UNVERIFIED marks a platform behaviour I could not confirm. Status 2026-10-14: §3, §4 and §5 are built (docs `32`, `33`, `34` in `docs/claude-opus/`); §6 is built as an Automations template without telemetry (`docs/claude-opus/25-actions-and-automations.md` §7.14); §2 is not. Current behaviour is in `packages/gateway/README.md` and `docs/claude-opus/31-gateway-engine-internals.md`. Quotations from the post are not used here; everything attributed to it is paraphrased.

## Summary

1. Scion's merge lesson is close to beanstalk's thesis. Anthropic says merge queues with a global lock do not fit agent scale; it relies on testing after merge and before deploy, accepts that concurrent changes conflict, and lets Claude fix them. Gitstalk differs in one way worth stating: it still checks each bean before it lands, on the exact merged tree, but those checks run in parallel without a lock, and landings themselves are serialised on a short single-writer turn (`v2-turn.ts`); validation after landing plus culprit revert is the post-merge half. Cite it as agreement, not identity.
2. Go back to **one Artifacts fork per bean** (the thesis design, `claude-10` §1). Bean-as-branch (`bean/<name>`) was a workaround for fork bugs (`docs/claude-opus/31-gateway-engine-internals.md`, "Why a bean is a branch"); it puts every agent's writes and every ref on one repo's Durable Object, which is the global-ref-state problem Scion designed out. Ask Artifacts to fix forks rather than design around them.
3. Add **approval rules by kind of change** (comment-only, docs, tests, lockfile, migrations, protected paths), computed by code, routed by policy, with Clef triaging the uncertain ones.
4. Compute blame, path history, overlap and test impact through **one derived-data mechanism** per landing.
5. Let actors that do not run code **commit on the server** (`bean_commit`), cost proportional to the change.
6. Offer **area watchers** ("superfans") as an Automations template.
7. Ask Artifacts for higher limits and for a small set of server-side calls (§7). The calls matter more than the numbers.

## 1. What Scion teaches, mapped to beanstalk

| Scion principle | Gitstalk on 2026-10-14 | Gap |
|---|---|---|
| Clients always online; fetch on demand | Gateway reads objects by id into the engine's SQLite cache (`repo/object-cache.ts`); MCP answers with `ask_repo` (paths), `why_lines` and `repo_read` (files with line ranges, tree listings and globs, and `rg --json`-shaped grep with a cursor, over the gateway's `repoFile`, `repoTree` and `repoGrep`); harnesses keep real checkouts (`claude-16`) | Grep scans at most 300 files and 200 matches per search (no index); the blob-keyed `CodeIndex` of `claude-15` is not built |
| Server does history, merges, rebases | Runner container squashes, merges and reverts; the Worker computes diffs (`adapters/artifacts.ts`) and builds commits (`commit/`) | Merges need the container because Artifacts has no server-side merge; the runner keeps a bare clone per trunk (`container/src/git/cache.rs`), a full copy |
| Source control as a platform (bisect and revert pipelines by API) | Engine bisects (`engine/bisect.ts`) and reverts culprits; MCP exposes status, checks, overlaps, blame and server-side commits | No public bisect or revert verb for regressions found after promotion |
| Horizontal scale; no full copy anywhere | One Artifacts repo per repository; every bean is a `bean/<name>` branch of it | All writes share one repo DO (§2) |
| Cheap commits whose cost scales with the change; refs discouraged | `bean_commit` reads only the trees on changed paths (§5); one branch per bean | Refs per bean (§2) |
| Optional sparse checkouts | Blobless + sparse clone measured to work (`claude-16` §4.4) | `tree:0` returns 400; blobless is opt-in |
| One mechanism for derived data (blame, path history, skip lists) | `RepoDerivedDO` with versioned eager or lazy derivers: `bean_blame`, `path_history` (§4) | Overlaps, test impact and symbols are not derivers yet; registered repositories only |
| Semantic approval rules; access per directory | `.gitstalk/policy.yml` classes and routes with Clef triage (§3); `protected-paths` in `.gitstalk/checks.yml` | Write-side only; no per-directory read control; `reviewers` shown, not enforced |
| Refs moved by compare-and-swap | Leased sprout and stalk moves; `bean_commit` checks the expected head | None |
| Tiered caches with high hit rates | One tier: the engine's object cache, its hits and misses now counted by kind and for the ref memo, reported in `runView` and `summary.json` (`packages/gateway/README.md`, "Read index hit rate") | No colo cache tier; measured only in local tests, no production hit rate yet |
| "Superfan" Claude per component watching telemetry | The **Area watcher** automation template: `bean_landed` with a `paths:` filter starts an agent that reviews each landing in its area against the area's intent and history, keeps a review note in its memory and pushes an evidence bean (never a merge) on a regression; engine watchdog for stuck invocations | §6: it does not read production telemetry or logs yet; `$GITSTALK_TELEMETRY` is the hook. Gitstalk MCP tools are not offered inside automation runs yet, so it uses git |
| Post-merge testing; Claude resolves conflicts; no global lock | Parallel pre-land checks on the exact merged tree, sprout validation, culprit revert, rework and a structural merge tier | Landings serialise on a short turn; checks still run before landing |

Not adopted: replacing git. Scion's authors say it suits only enormous monorepos and recommend extending git with server-side calls that forges could standardise; Gitstalk's gateway RPC and MCP verbs are that kind of call, though not a standard.

## 2. Design: one fork per bean, trunk sees only the Integrator

Every Artifacts repo is one Durable Object. Scion's rule is that global state is the scaling problem: a ref move is one compare-and-swap row, and refs other than main and release branches are discouraged. Bean-as-branch does the opposite: every agent's pushes, wip checkpoints and ref updates land on the run repo's DO, and every `ls-refs` advertises every bean.

Target shape:

| Repo | Writers | Readers | Refs |
|---|---|---|---|
| Trunk (`<project>`) | Runner only (sprout, stalk, revert) | Runner, forks at creation, agents fetching the sprout, indexer | `stalk`, `sprout`, release refs |
| Bean fork (`<project>--b-<bean>`) | One agent (writer lease, `claude-16` §7) | Runner (pre-land fetch), watchers, indexer | `main`, `refs/wip/<session>` |

- A bean's fork is created from the sprout at claim time (`fork(..., {defaultBranchOnly: true})`), so its writes, checkpoints and watcher fetches never touch trunk's DO. Writes scale with the number of forks, not with one object's throughput.
- The runner fetches the bean from its fork into its warm trunk workspace, lands on the sprout and pushes trunk. Trunk write traffic is landings only: 30,000 a day (Anthropic's September rate) is 0.35 pushes per second.
- Agents learn the sprout tip from MCP (`repo_status`, inbox events) instead of polling trunk with `git fetch`.
- The proxy's isolation becomes repository-level (the token names one fork) instead of ref-level.
- Forks are reaped when a bean lands or falls off; a bean's audit trail lives in trunk's notes and the RepoDO, not in the fork.

This depends on fixes on the Artifacts side (§7, A1–A3): forks made after a landing returned 500 on upload-pack and `delta base is missing` on push, and new forks were briefly `NOT_FOUND`. Until those are fixed, bean-as-branch stays, which is fine up to roughly 1,000 active agents (§7.2).

## 3. Design: approval rules by kind of change

Status 2026-10-14: built: `.gitstalk/policy.yml` (strict YAML, JSON Schema), classes computed in the gateway's pre-land job (a comment-only lexer for TS/JS, Rust, C/C++, Java, Go), Clef triage with a rules fallback, beans held before landing until a maintainer approves, and Settings → Approval rules saving through the automations editor's commit path. Design and differences (the hold is before landing, not before promotion; `reviewers` are shown, not enforced) in `docs/claude-opus/32-approval-rules.md`. The sketch below is the original proposal.

A `.gitstalk/policy.yml` on the stalk, read by the engine at each landing (never the bean's own copy):

```yaml
# yaml-language-server: $schema=https://gitstalk.io/schemas/policy.json
classes:                 # computed by code, never by a model
  - name: comment-only
    match: { syntax: comments-and-whitespace }
    route: auto
  - name: migration
    match: { paths: ["src/db/migrations/**"] }
    route: card          # decision card before landing on the stalk
    reviewers: ["@data"]
  - name: protected
    match: { paths: [".gitstalk/**", "src/auth/**"] }
    route: card
```

Format: YAML, like `.gitstalk/automations/*.yml` (GitHub Actions syntax) and GitHub's own repository config files (`dependabot.yml`, workflows). It is parsed strictly (YAML 1.2 core schema, no anchors or merge keys) and validated by a Zod schema that is also published as JSON Schema for editor autocompletion. `.gitstalk/checks.toml` predated this; since 2026-10-14 the checks are YAML too (`.gitstalk/checks.yml`, TOML still read), so all `.gitstalk/` configuration is YAML. Settings → Rules edits the same file: saving pushes a commit by the signed-in admin or maintainer that lands on the stalk, as the automations editor does; a person editing there is the decision, so it needs no card. A change under `.gitstalk/` from an agent's bean always needs a decision card.

- Classes are computed in the runner from the parsed diff: tree-sitter (already behind the Mergiraf tier) separates comment and whitespace edits; paths and lockfiles are globs. Clef (Cloudflare's decision model on Workers AI, `@cf/cloudflare/clef-flash`; https://developers.cloudflare.com/workers-ai/models/clef-flash/) only ranks beans that a rule routes to `triage` (principle P4). Every ranking in beanstalk uses Clef; Jev stays a configurable alternative.
- Routes: `auto` (land on the sprout, promote on validation), `triage` (Clef picks auto or card, logged against later decisions), `card` (decision card before promotion; the bean may still sit on the sprout).
- Who may change which paths stays with `protected-paths` in `.gitstalk/checks.yml` and token roles, checked at the pre-land check; the policy adds routes, not a second path guard.
- Every route is a receipt on the bean, so "why did this land without a person?" has an answer.

## 4. Design: one derived-data mechanism

Status 2026-10-14: built for registered repositories as `RepoDerivedDO` (`bean_blame`, `path_history`; MCP `why_lines`); design and differences in `docs/claude-opus/34-derived-data-and-blame.md`. The sketch below is the original proposal.

Scion computes blame, path history and commit-graph skip lists from changesets through one recursive mechanism, eager or deferred per type. Beanstalk computes the same kind of things ad hoc today. In the RepoDO:

```
deriver = { name, version, eager: bool, compute(landing, parentState) -> rows }
on landing(sha): for d in derivers where d.eager: d.compute(...)
on read(d, sha): if missing: compute along the first-parent chain from the nearest computed sha
```

First derivers: `bean_blame` (line range → bean → intent → decision, which answers demo step 6, "why did invoice tax change?"), `path_history`, `overlap_index` (feeds `work_overlaps`), `test_impact` (file → tests, from `research/test-impact/`), `symbol_index` (`claude-15`). A new deriver ships without migrating clients; bumping `version` recomputes lazily.

## 5. Design: commits on the server (`bean_commit`)

Status 2026-10-14: built as the MCP tool `bean_commit`, Worker-native (no container), sharing one tree-edit module with the automation editor's save; verified with `git index-pack --strict` and `git fsck`; design and differences in `docs/claude-opus/33-server-side-commits.md`. The sketch below is the original proposal.

Coding harnesses keep real checkouts (`claude-16`). Writers that run no code (revert bots, small conflict fixes, doc automations, the planner) need no clone:

`bean_commit(bean, base, changes: [{path, content | delete}], message, expected_head)`

- With the Artifacts call in §7.3 (B2), this is one server call.
- Without it, the gateway builds blob, tree and commit objects in the Worker from `readTree` of the changed directories only, sends a thin pack through receive-pack to the bean's fork, and uses `expected_head` for compare-and-swap. Cost is proportional to the files and directories changed, as in Scion.

## 6. Design: area watchers

An Automations template (`16-product-backlog` Phase 4): an agent subscribed to landings under a path plus that area's Workers Observability logs. It posts a review receipt on each bean in its area and files a bean when behaviour drifts. It is a reviewer, never a merger.

**Built 2026-10-14 (without telemetry).** *Area watcher* is a template in New automation (`shared-race/src/automation-templates.ts`; doc 25 §7.14). What is built:

- **The trigger.** `bean_landed` (and `bean_reverted`) take a `paths:` filter with GitHub's glob and `!` rules. The repository's ActionsRepoDO reads the landed commit's files against its first parent, only when an automation filters that event by paths, so a landing outside the area never starts the watcher. When the files cannot be read (more than 200, or no parent) the run starts anyway, as GitHub's push `paths` do; the compatibility report says so.
- **The review.** The agent reads its memory (`area.md`, `reviews/`), the landing and the area's last 20 landings, and checks them against the intent written in the prompt. Its review note is the run's summary and `reviews/<bean>.md` in its memory ref, which anyone who can read the repository can read.
- **The evidence.** For a regression or drift it can show, it pushes one bean with a failing test or the smallest change that shows it. That bean passes through the pre-land check like any other (a failing test stays red), so the watcher can never land anything; `permissions: beans: write` is only for that push.

What is not built:

- **Telemetry.** It reads code, git and its own notes, not production logs or Workers Observability. The hook is `$GITSTALK_TELEMETRY`: the prompt reads that directory when it is set, and today it never is. The design for filling it is in doc 25 §7.14.
- **A review receipt on the bean.** Automation runs cannot write collaboration notes or receipts yet; the note lives in the run and the memory ref.
- **MCP tools in the run.** The prompt names `bean_status`, `why_lines` and `repo_read` for when the Gitstalk MCP tools reach automation runs (doc 25 §7.11, `bs.internal`); until then the agent has git and the filesystem and uses `git show`, `git log -L` and `git blame` instead.

## 7. Limits and server-side calls to ask Artifacts for

### 7.1 Design points

| | A: race today | B: product target | C: 10× Anthropic |
|---|---|---|---|
| Active agents per project | 30 | 1,000 | 10,000 |
| Landings per day | ~1,000 in bursts | 30,000 | 300,000 |
| Trunk size | 5 MB | 1 GB | 10 GB+ |

C is not fanciful: Anthropic went from 2,500 to 30,000 merges a day between May and September 2026.

### 7.2 Load estimates (estimate; assumptions stated)

Assumptions: a git push is 2 HTTP requests, a fetch or clone 3 (protocol v2); one wip checkpoint per agent turn (~60/h), one per 15 s (240/h) while watched, plus one mirror fetch per checkpoint per watcher (`claude-16` §6.5); 10% of agents watched; indexing about 13 binding calls per bean push and per landing (`claude-15` §3.2); fork, read token and write token per bean.

| Load | B | C | Today's limit |
|---|---|---|---|
| Agent git traffic, if all beans share one repo (bean-as-branch) | ~70 req/s | ~700 req/s | 200 req/s per repo |
| Agent git traffic per fork (fork per bean) | <0.4 req/s each | same | 200 req/s per repo |
| Trunk git traffic, fork per bean (landings, pre-land fetches, agent sprout fetches) | ~5 req/s | ~50 req/s; bursts when 10k agents fetch a new sprout at once | 200 req/s per repo |
| Control plane (forks, tokens, indexing, reads) | ~12 req/s | ~120 req/s steady; a 10k-agent start is 30k calls in seconds | 200 req/s per namespace |
| Trunk repo size | 1 GB | 10 GB+ | 1 GB |
| Storage if forks copy objects | 1 TB | 100 TB | 1 TB per account |
| Push and fetch operations (billed) | ~2.5M/day (~$370) | ~25M/day (~$3,700) | $0.15 per 1,000 |

Bean-as-branch therefore holds to roughly design point B; fork per bean holds to C if the control plane and trunk reads are raised.

### 7.3 The ask

| # | Ask | Why | Priority |
|---|---|---|---|
| A1 | Fix forks made after the parent has new pushes: upload-pack 500, push `delta base is missing` | Blocks fork per bean (§2) | Must |
| A2 | Read-after-create: a fork is readable when `fork()` resolves (no transient `NOT_FOUND`) | Same | Must |
| A3 | Confirm or add copy-on-write object sharing between a fork and its parent, storage billed on unique objects; fetching a fork's objects into its parent without re-upload | 10k forks of a 10 GB trunk otherwise cost 100 TB | Must |
| A4 | Control plane 2,000 → 20,000 req per 10 s per namespace, or one binding able to address several namespaces for sharding | Design point C and burst starts | Must for C |
| A5 | Git 2,000 → 20,000 req per 10 s for a repo flagged hot (trunk), or read replicas for upload-pack | Sprout fetch bursts at C | Should |
| A6 | Repo size 1 GB → 10 GB (later 100 GB); account storage 1 TB → 50 TB | Real monorepos | Should |
| A7 | Volume pricing for wip refs, or pushes to refs under `refs/wip/` billed lower | Checkpoints dominate ops cost | Could |
| B1 | Ref calls in the binding: list with prefix, resolve, `updateRef(name, expectedOld, new)` compare-and-swap, delete | The proxy and engine resolve refs through `log({ref, limit: 1})` today; CAS is Scion's ref model | Must |
| B2 | `createCommit({parent, changes, message, author, ref?, expectedOld?})` | Server-side commits (§5) in one call | Should |
| B3 | `diff(a, b, {paths?, patch?})` and `mergeBase(a, b)` | Overlap, indexing and policy without a container or tree walks | Should |
| B4 | Changed paths in `cf.artifacts.repo.pushed` (or a `paths` field per commit, truncated with a flag) | Removes most indexing and overlap calls from A4's budget | Should |
| B5 | Server-side three-way merge returning a commit or the conflicted paths | Clean landings without the runner container | Could |
| B6 | `filter=tree:0` on protocol v2; receive-pack on protocol v2 | Cheaper sparse clones at C | Could |

B1 to B5 are the server-side calls Scion's authors say forges should standardise. They are a better ask than higher numbers: each one removes traffic instead of allowing more.

### 7.4 Message for the Artifacts team (ready to paste)

> We're building beanstalk, a forge where thousands of coding agents land work on one codebase concurrently. Each repo being one Durable Object is exactly what we want: one fork per agent's change, with trunk written only by our integrator. Three things block that design: (1) forks created after the parent has new pushes return 500 on upload-pack and `delta base is missing` on push; (2) new forks are briefly `NOT_FOUND`; (3) we need to know whether forks share objects with their parent. At our target of 10,000 active agents and 300,000 landings a day per project, we'd also need about 20,000 control-plane requests per 10 s per namespace, 10 GB repos, and higher git rates on a hot trunk. Most valuable of all would be server-side ref compare-and-swap, `createCommit`, `diff`/`mergeBase`, and changed paths in push events: each removes traffic rather than needing a higher limit. Happy to share load numbers and repro repos.

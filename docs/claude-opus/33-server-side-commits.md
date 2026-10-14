# 33 · Commits on the server (one commit flow: `bean_commit`, the automation builder, Settings → Approval rules)

Status: implemented 2026-10-14, for agent sessions on people's repositories, for contributor tokens on race runs, and (the same day) for the web editors: one commit flow for `bean_commit`, the automation builder and Settings → Approval rules. Source: the "Commits on the server" design in `docs/claude-18-lessons-from-scion.md` §5 (Claude-authored, not on `main`), after Anthropic's Scion post, where commits happen on the server, so there is nothing to push, and their cost scales with the size of the change rather than of the repository (paraphrased).

## Why

Coding harnesses keep real checkouts and push with git. Writers that run no code (a revert bot, a small conflict fix, a doc automation, the planner) should not need a clone to change three files. `bean_commit` lets them send the changed files and nothing else; the gateway makes the commit.

## What Artifacts gives us

Artifacts has no server-side commit call. The binding reads (`readCommit`, `readTree`, `readBlob`, `log`) and writes only through git smart-HTTP receive-pack. So the gateway builds the git objects itself in the Worker and pushes them as a pack, with an Artifacts token it mints and never hands out.

## How it works: one commit flow

One core, `commitChanges` (`packages/gateway/src/commit/server-commit.ts`), runs inside the engine's `RunDO` for every writer that saves files without a clone. Each caller only sets its parameters: where the commit goes and its compare-and-swap, the author and trailers, the idempotency scope, and the engine's refusal and submit hooks.

| Caller | Adapter | Branch and compare-and-swap | Access | After the push |
|---|---|---|---|---|
| An agent session on a person's repository (`Gateway.agentCommitBean`, `RunDO.repoBeanCommit`) | `commitToRepoBean` (`src/commit/bean-commit.ts`) | `refs/heads/bean/<name>` at `expected_head` (null: must not exist; built on the sprout) | the session's `write` scope and the person's write role, decided by `openRepository` as for `bean_open`; archived repositories refuse | submitted to the engine with `submitPush`, exactly as a `git push` of that branch is (the pre-land check starts, `bean_wait` follows it) |
| A race run's contributor token (`Gateway.beanCommit`, `RunDO.beanCommit`) | `commitToBean` | `refs/heads/beans/<bean>`, the token's own bean, at `expected_head` | contributor tokens only; view, slot and seed tokens are refused before the run is asked | none (the run's engine reads the branch as before) |
| The automation builder (`Gateway.saveAutomation`, doc 25 §7.13) and Settings → Approval rules (`Gateway.saveRules`, doc 32), both `RunDO.repoSaveFile` | `commitFileSave` (`src/commit/file-save.ts`) | a new bean on the latest landed commit the editor opened, named from its commit (`automation-<slug>-<short>`, `rules-<short>`); the branch must not exist | write (maintain for a protected path) for automations, owner or maintainer for the rules, decided by the editor RPC with the file's stale check before the engine is asked | submitted with `submitPush`; owners and maintainers vouch for protected paths, so their rules save is the decision |

Every caller goes through the same steps, in this order:

1. **Policy.** The changes and the message pass `CommitChanges` and `CommitMessage` (`@gitstalk/shared-race/bean-commit`; `BeanCommitInput` uses the same rules), checked by the core for every caller, editors included: paths relative, no `..`, no leading `/`, no `.git` segment at any depth (any case); no path twice, no file under another changed file; at most 64 paths, 128 KiB per file and 192 KiB in all (the HTTP route's body limit is 256 KiB). A session's or an editor's bean must also pass the engine's `pushRefusal` (a landed bean takes no new work; a name another person reserved is theirs), as a git push must. An agent session never vouches for protected paths (`protected_paths`), as with its git pushes: a change to one is held for a person. Finished race runs answer `invalid_state`.
2. **Compare-and-swap.** The gateway reads the receive-pack ref advertisement of the repo. For `bean_commit`, before any work: if the branch is not at `expected_head` (null: the branch must not exist), the answer is a `conflict` value carrying `current_head`; a new branch starts from the sprout's head. For an editor's save the bean is named from the built commit, so once it is built: a branch of that name that exists already is a `conflict`, never an overwrite (the editor answers it as a 409).
3. **Build from the changed paths only** (`src/commit/tree-edit.ts`). It reads the base commit, then the root tree and each directory on a changed path, each once, through the RunDO's object cache. It writes the new blobs, one new tree per touched directory (deepest first, so parents see their children's ids) and the commit. Entries are sorted as git sorts them (a directory compares as `name/`); a file keeps its executable bit; a directory a deletion leaves empty is dropped; a tree that did not change is not sent. Reads and new objects are O(changed files × path depth); a commit that changes nothing is refused.
4. **Push.** `pushRefs` (`src/git/remote-client.ts`) sends `<expected_head or zeros> <new> <branch ref>` with `report-status`, then the pack from `src/git/pack-writer.ts` (version 2, undeltified entries with the type and size varint, zlib bodies from `CompressionStream('deflate')`, SHA-1 trailer). The report-status is parsed: `unpack ok` and `ok <ref>` mean done. A refused update is re-checked against the advertisement: if the branch moved meanwhile, the answer is a `conflict`; otherwise `upstream_failed` with the remote's reason.
5. **Identity and audit.** Author and committer are the actor. For a session that is the person (`<handle>@users.<web host>`) and the trailers are `Bean: <name>`, `Actor: @<handle>`, `Via: bean_commit (<MCP client>)`; `Task:` is left out because on a repository it names a backlog task. For a contributor token it is the token's actor (`<actor>@contributors.<web host>`) with `Task: <bean>`, `Actor: <actor>`, `Via: bean_commit`. For an editor's save it is the signed-in person (`<handle>@users.<web host>`), the editor's message, and `Actor: @<handle>`, `Via: the automation builder` or `Via: Settings → Approval rules` (no `Bean:`: the name comes from the commit).
6. **Idempotency.** As `bean_update`: the key and a SHA-256 of the input go in the engine's `collaboration_idempotency`; the same key with the same input replays the first `committed` answer (checked before `pushRefusal`, so a retry after the bean landed still replays), with other input it is a 409. One key's tries run one at a time in the engine (`src/commit/key-queue.ts`), so two concurrent first tries make one commit: the second waits and replays. `bean_commit` keys are scoped to the bean; an editor's to the person (`save:@<handle>`), over the path, the text and the message (not the base, which is whatever landed last). The web makes one key per save attempt (`saveKeys` in `packages/web/src/automations/automation-save.ts`: the same save sent twice, by a double click or a retried request, carries the same key) and sends it as `idempotencyKey`; a request without one is its own attempt. An editor's stale check runs first, so a retry after its own bean landed asks the engine for the earlier result (`RunDO.repoEarlierSave`) before answering `stale`.

If the engine refuses the submit after the branch moved, the answer is `invalid_state` naming the commit now on the branch.

## API

- MCP, one tool `bean_commit`; a server registers one of its two shapes, by caller (a run token never has a session, so the session tool list grows by one and no new tool name appears):
  - agent sessions: `bean_commit({ repo: "owner/name", bean, expected_head, changes: [{ path, content } | { path, delete: true }], message, idempotency_key })`; `bean` accepts `add-total` or `bean/add-total`. The answer adds a `summary` with the next step.
  - contributor tokens: the same without `repo`; `bean` accepts `t001` or `beans/t001`.
- RPC: `Gateway.agentCommitBean(principal, repo, input)` (sessions) and `Gateway.beanCommit(token, input)` (contributors) → `RpcResult<BeanCommitResult>`.
- HTTP: `POST /v1/runs/:run/beans/:bean/commits` with the contributor token; `201` committed, `409` conflict.
- Result: `{ kind: 'committed', bean, branch, commit, parent, tree, files, objects, trees_read }` or `{ kind: 'conflict', bean, branch, expected_head, current_head }`.

## Other writers, and why they stay on their own path

Every writer that turns file changes into a bean goes through the core. These write commits or refs another way, on purpose:

- **A new repository's first commit** (`seedPack` in `src/git/seed-pack.ts`, called from `RepositoryStorage.seed` for the README, a template or an empty start): a root commit with no parent on the default branch, written before the repository has an engine, a sprout or beans. The core builds on a base commit and pushes a bean through an engine, so it does not fit.
- **The engine's lines** (`prepareRepoLines` and its empty first commit in `src/push/repo-lines.ts`): the engine moves `sprout` and `stalk` itself; merging to a line is never a writer's capability.
- **Status tags** (`src/push/status-publisher.ts`): annotated tags of a bean's verdict, not file changes.
- **Refs the engine and the runner move** (sprout, stalk, landings, reverts) and people's own `git push` through the proxy (`src/push/push-proxy.ts`): a different flow (doc 31).

## Verification

## Verification

- Unit tests: object ids against real git (empty blob `e69de29b…`, `hello\n`, empty tree `4b825dc6…`), tree order and whole trees against `git write-tree` of a fixture, pack layout (header, type and size varint, inflated bodies, trailer), report-status parsing, and the reads a change costs.
- Workers tests (`test/bean-commit.test.ts`) through the real `RunDO` and the fake Artifacts remote: create, compare-and-swap move, delete, conflict, replay, refusals, size caps, the HTTP route, and a remote that refuses the update (lost race and hook refusal). An editor's save through the same core: an unsafe path and an oversized file are refused, and a new bean is never moved (a lost race, then a name already taken, are conflicts with one push).
- Editor end to end (`test/automation-editor.test.ts`): a double-clicked automation save (the same key twice at once) makes one bean, a retry after it landed answers with that bean, the key with other text is a 409, a file under the editor's length but over the commit's byte cap is refused, and a rules save sent twice with one key makes one bean.
- MCP end to end (`packages/mcp/test/repo-tools.test.ts`): a session commits two files to `bean/docs-total` of its repository, the bean is submitted and lands (`bean_wait`), a stale `expected_head` is a conflict that writes nothing, an exact retry replays after landing, a new commit to the landed bean is refused, a read-only session needs the write scope, and a `.git/` path is refused.
- Once, outside vitest: a commit built from a real repository's trees with `tree-edit.ts` and `pack-writer.ts` (edits, a new nested directory, a deletion that empties a directory, an executable edit) was accepted by `git index-pack --stdin --strict`, `git fsck --full --strict` was clean, and the tree id equalled `git write-tree` after the same change made by git.

## Differences from the claude-18 design

- No separate `base` argument: the base is `expected_head`, or the sprout when the branch is new.
- Conflicts are a result kind (`conflict`, with `current_head`), not an error, so an agent can re-read and retry.
- Several callers rather than one: agent sessions on people's repositories (`bean/<name>`, submitted like a push), race contributors (`beans/<bean>`), and the web editors (a new bean named from its commit).
- Text files only (`content` is a string); no binary, symlink or mode changes.

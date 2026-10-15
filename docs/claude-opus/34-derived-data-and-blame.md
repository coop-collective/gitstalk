# Derived history: one mechanism, blame by bean, path history (2026-10-14)

Implemented 2026-10-14 in `packages/gateway/src/derive/`, the gateway RPC `whyLines` and `pathHistory`, and the MCP tool `why_lines`. Code and this note must agree; when they differ, fix both in the same change.

## Why

Anthropic's Scion post ("Redesigning source control at Anthropic") computes blame, path history and commit-graph indexes from changesets through one generic, recursive mechanism, where each type is computed eagerly or deferred and new types can be added without affecting clients (paraphrased). Gitstalk computed its derived views ad hoc (overlaps, `blamed_by`, the explorer). An agent about to change a line also had no way to ask the forge which bean last changed it and why, the question behind "why did invoice tax change?". This adds one mechanism and its first two derived types.

## Design

### The mechanism

```
deriver = { name, version, eager, needs: 'paths' | 'contents', schema, compute(changeset, parentState) -> rows by path }
```

- **The chain.** Derivation follows the sprout's first-parent chain. Each commit gets a position (`seq`). The first commit ever derived starts the chain from the repository's root, or from 256 commits back, read with one `log` call. The oldest commit reached is the **base** (position 0), and lines older than it belong to the base. Later commits are appended by walking back to the chain's tip with one `readCommit` per new commit; a landing adds one or two.
- **What a commit is.** Each commit is classified from the trailers the engine writes (`engine/prompts.ts`), not from events, so a read that derives a commit before its event arrives still gets it right:
  - `Task: <bean>`: a landing by that bean.
  - `Reverts: <sha>`: a revert. It restores the state before the reverted landing, and it is attributed to the bean it reverted.
  - `Reverts: <green>..<head>`: a red-window reset. It restores `green`.
  - Anything else: an ordinary commit.
- **Changesets.** A changeset is one commit's changed paths: one tree walk between the commit and its parent, with contents for the first 200 files (`adapters/artifacts.ts` `changesIn`, the same walk the explorer's diff uses). For a revert or reset, it also carries the text of each changed text file at the restored commit. A file that is binary, over 256 KB, or past the 200-file limit has no text.
- **Rows.** Each deriver writes rows keyed by `(deriver, path, seq)`. The state at any commit is the newest row at or before it, so reading an older ref (the stalk, or a sha) costs nothing extra.
- **Heads.** Each deriver records how far it has computed. `advance` feeds the changesets after a deriver's head, at most a budget per call, with one SQLite transaction per changeset.
- **Eager and lazy.**
  - An eager deriver advances when the engine's events report a landing or a revert.
  - A read advances the deriver it needs before answering, so a lazy deriver costs nothing until someone asks, and an eager one that missed a feed catches up on the next read.
  - A read that runs out of budget (64 changesets) answers `deriving` (503) and continues in the background.
- **Versions.** When a deriver's stored version differs from the code's, its rows are dropped and it is computed again from the base on the next feed or read. Clients never see how rows are computed.
- **Rewritten lines.** If the sprout's head no longer descends from the chain's tip (a line that was replaced, as tests do), derivation restarts from the new root. Facts recorded from events are kept. A sha that is not on the sprout is refused (`not_on_sprout`).

### Where it runs, and why there

`RepoDerivedDO`: one SQLite Durable Object per repository engine, named by the engine id and bound as `DERIVED`, beside the engine's `RunDO`.

It is fed by the **`repo-events` queue consumer**, after a batch is indexed in D1 (`repo-events/consumer.ts`, `derived` dependency). This is the least risky hook:
- It adds nothing to the RunDO. `RunDO` already publishes its event log to the queue from a cursor, so no engine code changed. Engine parity and determinism tests are untouched, and races behave as before.
- The feed arrives in order per engine, and repeats are harmless. A repository that grew before this existed is fed its whole history the first time the engine publishes.
- The feed is fire-and-forget: the entrypoint's `waitUntil` calls `observe`, and a failure is logged. It never retries the queue message, because reads derive what the feed missed.

The alternative, a `waitUntil` hook from the RunDO's applied events (the `RunStreamDO` pattern, `docs/claude-17-streaming-diffs.md`), would need changes in `run-do.ts`'s step path.

Work inside the DO is serialized with a promise chain, because each step awaits reads and the chain must grow in order.

Derivation reads git objects (commits, trees, blobs) **through the engine's read index**: the `RepoDerivedDO` calls the engine's `RunDO.readObjects` over Durable Object RPC (`derive/engine-reader.ts`), batching the reads issued together, and the engine serves what its approval gate and warm-up already read from SQLite. Refs and history pages still go to Artifacts. If the engine cannot answer, derivation logs once and reads Artifacts directly, so it never stalls. Design and measurements: `docs/claude-opus/35-caching.md` §12.

`sprout` and `stalk` resolve to the heads the engine's events last reported (`bean.landed`, `bean.reverted`, `stalk.promoted`, `stalk.demoted`), falling back to the branch head in Artifacts. Answers are therefore as of the last indexed landing, like the rest of the forge's indexes.

### Cost

Object reads below go through the engine's read index, so they reach Artifacts only when the engine has not read them already (in the fastify replay, none did).

| Event | Object reads (engine index, else Artifacts) |
|---|---|
| Landing | 1 `readCommit` for each new commit, plus the tree walk and the reads of changed blobs (at most 8 files at a time), in about 4 engine calls |
| Revert | The above, plus 1 `readFile` per changed text file at the restored commit |
| Read | The ref is resolved from stored heads. A file never changed since the base costs 1 `readFile` to count its lines |

Blame never reads per line. Rows hold spans (`[start, end, owner]`), and a landing rewrites only its changed files' rows.

## The derivers

### `bean_blame` (eager, contents)

Each changed file's lines are kept as spans, each owned by the chain position that last changed them (`derive/blame-spans.ts`):
- A landing applies the line diff's hunks to the parent's spans (`git/diff-text.ts` `lineHunks`, the same Myers diff as the rest of the gateway). Unchanged lines keep their owners, shifted; inserted lines get the landing. This costs O(spans + hunks).
- A revert or reset works line by line:
  - A line it left unchanged keeps its owner.
  - A line it put back takes the owner it had at the restored commit.
  - Anything else gets the revert itself.

  So reverting a bean gives its lines back to the beans that wrote them before, and keeps later beans' lines.
- Deleted files are recorded as deleted. Binary and unread files are owned whole by the commit that changed them.

### `path_history` (eager, paths)

One row per changed path per commit, with `added`, `modified` or `deleted`. A read lists the newest first.

### Not done: `overlap_index`

`work_overlaps` was not moved onto a deriver. Its answer is mostly about beans in flight: unlanded pushes and streaming edits that no sprout changeset holds. The recently landed part needs the engine's bean records (status, slot, intent). An overlap deriver would cover only the landed slice, so it was left for later. `path_history` already answers "which landings touched this path" for that slice.

## API

### Gateway RPC (`@gitstalk/shared-race/derived`, on the default entrypoint, by engine id)

- `whyLines(run, { path, ref?, start?, end? })` → `{ path, ref, commit, lines, ranges: [{ start, end, commit }], commits: { sha: { kind, bean, title, at, on_stalk } }, beans: { bean: { title, actor, decisions, reverted } } }`. Lines are 1-based and inclusive, and `lines` is null for a binary file.
- `pathHistory(run, { path, ref?, limit? })` → `{ path, ref, commit, entries: [commit + change], beans, truncated }`.

Details:
- `ref` is `sprout` (the default), `stalk` or a sprout sha. Bean branches are not derived.
- Errors:
  - `invalid_request` (400): bad arguments, or a bean ref.
  - `not_found` (404): no such file at the ref, or an engine that drives no registered repository. Benchmark runs are not derived.
  - `not_on_sprout` (400): a sha that is not on the sprout.
  - `not_derivable` (409): a sha more than 256 commits ahead of derived history.
  - `deriving` (503): ask again.
  - `upstream_failed` (502): Artifacts failed.
- Like the run reads, the binding is the trust boundary: callers check access first (MCP's `scope.context(repo)`).

### MCP `why_lines(path, start?, end?, ref?, repo?)`

One read-only tool returns both blame and history, to keep the tool count down. The server lists about 40 tools already, past the 30 that `claude-06` recommends. The answer is compact JSON:

```json
{"path":"src/tax.ts","ref":"sprout","commit":"a2634248d5","lines":4,
 "ranges":[{"lines":"1-2","bean":"raise-tax","commit":"a2634248d5","kind":"landing"},
           {"lines":"3","bean":"round-tax","commit":"9c1e0f3b77","kind":"landing"}],
 "beans":{"raise-tax":{"title":"Tax invoices at 25 percent","actor":"coop","decisions":["card-7"],"reverted":false}},
 "history":[{"commit":"9c1e0f3b77","kind":"landing","bean":"round-tax","change":"modified","at":"…","on_stalk":false}],
 "summary":"2 beans last changed these lines: raise-tax, round-tax. Read their titles and decisions before changing them."}
```

Lines no bean owns (the base, or an engine commit) carry the commit's `title` instead.

## Differences from Scion's design and from the first sketch

- Rows live in a Durable Object per repository engine, not in the RepoDO (Gitstalk has no RepoDO). The feed is the `repo-events` queue, not the landing itself.
- There are no commit-graph skip lists: positions on a first-parent chain answer "state at or before" with one indexed query.
- The decision cards that bear on a bean are those whose `decision.asked` named it, as the bean or as the one it was weighed against.

## Tests

- `src/derive/blame-spans.test.ts`: property tests against a naive per-line oracle. Random insert, delete and replace sequences go straight through `applyHunks` (300 seeds × 25 steps) and through the real line diff (200 seeds × 15 landings, several edits per landing). Every result is checked well-formed.
- `src/derive/derivers.test.ts`: blame across landings, and reverts that restore earlier owners while keeping later beans' lines (also with the reverted line at every position).
- `test/derived.test.ts` (Miniflare, real DO and RPC):
  - Blame and history over a registered repository, a revert, an older ref, and a missing file.
  - The consumer's feed, with titles, decision cards and the stalk.
  - Refused refs and engines.
- `packages/mcp/test/why-lines.test.ts`: two beans landed through the real engine, read through the MCP tool.

## Later

- Show "why" in the web app's file view. The RPC is there; the view is not.
- Derivers for `overlap_index`, `test_impact` (from read maps) and `symbol_index`.
- One fork per bean (`docs/claude-18`, if it lands) changes nothing here: the feed and the chain are the trunk's.

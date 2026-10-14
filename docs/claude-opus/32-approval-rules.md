# 32. Approval rules by kind of change

Built 2026-10-14. Motivation: Anthropic's "Redesigning source control at Anthropic" (Scion), which describes review tooling with semantic approval rules that tell comment-only changes apart from sensitive logic changes, and access control per directory (paraphrased). Here a repository says, in one file on its stalk, which kinds of change land on their own, which Clef triages and which wait for a person; classes are computed by code, never by a model, and every routing leaves a receipt.

Code: `packages/shared-race/src/policy-file.ts` (file format, parse, JSON Schema), `approval-policy.ts` (classes, routes, receipts), `code-tokens.ts` (the comment-only lexer); `packages/gateway/src/approval/` (the gate, its store and host, the Clef adapter, the Settings RPC); `packages/web/app/[owner]/[repo]/settings/rules` and `components/rules/`.

## 1. The file: `.gitstalk/policy.yml`

```yaml
# yaml-language-server: $schema=https://gitstalk.dev/schemas/policy.json
groups:
  security: ["@alice", "@bob"]
classes:
  - name: comment-only
    match: { syntax: comments-and-whitespace }
    route: auto
  - name: docs
    match: { class: docs-only }
    route: auto
  - name: migration
    match: { paths: ["src/db/migrations/**"] }
    route: card
    reviewers: ["@data"]
  - name: protected
    match: { paths: ["src/auth/**"] }
    route: card
    writers: ["@security"]
  - name: api
    match: { paths: ["src/api/**"] }
    route: triage
```

- `classes[]`: `name` (lower-case, dashes, unique; `policy-change` is built in), `match`, `route`, optional `reviewers`, optional `writers`.
- `match` is one of `{ paths: [...] }` (any changed file matches a pattern; the patterns are `protected_paths`' glob, `24-checks-config.md`), `{ syntax: comments-and-whitespace }` (every changed file differs only in comments and whitespace), or `{ class: docs-only | tests-only | lockfile | comment-only }` (a built-in class, below).
- `route`: `auto` (lands and promotes as before), `triage` (Clef picks `auto` or `card`), `card` (held until a person approves).
- Principals: `@handle` (a person; a push acting for them, by any credential), `@group` (a name under `groups`, which wins over a handle of the same name), `agent:a<slot>` (a race's agent slot).
- `.beanstalk/policy.yml` is read when `.gitstalk/` has none (`config-dir.ts`). No file: every bean is `auto`, exactly as before, and pushes show no rules lines.

**Format decision (owner, 2026-10-14): YAML, not TOML and not a section of `checks.toml`.** Automations are already `.gitstalk/automations/*.yml` in GitHub Actions syntax, and GitHub's repository-config convention is YAML (dependabot.yml, labeler.yml, workflows). `checks.toml` stays as it is. Parsing is strict: the `yaml` package (catalog 2.9.1) with YAML 1.2 core schema (`no` stays a string), unique keys, and anchors, aliases and merge keys refused, then Zod in `checks-config.ts`' style. Every problem carries line, column and field; `POLICY_JSON_SCHEMA` is generated from the same Zod schema (`z.toJSONSchema`) for the `yaml-language-server` first line. Property tests: every valid policy written by `writeApprovalPolicy` reads back equal; no input throws.

A separate file rather than keys in `checks.toml` also matches where each is read: checks come from the tree being checked (a bean may change its own suite under `protected_paths`), the rules come from the stalk (a bean never changes the rules that judge it).

## 2. Classes, computed by code

- **Built in, for every bean:** `docs-only` (every file is `*.md|mdx|markdown|txt|rst|adoc` or under `docs/`), `tests-only` (under `test/`, `tests/`, `__tests__/`, or `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`), `lockfile` (every file a package manager's lockfile), `comment-only` (below). Each holds only when every changed file has the kind.
- **`comment-only`** (`code-tokens.ts`): each side of each changed file is lexed into code tokens with `//` and `/* */` comments and whitespace dropped, keeping string, template (with `${}` nesting), regular-expression and Rust raw-string, char and lifetime literals whole; the streams must be equal. Judged for TypeScript and JavaScript (not JSX, where `//` can be text), Rust, C and C++, Java and Go. Every doubt is "not comment-only" (an added, deleted, binary or unknown file, anything unterminated, files over 512 KB; punctuation runs are kept whole, so `a+ +b` never equals `a++b`, at the price of calling a `)+(` → `) + (` reformat code). File contents are read (one Artifacts diff of the merge) only when the policy has a syntax class and every changed file is in a judged dialect.
- **`policy-change`:** any change under `.gitstalk/` or `.beanstalk/` except `backlog.md` (agents tick tasks with ordinary beans) is routed `card` whatever the file says, when it comes from an agent. When the push is a person's own and they may decide (owner or maintainer, personal token, SSH key, or the web's Settings editor), the push is the decision: the class is listed and the other classes route it. The policy file is also always protected (`ALWAYS_PROTECTED` in `checks-config.ts`, next to the checks file), so only those people can change it at all.
- **Route:** the strictest matched class wins (card over triage over auto). A comment-only change takes the route of the policy's comment-only class when it has one, even in a sensitive path: no behaviour changed. Writer limits always apply.

## 3. Where it runs, and why

In the gateway (TypeScript), at the pre-land check job, before the suite (`run/run-jobs.ts` → `approval/approval-gate.ts`):

- The squash already returns the changed paths (`LandingTree.files`), so path classes cost no Artifacts call; the runner would have needed a protocol change and an image redeploy on deadline day.
- The policy, its parser and the lexer are one TypeScript module the web's Settings page and MCP also import (the owner asked for one shared parse).
- Comment-only needs file contents, which the gateway reads with one `changedFiles` diff only when the policy asks for syntax and every file is judgeable.
- It runs in the job, outside the engine's deterministic reducer: the engine sees an ordinary check result (green, or a red with one failing "test"), so with the rules off every run replays exactly as before (parity and determinism tests unchanged).

The policy is read from the **stalk** head at each judgement (`branchHead('stalk')` plus the file at that commit), never from the bean. A stalk that cannot be read is a retryable job failure, never "no policy".

## 4. Routes

- **Writers.** A bean whose principal is outside a class's `writers` falls off at the pre-land check, the same way a protected path does (`guardRed` in `checks/repository-checks.ts`, one failing "test" `changes a class it may not write`, naming the classes and who may). This extends the protected-paths mechanism rather than adding a second guard: `protected_paths` says "a person who decides, with their own credential"; `writers` says "these principals". Principals: a repository's push is `@<handle>` of the person it acts for; a race's bean is `agent:<slot>` of the sandbox its check runs in.
- **Card.** Held before landing, not before promotion: a held bean's check answers a red `awaits approval by a person` that says nothing needs fixing. Holding before promotion would mean new engine state, timers and inputs in the reducer that races replay, on deadline day; holding before landing reuses the fall-off and re-submit paths the engine already has. A maintainer approves (`approveBean(run, bean, actor)`, RPC; the caller checks the person may decide, as `decide` does); the approval is for the bean's current revision (its pushed head), and a repository's bean waiting for its author is re-submitted at that head at once, so its check runs again and passes. A new push needs a new approval. In a race (no pushes) the approval holds for the bean, and it passes at its next submission; a held race bean spends rework rounds while it waits, which is why races keep the rules off.
- **Triage.** Clef (`@cf/cloudflare/clef-flash`, System One body with `model: 'clef-flash'` and one `choice` question `route` with criteria for `auto` and `card`) answers within 2.5 s; otherwise the rule does: `auto` when the bean is also comment-only, docs-only or tests-only, else `card`. Clef holds a bean only when it picks `card` with probability at least 0.65 (`CARD_MIN_PROBABILITY`); a less certain `card` lands on its tests, and the receipt shows `auto (clef, p=<auto's probability>)`. The staging benchmark (`research/race/runs/stg-scion-policy-fastify-16-s*`) showed why: a `card` at p=0.51 held the same bean on every seed with nobody to approve it. The answer is reused while the change (classes, files, policy commit) is the same. The gate asks through `@gitstalk/shared-ask/pick/decision-model` (`askChoice`, `decisionModelFrom`), the module the picker uses; the local adapter it started with was removed on 2026-10-14. Clef only sees class names and paths, never contents.

## 5. Receipts

Every judged bean leaves a `RouteReceipt` in its engine's SQLite (`bean_routes`): classes, route, the deciding class, `by` (`policy`, `clef`, `rules`), Clef's probability, principal, reviewers, a refusal, the approval (`not-needed`, `awaiting`, `approved` by whom), the policy file and stalk commit it was judged by, the revision, the time. Surfaces: the push's `remote:` lines (`approval rules: api -> card (clef, p=0.81)`), MCP `bean_status` (`route`, and a "held for a person's approval" next step), the gateway RPC `beanRoute(run, bean)` and the `route` field of `beanDetail`.

## 6. Turning it on

`approval_rules` in the run config (`shared-race/src/run-config.ts`, `approvalRulesOf`): absent means on for a repository engine reading its own checks (new repositories; with no policy file nothing changes) and off for races and engines with an operator's suite. No preset (`demo`, `v24`) sets it, so published race numbers are unchanged. A race opts in with `"approval_rules": true` in its `POST /v1/runs` body; a repository engine can set it in `settings.engine` when opened.

## 7. Settings → Approval rules

`/<owner>/<repo>/settings/rules`: the YAML in the builder's editor pane, validated as you type by the same `readApprovalPolicy` the engine runs (same messages, line numbers). Owners and maintainers save; everyone else reads, with why. A save goes through the one server-side commit flow that `bean_commit` and the automation builder use (doc 33; `automations/editor-rpc.ts` `pushSave` → `RunDO.repoSaveFile` → `commit/file-save.ts` → `commit/server-commit.ts`): the engine validates the path and size, commits the new text on the latest landed commit, authored by the signed-in person (trailers `Actor: @<handle>`, `Via: Settings → Approval rules`), pushes it as a new `bean/rules-<short>` by compare-and-swap (it must not exist) and submits it like any push. The page sends an idempotency key made once per save attempt, so a double click or a retried request makes one bean; it lands through the pre-land check, and the page shows the commit and follows the bean until it lands. Since the person may decide and saved with their own identity, the bean is not held for a card. RPC: `rulesSource`, `saveRules`, `rulesBean` (`shared-race/src/rules-editor.ts`); `policyGet(run, ref?)` returns the parsed policy on the stalk (or a ref), its commit and its problems.

## 8. Not done

- No visible label in the web bean view yet (the receipt is on `beanDetail` and `beanRoute` for it).
- No approve button in the web: approvals go through the `approveBean` RPC.
- `reviewers` are shown, not enforced: any person who may decide approves.
- Clef's answers are not yet compared with later human decisions.
- A holding race bean spends rework rounds (§4).

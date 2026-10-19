# Optional pre-land test skipper

Owner direction, 2026-10-19: focus the product work on test skipping, as a Gitstalk optimization that is off by default. This is an experimental, restricted adapter, not a deployment or a measured improvement over the published agent races.

## Enablement and scope

Set `"test_skipper": true` in an authenticated `POST /v1/runs` configuration with `"policy": "beanstalk-v2"`. Omission and explicit `false` both preserve full pre-land execution. Stored configurations from before the field existed load it as false. Queue runs reject true; their baseline remains unchanged. This setting is currently exposed on run configuration only; it is not a `.gitstalk/checks.yml` key or a repository settings toggle.

Only ordinary pre-land checks receive the opt-in. Existing explicitly targeted landing checks retain their targets. The skipper never changes the scope of sprout validation, bisection, final suite or final acceptance checks. Existing explicit targeting and evidence settings retain their own behavior. A selected pre-land result cannot qualify for full-check reuse, promotion vouchers or the special full-green `repair_landing` window bypass; any earlier voucher on that landing flow is cleared. The gateway rejects a selected response to a required full check.

The first adapter supports a restricted subset of JavaScript/TypeScript ESM under the existing `node --test` runner. It selects **test files by transitive module dependencies**, not individual test cases or covered functions. Function-level coverage remains future work; earlier research savings do not describe this implementation. Node's execution here does not add a TypeScript typecheck or a build gate; neither existed in this runner's check command. It removes none of the existing validation gates.

## Selection and evidence

The forge-owned analyzer in `packages/test-skipper` runs outside the checkout, bundled with pinned Acorn. It strips erasable TypeScript syntax for parsing, follows explicit relative imports and re-exports, handles cycles, and fingerprints every file's bytes and mode. It does not execute or import repository code. Recognized test inventory is `*.test.{js,mjs,ts,mts}`. The full run's reported passing files must exactly equal this inventory before evidence is accepted; other Node discovery conventions therefore cannot silently seed an incomplete baseline.

The Rust runner retains at most eight repository baselines in memory. A baseline requires a **full passing suite**, complete passing-file inventory, no unsupported dependencies, and identical input snapshots before and after execution. Only the default `node --test` command, full scope, no tracing, no extra files, no custom environment and no dependency snapshot can seed it. Selected passes never advance the baseline. Evidence is scoped to the repository URL, process lifetime, captured environment, Node/parser versions, and suite/test limits. Container restart or eviction means a full run; there is no shared durable evidence database or agent-supplied evidence.

For an eligible candidate, the runner compares every file fingerprint to its baseline. Tests whose old or new transitive dependency closure intersects a changed source file execute. Other tests can be skipped. A selected run always has at least one executing file and one skipped file. If all or none are affected, it runs the full suite. A red execution or changed inputs invalidate the cached baseline. A selected execution whose input snapshot cannot be verified afterward is reported red, never green.

`selection` in the runner response and `preland.check` event contains `mode`, `reason`, `baseline_sha`, `selected_files`, and `skipped_files`. Ordinary `tests`, `passing_files` and suite duration describe actual execution only. Skipped files are not reported as newly passing. On a full fallback the analyzer's inventory may be empty or incomplete; the full runner command and actual JUnit results remain authoritative.

## Full-suite fallbacks

- Missing analyzer, analyzer errors/timeouts, no full green baseline, or different runner/recipe.
- Added/deleted files, changed test inventory, or changed non-source files (configuration, lockfiles, fixtures and other resources).
- Syntax the adapter cannot parse, CommonJS, third-party imports, missing/ambiguous relative imports, module URLs with escapes/query/fragment, symlinks, non-UTF-8 sources, or a checkout exceeding 10,000 files/directories or 16 MiB of file data.
- Dynamic imports, filesystem/network imports, environment/time/randomness access, reflection, computed members and unsupported calls. The initial call subset is named functions/imports, selected primitive conversions, assertions and deterministic Math calls. Many normal applications will fall back; eligibility is intentionally limited.
- Custom commands, explicit test lists, extra files, custom suite environments, dependency snapshots or read-map tracing. These keep the caller's original execution scope and do not seed evidence for a full suite.

These restrictions are an experimental adapter, not a proof that arbitrary JavaScript is deterministic. The existing sprout/final validation machinery remains the acceptance authority. Tests must not depend on external mutable state or test-process ordering for the optimization to be useful.

## Packaging and verification

Runner wire API 5 adds `test_skipper` and `selection`; the gateway and runner versions move together. The Docker image bundles the analyzer at `/opt/gitstalk/skipper.mjs`. The deploy image stamp includes its sources and dependency lock/catalog files. Locally, `pnpm -F @gitstalk/test-skipper build` prepares the analyzer before standalone Rust tests; `pnpm check` builds it as part of the package's test step before Rust runs.

Verification covers default-off configuration, opt-in persistence and legacy storage, pre-land-only wiring, full-check response enforcement, refusal to promote selected results as full evidence, real git/Node selective execution, transitive regressions, red-baseline invalidation, cold runners, separate repos, recipe/config/inventory changes, dynamic imports, explicit targets, extra files, custom environments, read-map tracing, parser uncertainty, source modes and symlinks.

## Performance and existing check reuse

The reproducible paired replay is in [`research/test-skipper`](../research/test-skipper/README.md). It measures the real runner HTTP pipeline, including cold startup/cache, git operations, analysis, tests and full validation. It excludes coding agents, the cloud gateway scheduler, container provisioning and remote Artifacts latency. A four-CPU local result is not an end-to-end hosted forge race.

The existing `reuse_checks: true` default can already eliminate CI after a full green pre-land check on the identical commit. A selected result deliberately loses that privilege. Skipping is therefore useful only when saved pre-land execution outweighs analysis and any extra validation. It is not a general replacement for check reuse. Small suites, unsupported applications, cold runner pools and changes touching most modules are poor candidates. Selected passes do not advance the baseline, so the affected set can grow across successive commits.

Measured results and exact tool versions are recorded with the benchmark. The setting stays off by default; enable only for a measured workload. A live multi-agent replay is still required before claiming a throughput improvement over the published Gitstalk results.

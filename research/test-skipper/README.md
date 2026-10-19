# Optional test skipper: paired runner replay

This benchmark exercises the production Rust runner through HTTP. It replays existing or generated git commits instead of paying coding agents to produce them. It measures startup, cold git/evidence caches, fetch, squash, checkout, test selection, real Node tests, ref updates, validation and a final full suite. Both arms must agree on every comparable verdict, failing file, conflict and final git tree.

This is a **local runner pipeline measurement**, not a hosted multi-agent race. It excludes the gateway scheduler, coding time, cloud container provisioning, Artifacts latency and CI slot contention. No sleeps or simulated test durations are used. The numerical fixture does actual modular arithmetic and asserts its result; changing the multiplier order is a semantics-preserving source edit. A planted arithmetic regression must be rejected in both arms.

## Reproduce

Use Node 24 or newer, pnpm, Python 3.11 or newer, git and Rust 1.96.0. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm -F @gitstalk/test-skipper build
RUSTUP_TOOLCHAIN=1.96.0 cargo build --release --locked -p runner
python3 research/test-skipper/benchmark.py \
  --runner target/release/runner --repeats 5 \
  --output /tmp/skipper-results.json
```

If `CARGO_TARGET_DIR` is set, use its `release/runner` instead. Run on an idle machine; build and test before timing. Each arm starts its own runner and remote. On/off order alternates across repetitions. Fixture creation and compilation happen outside the timed interval; runtime startup and the cold baseline check are inside. Runner shutdown is outside. OS page caches are not flushed. `SUITE_NETWORK=host` is explicit for this local, dependency-free replay; Cloudflare network isolation and container startup are not being measured.

## Workloads and validation schedules

- **modular-cpu:** Eight independent test files, each behind a re-export and a source module. Each assertion performs ten million modular arithmetic iterations. Six independent source refactors land, a seventh change introduces a detected regression and is rejected, and a configuration edit lands. Both arms run full validation after each three lands and a final full suite (`batch-full`). This represents the cost when full validation is required independently of pre-land checks, such as a moved sprout; it does not simulate concurrent landings or the gateway's batch selection.
- **modular-tiny:** The same commits and assertions with one hundred arithmetic iterations. It exposes analysis overhead when tests are cheap.
- **existing-arena:** The checked-in runner arena bundle, replaying `ref/t001`, `ref/t002`, `ref/t005`, and `ref/t040`. The first three land; t040 has the known billing-service conflict and is left unlanded in both arms. Both arms use the append-only `CHANGELOG.md` union policy. All test-bearing checks run the full suite when the adapter cannot establish eligibility. This is the designed arena, **not Fastify**.
- **modular-cpu-reuse:** The same CPU fixture with `same-head-reuse`: a full green on the exact landing commit needs no duplicate validation, as the existing `reuse_checks` default permits. A selected green must receive full validation before promotion. A final full suite runs in both arms. This isolates the cost of giving up full-check reuse; validation executes serially here, so it is not a prediction of asynchronous CI wall time.

Only cold/pre-land checks in the on arm request `test_skipper`. Validation and final checks never do. Full validation does not seed the skipper cache, and selected greens do not advance it. Changed dependencies therefore accumulate across the six source edits. Both arms exercise cold startup and regression detection; a new process in the next arm cannot reuse the earlier arm's evidence.

The feature remains off by default. The analyzer is intentionally narrow: CommonJS, dependency snapshots, custom test commands/environments and read-map tracing fall back. These measurements cannot establish a gain on Fastify, the shop arena or the published Gitstalk agent races.

## Results: 2026-10-20

[Raw paired measurements](results-2026-10-20.json), five pairs per workload (40 arm executions), alternating order. Linux aarch64 in Docker, four CPUs by affinity, Node 24.22.0, Rust 1.96.0 release build. The production image uses linux/amd64 and Node 25.8.1; these are local A/B results, not its measured latency. No builds or test suites ran in the benchmark container during the recorded run. The shared host still shows timing variation, particularly in short suites; these five samples are not a statistical confidence interval.

| Workload | Off median | On median | Median paired off/on ratio (range) | Test cases off → on | On faster |
|---|---:|---:|---:|---:|---:|
| Modular CPU, full validation schedule | 10.53 s | 9.80 s | **1.11×** (1.05–1.28×) | 96 → 68 | 5/5 |
| Modular tiny, full validation schedule | 3.66 s | 4.48 s | 0.95× (0.42–1.19×) | 96 → 68 | 2/5 |
| Existing arena | 15.07 s | 14.70 s | 1.01× (0.83–1.26×) | 514 → 514 | 3/5 |
| Modular CPU, same-head check reuse | 9.21 s | 13.50 s | **0.73×** (0.68–0.82×) | 80 → 100 | 0/5 |

The paired ratio is the median of each pair's off time divided by its on time; it is not the ratio of the two independently calculated median times. Above one means the skipper was faster. Test-case counts are stable across repeats. Each modular test file has one assertion; arena files can contain multiple cases.

The CPU fixture executed **29.2% fewer test cases** with the full validation schedule, but the total wall-time gain was modest after analysis and git overhead. Its cold baseline check cost a median 0.92 s off and 1.12 s on; cold acquisition is included in the totals. The entire replay's test subprocess time had medians 10.03 s off and 7.98 s on, while total time fell from 10.53 s to 9.80 s. Counting only saved suite time would overstate the benefit.

The arena selected **zero** checks: every opt-in check fell back for unsupported dependencies/syntax. Its mixed timing difference is noise, not skipper savings. Three tasks landed and the same billing conflict was reported for t040 in every arm. The tiny suite also has no reliable benefit. With same-head reuse, selected greens require six additional full validations: 16 total checks versus 10 off, and 25% more executed test cases. Keeping full-check reuse won every pair.

All **20 paired replays** produced identical final trees, comparable pass/fail verdicts and failing-file sets. All **30 injected regression executions** (three modular scenarios × five pairs × two arms) were detected and left unlanded. Final checks ran the full suite in every arm. These results support an **experimental off-by-default setting**, not enabling the skipper for the existing arenas or claiming an improvement over the published multi-agent races.

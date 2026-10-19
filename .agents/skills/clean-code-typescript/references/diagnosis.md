# TypeScript diagnosis

Load only the section relevant to the finding. These are investigation leads, not a list of mandatory rewrites.

| Observed problem | Investigation | Evidence for a repair |
|---|---|---|
| Agent edits a similarly named implementation or misses a consumer | Trace imports, exports, package aliases, framework entry points and generated files; inspect prior failed patches | Demonstrate the ambiguous boundary; fix the smallest misleading name, contract or lookup path |
| Failure cannot be reproduced | Check hidden mutable state, real time, randomness, shared fixtures and missing setup | Reproduce independently; isolate only the state preventing that |
| Wrong values cross a boundary | Compare runtime validation, generated declarations, schema and caller expectations | Test a real invalid value or confused identifier; use the existing validation/type system where possible |
| Work is lost, duplicated or outlives a request | Trace promise ownership, retries, cancellation and commit/side-effect order | Exercise completion, rejection, cancellation and idempotency at the affected boundary |
| A file/export is reported unused | Check package consumers, route discovery, dynamic imports, scripts, code generation and side-effect imports | Confirm reachability before deletion; fix detector configuration for legitimate entry points |
| Typecheck/build is slow | Measure cold/warm runs, package selection, dependent consumers and actual subprocess overlap | Compare equivalent checks; missing dependencies or uncertain history must not silently skip required checks |

`satisfies` checks type compatibility; it does not validate runtime input. Keep generated types generated. Do not add a runtime schema to every internal function or replace a working error convention just to follow this skill.

For Workers/DO code, confirm behavior against the pinned platform/runtime and its relevant guidance. Single-threaded execution does not mean a handler is atomic across external asynchronous work. A dropped promise or an in-memory cache is not a durable completion guarantee. Use real runtime integration checks where those semantics matter.

Performance changes need a baseline: repeated requests, query count, typecheck duration, allocations, transferred bytes or latency. Do not infer a bottleneck from syntax alone. Page rendering, client state and shared data caches need their own page-specific review.

Sources: [TypeScript satisfies](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html), [Knip reachability gaps](https://knip.dev/guides/handling-issues), [Durable Object concurrency](https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile).

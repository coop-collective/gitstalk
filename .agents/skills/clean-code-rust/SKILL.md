---
name: clean-code-rust
description: Use when explicitly assigned a post-merge Rust maintenance review or a specific agent-debugging, correctness, or performance improvement. Investigate ownership, task lifecycle and measured costs without enforcing cosmetic Clean Code rules. Not a default instruction for ordinary Rust edits.
disable-model-invocation: true
---

# Rust maintenance for agents

Optimize for locating, changing and verifying the relevant behavior. A successful review may leave the code unchanged.

## Establish the task

Read the finding, merged revision, crate/target/features, permitted changes and budget. Assessment means inspect and report; an authorized repair belongs on a separate branch/worktree. Preserve existing work and the pinned toolchain. Use repository commands and constraints rather than installing a new lint profile.

Stop once the finding is resolved and verified, the budget is reached, or needed evidence is unavailable. Reserve time for verification. Invocation does not authorize unrelated cleanup, merges, deployments or recurring runs.

## Diagnose before refactoring

- Search the failing behavior, symbol and call sites; inspect feature flags, macro expansion or generated sources when they obscure the implementation. Read ownership and error propagation across the affected boundary.
- Start from a reproduction, profiler, diagnostic or repeated agent error. Fix misleading search results, missing test setup or noisy output before rearranging source to fit an agent's read window.
- Function length, file length, parameter count, helper order and directory names are not acceptance criteria. Split only where an evidenced boundary reduces missed changes or makes behavior independently verifiable. Do not scatter one coherent algorithm across helpers to satisfy a threshold.
- Keep working types and APIs. Newtypes, traits, builders, enums and error libraries are tools for an actual invariant or extension need, not mandatory wrappers. Preserve valid bool parameters, mutation, `Option<Result<...>>` and straightforward clones when they fit the operation.
- A clone is not inherently a defect; avoiding it can introduce more complicated lifetimes or locking. Measure allocation/copy cost before optimizing it. Do not change release profiles, concurrency or ownership on aesthetic grounds.

## Verify the improvement

Read [diagnosis.md](references/diagnosis.md) for relevant runtime signals and [evidence.md](references/evidence.md) for the research limits.

1. Record a baseline and a useful success criterion. A bug reproduction must fail for the intended reason; a performance target needs representative inputs and comparable release builds.
2. Make the smallest justified change, preserving public behavior, persisted formats, cancellation and resource ownership. Comments should capture non-obvious units, lifetimes, ordering and contracts that prevent mistaken edits.
3. Run focused tests and the repository's format/lint/build checks with the relevant target/feature combinations, then required full gates. Do not assume `--all-features` is valid for mutually exclusive features. Avoid new tests that merely duplicate an implementation.
4. Compare correctness and performance separately. Green tests are scoped evidence, not proof of every race or performance gain. Check error and shutdown paths when the change affects them.

Report evidence, changed paths, commands/results and their limits, before/after measurements, and unresolved risks. Preserve no-change/deferred decisions so later maintenance does not reopen them without new evidence.

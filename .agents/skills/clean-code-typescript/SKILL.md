---
name: clean-code-typescript
description: Use when explicitly assigned a post-merge TypeScript maintenance review or a specific agent-debugging, correctness, or performance improvement. Diagnose concrete obstacles, make justified changes, and verify behavior. Not a default instruction for ordinary feature edits.
disable-model-invocation: true
---

# TypeScript maintenance for agents

Improve the cost and reliability of the next real task. A successful review may recommend no changes.

## Establish the task

Read the assigned finding, merged revision, affected package, permitted changes and budget. For an assessment, gather evidence without editing. For an authorized repair, work on a separate branch/worktree from the merged revision; preserve existing work. Missing context is a reason to narrow the investigation, not invent a repository-wide cleanup.

Use existing project commands and constraints. Stop when the assigned issue is verified, the budget is reached, or further progress needs unavailable evidence. Reserve time for verification. Do not merge, deploy, schedule another run, or expand scope merely because this skill was invoked.

## Find an obstacle before changing code

- Localize from an observed failure, trace, repeated agent mistake or measured cost. Search paths and symbols, then read relevant implementations, callers and tests. Follow actual imports, runtime registration and generated boundaries.
- Prefer better search, bounded reads, test selection or a missing command over changing source layout to accommodate a tool's output window.
- Refactor only when evidence connects structure to the problem: ambiguous implementations caused wrong edits; coupled changes repeatedly missed a caller; hidden state made reproduction unreliable; an expensive path is measured.
- File length may prompt inspection. Do not assume a universal agent function/file limit. Do not split coherent code to meet a line count, parameter count, declaration order or directory-name preference. Avoid helpers that merely add navigation hops.
- Preserve working interfaces and representations. Introduce branded types, schemas, options objects or abstractions when they prevent a demonstrated mistake or express a necessary contract; do not require them everywhere. Cosmetic renaming, blanket immutability and changing error libraries are not maintenance outcomes.

## Repair and verify

For TypeScript-specific signals, read [diagnosis.md](references/diagnosis.md). For claims about agent effectiveness, read [evidence.md](references/evidence.md).

1. Record the baseline and the smallest useful success criterion. For a bug, verify a focused reproduction fails for the intended reason before changing behavior. For performance, measure representative inputs and define the metric.
2. Make the smallest change that addresses the cause. Preserve contracts, auth boundaries, persisted formats and relevant regression tests. Document non-obvious units, ordering or ownership where that information prevents mistakes.
3. Run relevant type/lint checks and behavior tests, then required project gates. Check callers and integration boundaries the narrow test does not cover. Do not add tests that only mirror a cosmetic edit, weaken checks, or retry failures until green.
4. Compare results on equivalent inputs. A shorter file, fewer lines, green tests or a higher coverage percentage alone does not prove better agent performance.

Report the finding and evidence, changed paths, checks and their limits, measured before/after results, and remaining risk. Record no-change/deferred findings with a reason so subsequent maintenance runs do not repeat the same work.

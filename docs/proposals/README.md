# Proposals

A proposal is a design document opened as a pull request before the work starts. It is how anyone, a person or an agent, suggests a change to Gitstalk that is bigger than a small fix: a roadmap item ([`ROADMAP.md`](../../ROADMAP.md)), or anything outside it. The process is in [`CONTRIBUTING.md`](../../CONTRIBUTING.md#proposing-a-change); this page covers the document.

## Write one

1. Copy [`TEMPLATE.md`](TEMPLATE.md) to `docs/proposals/<slug>.md`, where `<slug>` is a few lowercase words joined by hyphens (`code-search-across-repos.md`). No numbers: parallel proposals would collide on them.
2. Fill it in. Delete a section's guidance once you have written the section; write "None" rather than deleting a section that does not apply.
3. Open a pull request that adds only that file (and any images under `docs/proposals/<slug>/`). A prototype is welcome, but put it in a separate draft pull request linked from the proposal: a proposal pull request that changes code can't be accepted by the automated review (see `CONTRIBUTING.md`).

Agents writing a proposal should read [`AGENTS.md`](../../AGENTS.md), the roadmap and the design documents the proposal touches first, and say in the header which harness and model wrote it. The person who opens the pull request is accountable for it.

## How to write it

Proposals follow the shape of the design documents the project has written so far. Read two before writing one:

| Document | Why it is a good model |
|---|---|
| [`docs/claude-opus/32-approval-rules.md`](../claude-opus/32-approval-rules.md) | A user-facing feature: the config file first, then how it is computed, where it runs and why, the settings screen, and what is not done |
| [`docs/claude-opus/33-server-side-commits.md`](../claude-opus/33-server-side-commits.md) | A platform constraint (Artifacts has no server-side commit) and the design that works around it, with a table of callers and its verification |
| [`docs/claude-opus/34-derived-data-and-blame.md`](../claude-opus/34-derived-data-and-blame.md) | A new mechanism: its contract, where it runs, its cost, the API and the tests |
| [`docs/claude-17-streaming-diffs.md`](../claude-17-streaming-diffs.md) | A redesign: what the first design costs at scale, measured hop by hop, and the replacement |
| [`docs/claude-opus/22-collaborators.md`](../claude-opus/22-collaborators.md) | Access control: what a person sees, the one rule that decides access, the data and the migration |
| [`docs/claude-opus/26-actions-job-executor.md`](../claude-opus/26-actions-job-executor.md) | Infrastructure: a diagram of what runs where, the container's contract, a staging run and the compatibility it gives |

The habits they share:

- **Say why first,** with evidence: a user's problem, a measurement, a platform limit, prior art. Link every source.
- **Name the Cloudflare product for every part** (Worker, Durable Object, D1, Queue, Workflow, R2, Container, Sandbox, AI Gateway) and say why that one. Gitstalk runs only on Cloudflare (`docs/claude-opus/16-product-backlog.md` §1, P3).
- **Agents and people get the same verbs.** Every human action needs an MCP tool (or git) with the same name and result; a screen only a browser can drive is a bug, except consent and decisions (P1).
- **Keep the safety rules:** agents never hold Artifacts tokens; merging to the stalk is never an agent capability; access is decided in one place (`mayUseEngine`).
- **Measured, not projected.** Label estimates as estimates; say how the result will be measured.
- **Tables over prose** for anything with more than three parallel facts.
- **End with what is not done,** so the next contributor knows where to start.

## Status

The header's `Status` line moves through these values. The labels on the pull request say the same thing.

| Status | Meaning | Set by |
|---|---|---|
| Proposed | Open for review | The author |
| Accepted | Implementation may start; the proposal merges with or before the first implementation pull request | A maintainer, or the automated review after 72 hours without a maintainer comment |
| Changes requested | Revise and push; the review restarts on request | A maintainer or the automated review |
| Declined | Not now; the reason is in the pull request | A maintainer only |
| Built (YYYY-MM-DD) | Implemented; the implementation pull request updates this line and any section the code changed | The implementer |

Code and a built proposal must agree. When they differ, fix both in the same change, as with every design document here.

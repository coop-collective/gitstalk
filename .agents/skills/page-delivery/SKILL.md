---
name: page-delivery
description: Use when explicitly assigned a post-merge page-rendering or caching review, including vinext SSG, SSR, shared-data freshness, repeated requests and public leaderboards. Choose and verify a strategy per route. Not a default feature-building or site-wide optimization instruction.
disable-model-invocation: true
---

# Page rendering and cache maintenance

Review the assigned routes after merge or at an explicitly requested readiness checkpoint. Work from observed requests, source-query counts, cache behavior or a stated product requirement. An assessment does not imply permission to edit; an authorized improvement belongs in a separate branch/worktree. Respect the assigned budget and reserve verification time. No change is a valid result.

## Establish a contract per page

Record the route, public/private audience, personalization, indexable content, acceptable source-data age, update trigger, failure behavior, and expensive work. Inspect the installed vinext/framework version, router, adapter, bindings and production build before choosing APIs. Do not apply one rendering mode to every route.

Read [strategies.md](references/strategies.md) to choose among build-time generation, runtime regeneration, request-time rendering and client data. Read [leaderboard.md](references/leaderboard.md) when shared results are recalculated or revalidated on every visit.

Keep these decisions separate:

- **Rendering:** when HTML/RSC is produced and how it reaches the visitor.
- **Data production:** when shared results are computed, and who owns refresh.
- **Caching:** which layer stores which representation, its key/scope, original data timestamp, invalidation and failure policy.
- **Client updates:** hydration, query freshness, polling/subscriptions and mutations.

A server-rendered page need not recompute its data per request. A static page cannot silently become fresh just because its underlying data changed. Browser query caching does not share results across visitors.

## Make a justified change

Prefer the existing framework and cache capabilities. Do not add React Query, a queue, a Durable Object, a scheduler or a new cache layer unless the measured requirement needs it. Preserve auth and private/public separation. Evaluate deferred loading from actual transfer/render costs; retain useful initial content and avoid creating a request waterfall.

For each cache, name its key dimensions, refresh owner and freshness budget. Count time spent in upstream snapshots, propagation, response caches and browser/client state together. Preserve the source timestamp rather than renewing old data's age on every fetch. Mutation/revalidation hooks must belong to actual data changes, not an unconditional page-load effect.

## Prove the behavior

Use representative routes in the production build/runtime. For the affected behavior, check direct HTML loads and client navigation, warm/cold cache, concurrent requests, expiry, refresh failure and user isolation. Choose checks proportionate to the change; do not build a new test platform for an assessment.

Report source reads/aggregations, cache writes/refreshes, source timestamps, client requests and relevant latency/transfer measurements before and after. Public SEO/AEO review includes rendered content, status codes, indexing controls, canonicals and accurate metadata; do not claim ranking or answer-engine gains from a technical check alone.

Finish with the route's chosen strategy, evidence, verification limits and any deferred requirement. Stop after the assigned improvement. This skill does not schedule itself, merge or deploy.

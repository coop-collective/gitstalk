# Strategy per route

This matrix is a starting hypothesis. Preserve a working strategy unless product requirements or measurements justify changing it.

| Page requirement | Candidate strategy | Refresh owner |
|---|---|---|
| Public content changes with releases | SSG/build-time prerender | Deploy or content publication |
| Shared public data tolerates bounded staleness | ISR or cached HTML using a shared snapshot | Framework regeneration or an existing scheduled/event producer |
| Personalized account data | Private request-time SSR, or static shell plus authenticated client queries | Authenticated read/mutation |
| Public leaderboard plus private "your rank" | Public cached content with private client data, or private SSR reading shared public data | Separate public and private producers |
| Search/filter results | Dynamic rendering or client queries; cache bounded, deliberate variants | Search/query service |
| Truly live activity | Initial snapshot plus justified subscription/polling | Domain events or a bounded polling policy |

Choose request-time SSR when fresh/request-specific initial content is necessary. Choose SSG when publish-time content is sufficient and all required variants can be generated. Choose runtime regeneration when public content changes between deployments and tolerated staleness fits its semantics. Client rendering can suit private tools; it does not by itself make backend reads cheap.

For public content, SSG, cached HTML and SSR can all provide useful initial text. Google recommends server rendering or prerendering because not all crawlers execute JavaScript; this does not imply per-request SSR. [JavaScript SEO guidance](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics)

## vinext compatibility check

Checked against upstream commit `3fbfce42e7ac49c59f2ba00a5bb24044651b5298` on 2026-10-19; re-check the installed release before implementation.

- Static Assets snapshots are deployment artifacts; runtime revalidation does not update them.
- A writable runtime cache adapter and its bindings are separate from selecting a route's rendering policy. Response, data and browser caches have different lifecycles.
- App Router `revalidate` and Pages Router `getStaticProps` are different interfaces. Check router-specific support, invalidation and production behavior. Do not assume Next.js API parity or infer deployment placement from `runtime = "edge"`; that option affects App Router ISR in this version.
- Cache Components/PPR support is incomplete. Verify support before proposing `"use cache"`, partial prerendering or a particular adapter.

Sources: [pinned vinext caching guide](https://github.com/cloudflare/vinext/blob/3fbfce42e7ac49c59f2ba00a5bb24044651b5298/docs/caching.mdx), [compatibility differences](https://vinext.dev/docs/reference/differences).

## Client cache and loading

Inspect the existing query/router cache first. With TanStack Query, cached data is stale by default and stale queries can refetch on mount, focus and reconnect. Set `staleTime`, polling, invalidation and refetch triggers from the query's freshness requirement. Preserve source/SSR timestamps when seeding client data, and reset/scope private data across account changes. [Query defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults), [SSR and hydration](https://tanstack.com/query/latest/docs/framework/react/guides/ssr)

`staleTime` alone does not schedule refresh or remove expired data from the screen. If the contract imposes a hard display-age limit, choose a bounded refresh/subscription or an expired-data state, and test a tab left open beyond that limit. Do not add polling when the product only requires freshness on the next visit.

Lazy-load substantial optional UI when measured initial transfer/render work warrants it. Account for loading/error states, navigation prefetch and any extra waterfall. Do not defer the page's essential content merely to shrink a bundle statistic. [React lazy](https://react.dev/reference/react/lazy)

For AEO, establish crawlable, accurate, useful public content and ordinary SEO first. Google states its AI search features need no special optimization; this is not a guarantee about other engines or citations. [Google AI features](https://developers.google.com/search/docs/appearance/ai-features)

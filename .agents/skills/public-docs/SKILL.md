---
name: public-docs
description: How to keep Gitstalk's public documentation (packages/site/public/docs/, plain HTML on the marketing site) accurate after a user-visible change. Use whenever a change alters what a person or agent can do or see (git flow, push options or messages, repository pages, auth and tokens, MCP tools, checks, collaborators, Actions, automations, limits, self-hosting, deploy state), when an experiment concludes, or when asked to update, audit or check the docs. Covers which page to edit, the live / rolling out / coming soon labels, number style, the shared nav, and the check to run.
---

# Public docs

The public docs are static HTML pages in `packages/site/public/docs/`, styled by the site's
`../site.css` plus `docs.css`, served at `/docs/` on the marketing site. One page per topic:

| Page | Covers |
|---|---|
| `index.html` | Overview: the three words, who it is for, the 60-second start, the feature list with status pills |
| `repositories.html`, `git.html`, `agents.html`, `checks.html`, `collaborators.html`, `decisions.html`, `streaming-diffs.html`, `actions.html`, `automations.html`, `self-hosting.html` | One feature each |
| `architecture.html` | The engine's rules and why, the Cloudflare pieces, git proxy and identity, the measured results |
| `research.html` | What did not work: expected, measured, instead, with links to the runs |

## When something changes

1. Find every page the change touches: the feature page, `index.html` (feature list, getting
   started), `architecture.html` if the mechanics or a measured number changed, `research.html`
   when an experiment concludes (add an entry: Expected, Measured, Instead, sources).
2. Status labels must match what is deployed on the hosted service, never what is merged:
   - `live`: deployed and working there;
   - `rolling out`: built and verified on staging, not yet on the hosted service;
   - `coming soon`: designed or partly built.
   Change the pill on the page (`<span class="pill live|rolling|soon">`), the feature list in
   `index.html`, and the nav dot (`<span class="st live|rolling|soon">`) on every page.
   Sources of truth, best first: the person or coordinator who deployed (with the deployed
   gateway, web and MCP versions), the deploy notes in `docs/claude-opus/*` ("Live", "Live
   rollout"), then the status table in the plugin repository's README (`https://github.com/coop-collective/gitstalk-plugin#readme`; it can lag). When unsure,
   use the more cautious label and say why in your report.
3. Numbers: round as the landing page does (`6–9×`, `~1 min`, `about 2×`), state the setup and
   the caveat (seeds, simulated or real agents), and link the run or write-up on
   `https://github.com/coop-collective/gitstalk/tree/HEAD/...`.
4. Style: plain English, short sentences, sentence case, no hype. Never name the private
   platform repository, never print a secret, a token, an account id or a workers.dev subdomain
   (write `<gitstalk host>`).
5. The left nav is the same block in every page. A new page: copy an existing page whole, change
   its `<title>`, description, prompt line, `aria-current` and body, add it to the nav of every
   page in the same place, add prev/next pager links around it, and add its name to
   `DOCS_PAGES` in `packages/web/src/site/pages.ts` (the sitemap; a test fails without it). Keep
   its `og:title` and `og:description` in step with the title and description; never hardcode a
   canonical link, `og:url` or `og:image` (the web adds them per origin).
   Links are root-absolute clean URLs (`/docs/checks#suite`, `/agent`, `/docs/docs.css`):
   never `checks.html` or `../agent.html`, which break under /docs/ or cost a redirect.
6. Only the docs folder is yours. On the landing page (`packages/site/public/index.html`) and
   the other site pages, touch nothing but the Docs links.

## Check before you finish

```bash
node scripts/check-docs.mjs     # links are clean, absolute and resolve; every nav matches index.html
npx oxfmt packages/site/public/docs
pnpm check                      # must exit 0 (it also runs the docs check)
```

Look at a changed page at desktop and 390 px width, night and day (`?theme=light`), serving
`packages/site/public` locally: no sideways scroll, tables scroll inside their box.

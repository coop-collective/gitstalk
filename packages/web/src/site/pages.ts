/**
 * The public pages a deployment offers to search engines and link previews, by their canonical
 * (pretty) paths. The site's lists mirror packages/site/public: `pages.test.ts` fails when a page
 * is added there and not here, so the sitemap never misses one.
 */

/** The site's top-level pages, served without `.html` (each a reserved handle, never an owner). */
export const SITE_ROOT_PAGES: ReadonlyArray<string> = [
  'about',
  'agent',
  'human',
  'privacy',
  'terms',
];

/** The public docs: packages/site/public/docs/<name>.html, served at /docs/<name>. A `_` file (the kit demo) is not a page. */
export const DOCS_PAGES: ReadonlyArray<string> = [
  'account',
  'actions',
  'agents',
  'approval-rules',
  'architecture',
  'ask',
  'automation-builder',
  'automations',
  'blame',
  'checks',
  'cloud-agents',
  'collaborators',
  'concepts',
  'decisions',
  'dependency-cache',
  'environment-variables',
  'git',
  'limits',
  'mcp',
  'organizations',
  'quickstart',
  'repositories',
  'research',
  'secrets',
  'self-hosting',
  'settings',
  'streaming-diffs',
  'troubleshooting',
];

/**
 * The app's own pages worth a search result: signing up, as a person or through an agent.
 * Sign-in (/login) is left out on purpose: it has nothing to find for someone without an
 * account, and the sign-up pages link to it. It is still crawlable and has its own canonical.
 */
export const APP_PUBLIC_PAGES: ReadonlyArray<string> = ['/signup', '/signup/agent'];

/** Every site page's canonical path: the landing, the top-level pages, the docs. */
export function sitePagePaths(): ReadonlyArray<string> {
  return [
    '/',
    ...SITE_ROOT_PAGES.map((name) => `/${name}`),
    '/docs/',
    ...DOCS_PAGES.map((name) => `/docs/${name}`),
  ];
}

/**
 * The Claude Code and Codex plugin's names, in one place for every install line the web app and
 * the gateway print. The static pages (the marketing site, the docs, the plugin README) spell
 * the same lines out; `docs/claude-opus/30-environments.md` §12 lists them for a move. The plugin
 * itself lives in its own repository (coop-collective/gitstalk-plugin), not in this monorepo.
 */

/**
 * The public repository whose `.claude-plugin/marketplace.json` lists the plugin at its root
 * (default branch `main`; `owner/repo#branch` names another branch). The service repository,
 * disturbing/beanstalk, keeps a marketplace that points here so installs made from it still
 * update. When the plugin moves to the `gitstalk` GitHub org this is the one value to change.
 */
export const PLUGIN_MARKETPLACE = 'coop-collective/gitstalk-plugin';

/** `<plugin>@<marketplace>`, as `plugin install` takes it. */
export const PLUGIN_ID = 'gitstalk@gitstalk';

/** The MCP server's name in the plugin's `.mcp.json`, and in a plain `mcp add` line. */
export const MCP_SERVER_NAME = 'gitstalk';

/** The plugin's MCP server as `claude mcp login` names it. */
export const PLUGIN_MCP_SERVER = `plugin:gitstalk:${MCP_SERVER_NAME}`;

/** The plugin's slash command that connects git (`/gitstalk:setup`). */
export const SETUP_COMMAND = '/gitstalk:setup';

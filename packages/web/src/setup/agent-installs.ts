/**
 * The commands `/signup/agent` prints, per harness (`docs/claude-opus/16` item 1.4). The plugin
 * comes from the public marketplace repository, whose `.mcp.json` names the hosted MCP server
 * with no auth header, so each client runs its own OAuth sign-in. A deployment serving
 * another MCP address (staging, a fork) gets plain `mcp add` lines for its own address instead,
 * because the plugin would connect to the hosted one.
 */
import {
  MCP_SERVER_NAME,
  PLUGIN_ID,
  PLUGIN_MARKETPLACE,
  PLUGIN_MCP_SERVER,
} from '@gitstalk/shared-race/plugin';

/**
 * The MCP address in the plugin repository's `.mcp.json` (coop-collective/gitstalk-plugin). It must
 * stay equal to that file's literal URL; the plugin repository's CI checks its side.
 */
export const PLUGIN_MCP_URL = 'https://mcp.gitstalk.io/mcp';

export type AgentInstall = {
  readonly id: 'claude-code' | 'codex' | 'cursor' | 'gemini' | 'mcp';
  readonly name: string;
  /** Where the text goes. */
  readonly where: string;
  readonly code: string;
  /** What happens next, in a sentence or two. */
  readonly after: string;
  /** Whether this exact text was run end to end against Gitstalk. */
  readonly verified: boolean;
  /** What to ask the agent once it is connected (the repository's Code button sets one). */
  readonly prompt?: string;
};

/** One harness's install text, as /signup/agent prints it (the repository start page reuses it). */
export function agentInstall(mcpUrl: string, id: AgentInstall['id']): AgentInstall {
  const found = agentInstalls(mcpUrl).find((install) => install.id === id);
  if (found === undefined) throw new Error(`no install text for ${id}`);
  return found;
}

export function agentInstalls(mcpUrl: string): readonly AgentInstall[] {
  const hosted = mcpUrl === PLUGIN_MCP_URL;
  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      where: 'paste in your terminal',
      code: hosted
        ? `claude plugin marketplace add ${PLUGIN_MARKETPLACE} && claude plugin install ${PLUGIN_ID} && claude mcp login ${PLUGIN_MCP_SERVER}`
        : `claude mcp add --transport http ${MCP_SERVER_NAME} ${mcpUrl} && claude mcp login ${MCP_SERVER_NAME}`,
      after:
        'Your browser opens once: sign in (or create your account) and approve the session. Back in Claude Code the Gitstalk tools are ready. Already in a session? Type /mcp and pick gitstalk.',
      verified: true,
    },
    {
      id: 'codex',
      name: 'Codex',
      where: 'paste in your terminal',
      code: hosted
        ? `codex plugin marketplace add ${PLUGIN_MARKETPLACE} && codex plugin add ${PLUGIN_ID} && codex mcp login ${MCP_SERVER_NAME}`
        : `codex mcp add ${MCP_SERVER_NAME} --url ${mcpUrl} && codex mcp login ${MCP_SERVER_NAME}`,
      after:
        'The last step opens your browser: sign in and approve the session. Codex keeps running on your own plan; the session acts as you.',
      verified: true,
    },
    {
      id: 'cursor',
      name: 'Cursor',
      where: 'add to ~/.cursor/mcp.json, then run in your terminal',
      code: `{ "mcpServers": { "gitstalk": { "url": "${mcpUrl}" } } }\ncursor-agent mcp login gitstalk`,
      after: 'Or open Cursor Settings › MCP and click “Needs login” next to gitstalk.',
      verified: false,
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      where: 'paste in your terminal, then in Gemini',
      code: `gemini mcp add --transport http gitstalk ${mcpUrl}\n/mcp auth gitstalk`,
      after: 'The second line runs inside Gemini CLI and opens the browser sign-in.',
      verified: false,
    },
    {
      id: 'mcp',
      name: 'Other MCP client',
      where: 'add as a remote (HTTP) MCP server',
      code: mcpUrl,
      after:
        'The client’s first call opens the same browser sign-in; approve it and it is connected.',
      verified: false,
    },
  ];
}

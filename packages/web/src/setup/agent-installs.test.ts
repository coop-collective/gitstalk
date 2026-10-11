import { describe, expect, it } from 'vitest';

import { PLUGIN_MCP_URL, agentInstalls } from './agent-installs';

describe("the plugin's MCP server", () => {
  it('is the hosted address, literally, so the plugin repository can name it in .mcp.json', () => {
    // coop-collective/gitstalk-plugin's .mcp.json holds this URL with no auth header (clients use
    // OAuth); Codex does not expand ${VAR:-default} in a plugin's URL, so it is a literal.
    expect(PLUGIN_MCP_URL).toBe('https://mcp.gitstalk.io/mcp');
    expect(PLUGIN_MCP_URL).not.toContain('$');
  });
});

describe('the commands /signup/agent prints', () => {
  it('installs the plugin and signs in, for the hosted deployment', () => {
    const [claude, codex] = agentInstalls(PLUGIN_MCP_URL);
    expect(claude?.code).toBe(
      'claude plugin marketplace add coop-collective/gitstalk-plugin && claude plugin install gitstalk@gitstalk && claude mcp login plugin:gitstalk:gitstalk',
    );
    expect(codex?.code).toBe(
      'codex plugin marketplace add coop-collective/gitstalk-plugin && codex plugin add gitstalk@gitstalk && codex mcp login gitstalk',
    );
  });

  it('adds this deployment’s own MCP address anywhere else', () => {
    const staging = 'https://beanstalk-mcp-staging.example.workers.dev/mcp';
    const installs = agentInstalls(staging);
    expect(installs[0]?.code).toBe(
      `claude mcp add --transport http gitstalk ${staging} && claude mcp login gitstalk`,
    );
    expect(installs[1]?.code).toBe(
      `codex mcp add gitstalk --url ${staging} && codex mcp login gitstalk`,
    );
    expect(installs.every((install) => !install.code.includes(PLUGIN_MCP_URL))).toBe(true);
  });
});

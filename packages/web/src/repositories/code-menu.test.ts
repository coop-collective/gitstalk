import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { CodeAside } from '../../components/repo-tabs/code-browser';
import { CodeButton } from '../../components/repository/code-button';
import { PLUGIN_MCP_URL } from '../setup/agent-installs';
import {
  CODE_MENU_TABS,
  PLUGIN_REPOSITORY_URL,
  codeMenu,
  codeMenuTabOf,
  nextTabIndex,
} from './code-menu';
import type { StartConfig } from './paths';

// `next/link` resolves only inside vinext's build: the side column's links render as plain anchors.
vi.mock('../../components/shell/intent-link', () => ({
  IntentLink: (props: Record<string, unknown>) => createElement('a', props),
}));

const SELF_HOSTED: StartConfig = {
  gitOrigin: 'https://forge.example.test/',
  mcpUrl: 'https://mcp.forge.example.test/mcp',
  webOrigin: 'https://forge.example.test',
};
const REPO = { owner: 'coop', name: 'notes' };
const OPTIONS = { deployTokensPath: null, docsUrl: 'https://forge.example.test/docs/' };

function menuFor(config: StartConfig, deployTokensPath: string | null = null) {
  return codeMenu(config, REPO, { ...OPTIONS, deployTokensPath });
}

function render(config: StartConfig = SELF_HOSTED): string {
  return renderToStaticMarkup(
    createElement(CodeButton, { menu: menuFor(config), slug: 'coop/notes' }),
  );
}

describe('the Code button menu', () => {
  it('builds the clone URL and commands from the deployment’s git origin', () => {
    const menu = menuFor(SELF_HOSTED);
    expect(menu.httpsUrl).toBe('https://forge.example.test/coop/notes.git');
    expect(menu.cloneCommand).toBe('git clone https://forge.example.test/coop/notes.git');
    expect(menu.pushCommand).toBe('git push origin HEAD:bean/<name>');
    expect(menu.agentDocsUrl).toBe('https://forge.example.test/docs/agents');
    expect(menu.pluginUrl).toBe('https://github.com/coop-collective/gitstalk-plugin');
  });

  it('marks SSH as coming soon until the deployment has an SSH host', () => {
    expect(menuFor(SELF_HOSTED).ssh).toEqual({ kind: 'soon' });
    const live = menuFor({
      ...SELF_HOSTED,
      ssh: { host: 'ssh.forge.example.test', hostKeyFingerprint: 'SHA256:abc' },
    });
    expect(live.ssh).toEqual({
      kind: 'live',
      url: 'ssh://git@ssh.forge.example.test/coop/notes.git',
      hostKeyFingerprint: 'SHA256:abc',
    });
  });

  it('offers the deploy tokens page only to those who may make them', () => {
    expect(menuFor(SELF_HOSTED).deployTokensPath).toBeNull();
    expect(menuFor(SELF_HOSTED, '/coop/notes/settings/deploy-tokens').deployTokensPath).toBe(
      '/coop/notes/settings/deploy-tokens',
    );
  });

  it('connects every agent to this deployment’s MCP and setup script, never the hosted one', () => {
    const agents = menuFor(SELF_HOSTED).agents;
    expect(agents.map((agent) => agent.id)).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'gemini',
      'mcp',
    ]);
    for (const agent of agents) {
      expect(`${agent.code} ${agent.prompt ?? ''}`).not.toContain('gitstalk.io');
      expect(agent.prompt).toContain('https://forge.example.test/setup.sh');
      expect(agent.prompt).toContain('remote coop/notes');
    }
    expect(agents[0]?.code).toContain(
      'claude mcp add --transport http gitstalk https://mcp.forge.example.test/mcp',
    );
  });

  it('installs the plugin and runs its setup for this repository on the hosted service', () => {
    const claude = menuFor({ ...SELF_HOSTED, mcpUrl: PLUGIN_MCP_URL }).agents[0];
    expect(claude?.code).toBe(
      'claude plugin marketplace add coop-collective/gitstalk-plugin && claude plugin install gitstalk@gitstalk && claude "/gitstalk:setup coop/notes"',
    );
    expect(claude?.prompt).toContain('coop/notes');
  });

  it('moves between tabs with the arrow keys, Home and End, wrapping at either end', () => {
    expect(nextTabIndex('ArrowRight', 2, 3)).toBe(0);
    expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(nextTabIndex('Home', 2, 3)).toBe(0);
    expect(nextTabIndex('End', 0, 3)).toBe(2);
    expect(nextTabIndex('Enter', 0, 3)).toBeNull();
  });

  it('restores a remembered tab only when it still names one', () => {
    expect(codeMenuTabOf('agent')).toBe('agent');
    expect(codeMenuTabOf('env')).toBeNull();
    expect(codeMenuTabOf(null)).toBeNull();
  });
});

describe('the Code button', () => {
  it('is a disclosure that opens on the Clone tab without JavaScript', () => {
    const html = render();
    expect(html).toMatch(/^<details[^>]*><summary[^>]*>.*Code<\/summary>/);
    const clone = /<div role="tabpanel"[^>]*id="[^"]*-panel-clone"[^>]*>/.exec(html)?.[0];
    expect(clone).toBeDefined();
    expect(clone).not.toContain('hidden');
    expect(html).toContain('value="https://forge.example.test/coop/notes.git"');
    expect(html).toContain('git clone https://forge.example.test/coop/notes.git');
    expect(html).toContain('git push origin HEAD:bean/&lt;name&gt;');
  });

  it('follows the tabs pattern: one selected tab, each controlling its panel', () => {
    const html = render();
    const tabs = [
      ...html.matchAll(/<button[^>]*role="tab" id="[^"]*-tab-(?:clone|agent|intent)"[^>]*>/g),
    ].map((match) => match[0]);
    expect(tabs).toHaveLength(CODE_MENU_TABS.length);
    expect(tabs.filter((tab) => tab.includes('aria-selected="true"'))).toHaveLength(1);
    expect(tabs[0]).toContain('tabindex="0"');
    expect(tabs[1]).toContain('tabindex="-1"');
    for (const tab of tabs) expect(tab).toMatch(/aria-controls="[^"]+-panel-/);
  });

  it('shows SSH as disabled and coming soon, with copy buttons named and announced', () => {
    const html = render();
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*value="SSH: coming soon"/);
    expect(html).toContain('aria-label="Copy the HTTPS clone URL"');
    expect(html).toContain('aria-label="Copy the git clone command"');
    expect(html).toContain('role="status"');
  });

  it('marks Submit intent as soon, with its text box and button disabled', () => {
    const html = render();
    expect(html).toMatch(/role="tab"[^>]*>Submit intent<span[^>]*>Soon<\/span>/);
    expect(html).toContain('Gitstalk opens a bean with your intent for an agent to pick up.');
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html).toMatch(/<button type="button"[^>]*disabled=""[^>]*>Open a bean<\/button>/);
  });

  it('lists every agent harness and links the plugin and the docs', () => {
    const html = render();
    for (const name of ['Claude Code', 'Codex', 'Cursor', 'Gemini CLI', 'Other MCP client'])
      expect(html).toContain(`>${name}</button>`);
    expect(html).toContain(`href="${PLUGIN_REPOSITORY_URL}"`);
    expect(html).toContain('href="https://forge.example.test/docs/agents"');
  });
});

describe('the Code tab’s side column', () => {
  it('no longer holds the clone URL or the Connect git tabs', () => {
    const html = renderToStaticMarkup(
      createElement(CodeAside, {
        base: '/coop/notes',
        description: 'Notes',
        changes: [],
        onStalk: 3,
      }),
    );
    expect(html).toContain('About');
    expect(html).not.toContain('Clone');
    expect(html).not.toContain('Connect git');
    expect(html).not.toContain('.git');
  });
});

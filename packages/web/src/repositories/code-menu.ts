/**
 * What a repository's Code button offers (the popover beside the ref switcher, as on GitHub):
 * the Clone tab's addresses and commands, the Agent tab's per-harness lines for this
 * repository, and where tokens are made. Every address comes from the deployment's own vars
 * (`StartConfig`), never from a hard-coded host.
 */
import { PLUGIN_ID, PLUGIN_MARKETPLACE, SETUP_COMMAND } from '@gitstalk/shared-race/plugin';

import type { AgentInstall } from '../setup/agent-installs';
import { PLUGIN_MCP_URL, agentInstalls } from '../setup/agent-installs';
import type { StartConfig } from './paths';
import { sshCloneUrl } from './paths';

/** The plugin's public repository: the Agent tab's "Install plugin" link. */
export const PLUGIN_REPOSITORY_URL = `https://github.com/${PLUGIN_MARKETPLACE}`;

/** The panel's top-level tabs, in order. Submit intent is shown, marked soon, and does nothing. */
export const CODE_MENU_TABS = [
  { id: 'clone', label: 'Clone', soon: false },
  { id: 'agent', label: 'Agent', soon: false },
  { id: 'intent', label: 'Submit intent', soon: true },
] as const;
export type CodeMenuTab = (typeof CODE_MENU_TABS)[number]['id'];

/** Where the last opened tab is kept in this browser. */
export const CODE_MENU_STORAGE_KEY = 'gitstalk-code-tab';

/** SSH, live once the deployment has `SSH_HOST`; until then shown as coming soon. */
export type SshClone =
  | { readonly kind: 'live'; readonly url: string; readonly hostKeyFingerprint: string }
  | { readonly kind: 'soon' };

export type CodeMenu = {
  readonly httpsUrl: string;
  readonly cloneCommand: string;
  readonly ssh: SshClone;
  /** How a change goes back: a push to a bean branch. */
  readonly pushCommand: string;
  /** Where personal tokens (git's password prompt) are made. */
  readonly tokensPath: string;
  /** Settings → Deploy tokens, for those who may make them; null for everyone else. */
  readonly deployTokensPath: string | null;
  /** The Agent tab: one entry per harness, set up for this repository. */
  readonly agents: readonly AgentInstall[];
  readonly pluginUrl: string;
  /** This deployment's docs page on connecting agents. */
  readonly agentDocsUrl: string;
};

export function codeMenu(
  config: StartConfig,
  repository: { readonly owner: string; readonly name: string },
  options: { readonly deployTokensPath: string | null; readonly docsUrl: string },
): CodeMenu {
  const { owner, name } = repository;
  const httpsUrl = `${config.gitOrigin.replace(/\/+$/, '')}/${owner}/${name}.git`;
  return {
    httpsUrl,
    cloneCommand: `git clone ${httpsUrl}`,
    ssh:
      config.ssh === undefined
        ? { kind: 'soon' }
        : {
            kind: 'live',
            url: sshCloneUrl(config.ssh, owner, name),
            hostKeyFingerprint: config.ssh.hostKeyFingerprint,
          },
    pushCommand: 'git push origin HEAD:bean/<name>',
    tokensPath: '/settings/tokens',
    deployTokensPath: options.deployTokensPath,
    agents: repositoryAgentInstalls(config, `${owner}/${name}`),
    pluginUrl: PLUGIN_REPOSITORY_URL,
    agentDocsUrl: `${options.docsUrl.replace(/\/+$/, '')}/agents`,
  };
}

/**
 * The /signup/agent install text, turned towards one repository: Claude Code on the hosted
 * service installs the plugin and runs its setup for `slug`; every other harness (and Claude
 * Code on a deployment with its own MCP address) connects to this deployment's MCP server,
 * then is asked to set git up with this deployment's setup script.
 */
export function repositoryAgentInstalls(
  config: StartConfig,
  slug: string,
): readonly AgentInstall[] {
  const isHosted = config.mcpUrl === PLUGIN_MCP_URL;
  const setupPrompt = `Set up git for Gitstalk: run "curl -fsSL ${config.webOrigin.replace(/\/+$/, '')}/setup.sh | sh -s -- detect", ask me which SSH key to use, register it with the same script, then run its "remote ${slug}".`;
  return agentInstalls(config.mcpUrl).map((install) => {
    if (install.id === 'claude-code' && isHosted)
      return {
        ...install,
        code: `claude plugin marketplace add ${PLUGIN_MARKETPLACE} && claude plugin install ${PLUGIN_ID} && claude "${SETUP_COMMAND} ${slug}"`,
        after: `Installs the Gitstalk plugin and runs ${SETUP_COMMAND} ${slug}: Claude picks an SSH key (or makes one), your browser opens once to approve it, and git is ready for ${slug}.`,
        prompt: `Work on ${slug} on Gitstalk: make the change as a bean, and push it.`,
      };
    return { ...install, prompt: setupPrompt };
  });
}

/** The tab an arrow, Home or End key moves to among `count` tabs, wrapping; null otherwise. */
export function nextTabIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowRight':
      return (current + 1) % count;
    case 'ArrowLeft':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** A stored tab id, if it still names a tab. */
export function codeMenuTabOf(saved: string | null): CodeMenuTab | null {
  return CODE_MENU_TABS.find((tab) => tab.id === saved)?.id ?? null;
}

/**
 * The Code tab for one request: the engine's reads (`codeData`) plus what its Code button
 * offers (clone, connect an agent), from this deployment's addresses. Server-only.
 */
import { env } from 'cloudflare:workers';

import type { CodeData, CodeInput } from '../repo-pages/code-data';
import { codeData } from '../repo-pages/code-data';
import type { CodeMenu } from '../repositories/code-menu';
import { codeMenu } from '../repositories/code-menu';
import { repoSettingsPath } from '../settings/sections';
import { startConfig } from './repository-page';
import type { RepositoryTab } from './repository-tab';

export type CodePage = CodeData & { readonly menu: CodeMenu };

const UNREACHABLE: CodeData = {
  changes: [],
  sha: '',
  seq: 0,
  head: null,
  body: { kind: 'missing', what: 'This repository’s engine is not reachable.' },
  folders: [],
};

export async function codePage(tab: RepositoryTab, input: CodeInput): Promise<CodePage> {
  const { reads, record } = tab;
  const [config, data] = await Promise.all([
    startConfig(),
    reads === null ? Promise.resolve(UNREACHABLE) : codeData(reads, input),
  ]);
  const makesDeployTokens =
    (tab.role === 'owner' || tab.role === 'maintain') && record.archived_at === null;
  const menu = codeMenu(
    config,
    { owner: record.owner.handle, name: record.name },
    {
      deployTokensPath: makesDeployTokens ? repoSettingsPath(tab.base, 'deploy-tokens') : null,
      docsUrl: env.DOCS_URL,
    },
  );
  return { ...data, menu };
}

/**
 * The Code tab for one request: the engine's reads (`codeData`) plus how to clone and
 * connect (the start guide, and a deploy-token form for the owner). Server-only.
 */
import type { DeployTokenAccess } from '../../components/repository/connect-tabs';
import type { CodeData, CodeInput } from '../repo-pages/code-data';
import { codeData } from '../repo-pages/code-data';
import type { StartGuide } from '../repositories/paths';
import { startGuide } from '../repositories/paths';
import { requestSession, startConfig } from './repository-page';
import type { RepositoryTab } from './repository-tab';

export type CodePage = CodeData & {
  readonly guide: StartGuide;
  readonly deploy: DeployTokenAccess;
};

const UNREACHABLE: CodeData = {
  changes: [],
  sha: '',
  head: null,
  body: { kind: 'missing', what: 'This repository’s engine is not reachable.' },
};

export async function codePage(tab: RepositoryTab, input: CodeInput): Promise<CodePage> {
  const { reads, record } = tab;
  const [config, session, data] = await Promise.all([
    startConfig(),
    tab.role === 'owner' || tab.role === 'maintain' ? requestSession() : Promise.resolve(null),
    reads === null ? Promise.resolve(UNREACHABLE) : codeData(reads, input),
  ]);
  return {
    ...data,
    guide: startGuide(config, record.owner.handle, record.name),
    deploy:
      session === null ? null : { repoId: record.id, csrf: session.csrfToken, path: tab.base },
  };
}

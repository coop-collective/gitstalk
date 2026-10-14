import { env } from 'cloudflare:workers';

import { DeployTokens } from '../../../../../components/repository/deploy-tokens';
import { RepositorySettingsFrame } from '../../../../../components/repository/repository-settings-frame';
import { deployTokensClient } from '../../../../../src/repositories/deploy-tokens-client';
import type { RepositoryParams } from '../../../../../src/server/repository-page';
import {
  repositorySettings,
  settingsMetadata,
} from '../../../../../src/server/repository-settings';
import { repoSettingsPath } from '../../../../../src/settings/sections';

/** Per person and per request: never prerendered or cached. */
export const dynamic = 'force-dynamic';
export const generateMetadata = settingsMetadata('Deploy tokens');

/** Settings → Deploy tokens (maintainers and the owner): tokens for CI and scripts, one repo. */
export default async function DeployTokensSettingsPage(props: {
  readonly params: RepositoryParams;
}) {
  const settings = await repositorySettings(props.params, 'deploy-tokens');
  const { record, base, session, actor } = settings;
  const tokens = await deployTokensClient(env.GATEWAY).list(actor, record.id);
  return (
    <RepositorySettingsFrame
      settings={settings}
      current="deploy-tokens"
      title="Deploy tokens"
      lede="Git credentials for CI and scripts, scoped to this repository only."
    >
      <DeployTokens
        tokens={tokens.ok ? tokens.value : []}
        gitOrigin={env.GIT_ORIGIN}
        access={{
          repoId: record.id,
          csrf: session.csrfToken,
          path: repoSettingsPath(base, 'deploy-tokens'),
        }}
      />
    </RepositorySettingsFrame>
  );
}

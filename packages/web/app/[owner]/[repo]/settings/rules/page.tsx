import { env } from 'cloudflare:workers';

import { RepositorySettingsFrame } from '../../../../../components/repository/repository-settings-frame';
import styles from '../../../../../components/repository/repository.module.css';
import { RulesEditor } from '../../../../../components/rules/rules-editor';
import { SettingsSection } from '../../../../../components/settings/settings-shell';
import type { RulesClient } from '../../../../../src/rules/rules-client';
import { rulesClient } from '../../../../../src/rules/rules-client';
import type { RepositoryParams } from '../../../../../src/server/repository-page';
import {
  repositorySettings,
  settingsMetadata,
} from '../../../../../src/server/repository-settings';

/** Per person and per request: never prerendered or cached. */
export const dynamic = 'force-dynamic';
export const generateMetadata = settingsMetadata('Approval rules');

/**
 * Settings → Approval rules (everyone with a role reads; owners and maintainers save): the
 * repository's `.gitstalk/policy.yml` (docs/claude-opus/32-approval-rules.md), edited with the
 * engine's own validation and saved as a bean authored by the person, which lands on the stalk
 * like any change. The engine reads the rules from the stalk, never from the bean it judges.
 */
export default async function RulesSettingsPage(props: { readonly params: RepositoryParams }) {
  const settings = await repositorySettings(props.params, 'rules');
  const client = rulesClient(env.GATEWAY, settings.actor.id);
  const source = client === null ? null : await client.source(settings.record.id);
  const where =
    source?.ok === true ? `${source.value.path} at ${source.value.base.commit.slice(0, 7)}` : '';
  return (
    <RepositorySettingsFrame
      settings={settings}
      current="rules"
      title="Approval rules"
      lede="Which changes land on their own, which Clef triages, and which wait for a person. Classes are computed by code from each bean's paths and syntax."
    >
      <SettingsSection
        id="rules"
        title="Rules"
        aside={<span className={`${styles.muted} ${styles.mono}`}>{where}</span>}
      >
        <RulesBody settings={settings} source={source} />
      </SettingsSection>
    </RepositorySettingsFrame>
  );
}

function RulesBody(props: {
  readonly settings: Awaited<ReturnType<typeof repositorySettings>>;
  readonly source: Awaited<ReturnType<RulesClient['source']>> | null;
}) {
  const { settings, source } = props;
  if (source === null)
    return <p className={styles.empty}>The rules editor is not running on this deployment.</p>;
  if (!source.ok)
    return <p className={styles.empty}>The rules could not be read: {source.message}</p>;
  return (
    <RulesEditor
      repo={{
        owner: settings.record.owner.handle,
        name: settings.record.name,
        base: settings.base,
      }}
      csrf={settings.session.csrfToken}
      path={source.value.path}
      opened={{ base: source.value.base, text: source.value.content }}
      refusal={source.value.save.kind === 'allowed' ? null : source.value.save.reason}
    />
  );
}

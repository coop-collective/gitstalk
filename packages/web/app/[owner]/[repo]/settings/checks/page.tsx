import { env } from 'cloudflare:workers';

import { CHECKS_PATH, isTomlChecks } from '@gitstalk/shared-race/checks-config';
import { tomlChecksToYaml } from '@gitstalk/shared-race/checks-yaml';

import { ChecksSummary } from '../../../../../components/repository/checks-config';
import { ChecksConvert } from '../../../../../components/repository/checks-convert';
import { RepositorySettingsFrame } from '../../../../../components/repository/repository-settings-frame';
import styles from '../../../../../components/repository/repository.module.css';
import { SettingsSection } from '../../../../../components/settings/settings-shell';
import { registryClient } from '../../../../../src/repositories/registry-client';
import type { RepositoryParams } from '../../../../../src/server/repository-page';
import {
  repositorySettings,
  settingsMetadata,
} from '../../../../../src/server/repository-settings';

/** Per person and per request: never prerendered or cached. */
export const dynamic = 'force-dynamic';
export const generateMetadata = settingsMetadata('Checks');

/**
 * Settings → Checks (everyone with a role): the effective checks from the stalk's checks file
 * (`.gitstalk/checks.yml`, or an older one, `CHECKS_PATHS`), changed by a maintainer's bean. The
 * one write here: converting a `checks.toml` to the YAML that declares the same checks, a bean
 * by an owner or maintainer.
 */
export default async function ChecksSettingsPage(props: { readonly params: RepositoryParams }) {
  const settings = await repositorySettings(props.params, 'checks');
  const files = await registryClient(env.GATEWAY).files(settings.record.id, settings.actor.id);
  const checksPath = (files.ok ? files.value.checksPath : null) ?? CHECKS_PATH;
  return (
    <RepositorySettingsFrame
      settings={settings}
      current="checks"
      title="Checks"
      lede={`What must pass before a bean reaches the stalk. Change them with a bean that edits ${checksPath}.`}
    >
      <SettingsSection
        id="checks"
        title="What counts as green"
        aside={
          <span className={`${styles.muted} ${styles.mono}`}>
            {checksPath} on {files.ok ? files.value.ref : 'the stalk'}
          </span>
        }
      >
        {files.ok ? (
          <ChecksSummary file={files.value.checks} path={files.value.checksPath} />
        ) : (
          <p className={styles.empty}>The stalk could not be read: {files.error.message}</p>
        )}
      </SettingsSection>
      {files.ok && files.value.checks !== null && isTomlChecks(checksPath) ? (
        <ConvertSection settings={settings} from={checksPath} toml={files.value.checks} />
      ) : null}
    </RepositorySettingsFrame>
  );
}

/** The TOML's YAML equivalent, and the button that converts it for owners and maintainers. */
function ConvertSection(props: {
  readonly settings: Awaited<ReturnType<typeof repositorySettings>>;
  readonly from: string;
  readonly toml: string;
}) {
  const { settings } = props;
  const converted = tomlChecksToYaml(props.toml);
  return (
    <SettingsSection id="checks-yaml" title="Convert to YAML">
      {converted.ok ? (
        <ChecksConvert
          repo={{
            owner: settings.record.owner.handle,
            name: settings.record.name,
            base: settings.base,
          }}
          csrf={settings.session.csrfToken}
          from={props.from}
          yaml={converted.yaml}
          refusal={convertRefusal(settings)}
        />
      ) : (
        <p className={styles.muted}>
          {props.from} has no YAML equivalent yet: {converted.problems[0]}
        </p>
      )}
    </SettingsSection>
  );
}

function convertRefusal(settings: Awaited<ReturnType<typeof repositorySettings>>): string | null {
  if (settings.isArchived) return 'This repository is archived, so it is read-only.';
  return settings.maintains
    ? null
    : `Only maintainers and the owner change the checks; you have the ${settings.role} role.`;
}

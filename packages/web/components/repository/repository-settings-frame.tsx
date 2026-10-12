/**
 * The frame of every repository settings page: the repository's head and tabs, then the
 * settings shell with one nav link per section page this viewer may open (the current one
 * marked), a line for people who are not the owner, the archived notice, and the move from an
 * old one-page anchor to its page.
 */
import { IntentLink as Link } from '../shell/intent-link';
import type { ReactNode } from 'react';

import type { RepositorySettings } from '../../src/server/repository-settings';
import type { RepoSection } from '../../src/settings/sections';
import {
  REPO_ANCHORS,
  navGroups,
  repoSections,
  repoSettingsPath,
} from '../../src/settings/sections';
import { RepoHead } from '../home/repo-head';
import { LegacyAnchor } from '../settings/settings-client';
import { SettingsShell } from '../settings/settings-shell';
import shell from '../settings/settings-shell.module.css';
import styles from './repository.module.css';

export function RepositorySettingsFrame(props: {
  readonly settings: RepositorySettings;
  readonly current: RepoSection;
  readonly title: string;
  readonly lede?: ReactNode;
  readonly children: ReactNode;
}) {
  const { record, base, role, facts, isOwner, maintains, isArchived } = props.settings;
  const sections = repoSections(facts);
  const nav = navGroups(sections, (slug) => repoSettingsPath(base, slug), props.current);
  const who = (
    <div className={shell.who}>
      <span className={shell.whoText}>
        <span className={shell.whoName}>{record.name}</span>
        <span className={shell.whoSub}>
          {record.owner.handle}/{record.name} · {isArchived ? 'archived' : record.visibility}
        </span>
      </span>
    </div>
  );
  return (
    <>
      <RepoHead
        base={base}
        repository={{ owner: record.owner.handle, name: record.name }}
        current="settings"
        kind="repository"
        visibility={record.visibility}
        ownerHref={`/${record.owner.handle}`}
        archived={isArchived}
      />
      <LegacyAnchor
        anchors={REPO_ANCHORS}
        current={props.current}
        base={`${base}/settings`}
        allowed={sections.map((section) => section.slug)}
      />
      <SettingsShell
        who={who}
        nav={nav}
        title={props.title}
        {...(props.lede === undefined ? {} : { lede: props.lede })}
      >
        {isOwner ? null : (
          <p className={styles.notice}>
            You are <b>{role}</b> on {record.name}. Its name, visibility, people and deletion are{' '}
            <b>@{record.owner.handle}</b>&rsquo;s
            {record.owner_kind === 'org' ? ' (its owners and admins)' : ''}.{' '}
            {maintains && !isArchived ? 'As a maintainer you manage its deploy tokens. ' : null}
            <Link href={`${base}/people`}>See who has access</Link>.
          </p>
        )}
        {isArchived && isOwner && props.current !== 'danger' ? (
          <p className={styles.notice}>
            This repository is archived, so it is read-only and its name, description and visibility
            are fixed.{' '}
            <Link href={repoSettingsPath(base, 'danger')}>Unarchive it in the Danger zone</Link>.
          </p>
        ) : null}
        {props.children}
      </SettingsShell>
    </>
  );
}

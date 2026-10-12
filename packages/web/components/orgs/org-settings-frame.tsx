/**
 * The frame of every organization settings page: the org's mark and name with the viewer's
 * role, one nav link per section page this role may open (the current one marked), and the
 * move from an old one-page anchor (`#icon`) to its page.
 */
import { IntentLink as Link } from '../shell/intent-link';
import type { ReactNode } from 'react';

import type { OrgSettings } from '../../src/server/org-settings';
import type { OrgSection } from '../../src/settings/sections';
import { ORG_ANCHORS, navGroups, orgSections, orgSettingsPath } from '../../src/settings/sections';
import { LegacyAnchor } from '../settings/settings-client';
import { SettingsShell } from '../settings/settings-shell';
import shell from '../settings/settings-shell.module.css';
import { OrgMark } from './org-mark';

export function OrgSettingsFrame(props: {
  readonly settings: OrgSettings;
  readonly current: OrgSection;
  readonly title: string;
  readonly lede?: ReactNode;
  readonly children: ReactNode;
}) {
  const { org, role } = props.settings;
  const sections = orgSections(role);
  const nav = navGroups(sections, (slug) => orgSettingsPath(org.handle, slug), props.current);
  const who = (
    <Link href={`/${org.handle}`} className={shell.who}>
      <OrgMark handle={org.handle} iconKey={org.iconKey} size={40} />
      <span className={shell.whoText}>
        <span className={shell.whoName}>{org.name}</span>
        <span className={shell.whoSub}>
          {org.handle} · you are {role}
        </span>
      </span>
    </Link>
  );
  return (
    <>
      <LegacyAnchor
        anchors={ORG_ANCHORS}
        current={props.current}
        base={`/orgs/${encodeURIComponent(org.handle)}/settings`}
        allowed={sections.map((section) => section.slug)}
      />
      <SettingsShell
        who={who}
        nav={nav}
        title={props.title}
        {...(props.lede === undefined ? {} : { lede: props.lede })}
      >
        {props.children}
      </SettingsShell>
    </>
  );
}

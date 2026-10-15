/**
 * The settings pages of a repository and of an organization: one route per section, who sees
 * which, where `/settings` lands, and where the old one-page anchors (`#social`, `#secrets`)
 * go now. Pure, so the permission rules and the redirects are tested without rendering.
 */
import type { OrgRole } from '@gitstalk/shared-identity/orgs';

import type { ViewerRole } from '../repositories/registry-client';

export type RepoSection =
  | 'general'
  | 'social-image'
  | 'visibility'
  | 'branches'
  | 'checks'
  | 'rules'
  | 'actions'
  | 'collaborators'
  | 'secrets'
  | 'deploy-tokens'
  | 'danger';

/** What decides a repository's sections: the viewer's role and the repository's state. */
export type RepoSettingsFacts = {
  readonly role: ViewerRole;
  readonly isArchived: boolean;
  /** Actions run on this deployment (a control plane is configured). */
  readonly hasActions: boolean;
};

export type SectionLink<Slug extends string> = {
  readonly slug: Slug;
  readonly label: string;
  readonly group: string;
  readonly isDanger: boolean;
};

type RepoSectionRule = SectionLink<RepoSection> & {
  readonly isVisible: (facts: RepoSettingsFacts) => boolean;
};

const isOwner = (facts: RepoSettingsFacts) => facts.role === 'owner';
const canEdit = (facts: RepoSettingsFacts) => isOwner(facts) && !facts.isArchived;
const maintains = (facts: RepoSettingsFacts) => facts.role === 'owner' || facts.role === 'maintain';
const always = () => true;

const REPO_RULES: readonly RepoSectionRule[] = [
  rule('general', 'General', 'Repository', canEdit),
  rule('social-image', 'Social image', 'Repository', canEdit),
  rule('visibility', 'Visibility', 'Repository', canEdit),
  rule('branches', 'Branches', 'Code and automation', always),
  rule('checks', 'Checks', 'Code and automation', always),
  rule('rules', 'Approval rules', 'Code and automation', always),
  rule('actions', 'Actions', 'Code and automation', maintains),
  rule('collaborators', 'Collaborators', 'Access', isOwner),
  rule('secrets', 'Secrets and variables', 'Access', (facts) => facts.hasActions),
  rule(
    'deploy-tokens',
    'Deploy tokens',
    'Access',
    (facts) => maintains(facts) && !facts.isArchived,
  ),
  { ...rule('danger', 'Danger zone', 'Danger', isOwner), isDanger: true },
];

/** The sections this viewer may open, in nav order. */
export function repoSections(facts: RepoSettingsFacts): readonly SectionLink<RepoSection>[] {
  return REPO_RULES.filter((section) => section.isVisible(facts)).map(linkOf);
}

/** Where `/<owner>/<repo>/settings` lands: the first section this viewer may open. */
export function firstRepoSection(facts: RepoSettingsFacts): RepoSection {
  return repoSections(facts)[0]?.slug ?? 'branches';
}

export function isRepoSection(slug: string): slug is RepoSection {
  return REPO_RULES.some((section) => section.slug === slug);
}

/** `/<owner>/<repo>/settings/<section>` from the repository's base path. */
export function repoSettingsPath(base: string, section: RepoSection): string {
  return `${base}/settings/${section}`;
}

/** The anchors of the one-page repository settings (before 2026-10-10), by section. */
export const REPO_ANCHORS: Readonly<Record<string, RepoSection>> = {
  general: 'general',
  social: 'social-image',
  visibility: 'visibility',
  branches: 'branches',
  checks: 'checks',
  features: 'actions',
  collaborators: 'collaborators',
  actions: 'secrets',
  secrets: 'secrets',
  variables: 'secrets',
  'deploy-tokens': 'deploy-tokens',
  archive: 'danger',
  transfer: 'danger',
  danger: 'danger',
};

export type OrgSection =
  | 'general'
  | 'members'
  | 'repository-defaults'
  | 'secrets'
  | 'audit-log'
  | 'danger';

type OrgSectionRule = SectionLink<OrgSection> & {
  readonly isVisible: (role: OrgRole) => boolean;
};

const manages = (role: OrgRole) => role === 'owner' || role === 'admin';

const ORG_RULES: readonly OrgSectionRule[] = [
  orgRule('general', 'General', 'Organization', manages),
  orgRule('members', 'Members and invitations', 'Organization', manages),
  orgRule('repository-defaults', 'Repository defaults', 'Organization', manages),
  orgRule('secrets', 'Secrets and variables', 'Actions', always),
  orgRule('audit-log', 'Audit log', 'Records', manages),
  { ...orgRule('danger', 'Danger zone', 'Danger', always), isDanger: true },
];

/** The sections a member with `role` may open (owners and admins manage; everyone may leave). */
export function orgSections(role: OrgRole): readonly SectionLink<OrgSection>[] {
  return ORG_RULES.filter((section) => section.isVisible(role)).map(linkOf);
}

export function firstOrgSection(role: OrgRole): OrgSection {
  return orgSections(role)[0]?.slug ?? 'secrets';
}

export function isOrgSection(slug: string): slug is OrgSection {
  return ORG_RULES.some((section) => section.slug === slug);
}

export function orgSettingsPath(handle: string, section: OrgSection): string {
  return `/orgs/${encodeURIComponent(handle)}/settings/${section}`;
}

/** The anchors and section names of the one-page org settings, by section. */
export const ORG_ANCHORS: Readonly<Record<string, OrgSection>> = {
  general: 'general',
  icon: 'general',
  members: 'members',
  invitations: 'members',
  defaults: 'repository-defaults',
  'repository-defaults': 'repository-defaults',
  secrets: 'secrets',
  audit: 'audit-log',
  'audit-log': 'audit-log',
  leave: 'danger',
  delete: 'danger',
  danger: 'danger',
};

/**
 * The section an old anchor belongs on, when that is not the page it was opened on (so the
 * browser should move); null when the anchor is unknown or already here.
 */
export function anchorTarget<Slug extends string>(
  anchors: Readonly<Record<string, Slug>>,
  hash: string,
  current: Slug,
): Slug | null {
  const name = hash.replace(/^#/, '');
  if (!Object.hasOwn(anchors, name)) return null;
  const target = anchors[name];
  return target === undefined || target === current ? null : target;
}

export type NavGroup = {
  readonly title: string;
  readonly items: readonly {
    readonly href: string;
    readonly label: string;
    readonly isCurrent: boolean;
    readonly isDanger: boolean;
  }[];
};

/**
 * The left nav: sections grouped under their titles in order, the current one marked (none
 * for a layout's nav, which marks the current section from the address).
 */
export function navGroups<Slug extends string>(
  sections: readonly SectionLink<Slug>[],
  hrefOf: (slug: Slug) => string,
  current: Slug | null,
): readonly NavGroup[] {
  const titles = [...new Set(sections.map((section) => section.group))];
  return titles.map((title) => ({
    title,
    items: sections
      .filter((section) => section.group === title)
      .map((section) => ({
        href: hrefOf(section.slug),
        label: section.label,
        isCurrent: section.slug === current,
        isDanger: section.isDanger,
      })),
  }));
}

function rule(
  slug: RepoSection,
  label: string,
  group: string,
  isVisible: (facts: RepoSettingsFacts) => boolean,
): RepoSectionRule {
  return { slug, label, group, isDanger: false, isVisible };
}

function orgRule(
  slug: OrgSection,
  label: string,
  group: string,
  isVisible: (role: OrgRole) => boolean,
): OrgSectionRule {
  return { slug, label, group, isDanger: false, isVisible };
}

function linkOf<Slug extends string>(section: SectionLink<Slug>): SectionLink<Slug> {
  return {
    slug: section.slug,
    label: section.label,
    group: section.group,
    isDanger: section.isDanger,
  };
}

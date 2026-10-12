/**
 * The start of every `/<owner>/<repo>/settings/<section>` page: the repository (404 for people
 * with no role, the same as a missing one), the signed-in session, the facts that decide the
 * sections, and the Actions client when Actions run here. A section this viewer may not open
 * sends them to the first one they may. Server-only.
 */
import { notFound, redirect } from 'next/navigation';

import type { WebSession } from '@gitstalk/shared-identity/sessions';

import { currentSession } from '../auth/user';
import type { RepositoryRecord, ViewerRole } from '../repositories/registry-client';
import type { RepoSection, RepoSettingsFacts } from '../settings/sections';
import { firstRepoSection, repoSections, repoSettingsPath } from '../settings/sections';
import type { ActionsSession } from './actions-source';
import { actionsSession } from './actions-source';
import type { RepositoryPage, RepositoryParams } from './repository-page';
import { repositoryPage } from './repository-page';

export type RepositorySettings = {
  readonly record: RepositoryRecord;
  readonly base: string;
  readonly role: ViewerRole;
  readonly session: WebSession;
  readonly actor: { readonly id: string; readonly handle: string };
  readonly facts: RepoSettingsFacts;
  readonly actions: ActionsSession | null;
  readonly isOwner: boolean;
  /** Owner or maintainer. */
  readonly maintains: boolean;
  readonly isArchived: boolean;
};

/** A settings page's `generateMetadata`: "<Section> · <owner>/<repo> settings". */
export function settingsMetadata(label: string) {
  return async ({ params }: { readonly params: RepositoryParams }) => {
    const { owner, repo } = await params;
    return {
      title: `${label} · ${decodeURIComponent(owner)}/${decodeURIComponent(repo)} settings`,
    };
  };
}

export type SettingsQuery = Promise<Readonly<Record<string, string | string[] | undefined>>>;

/** Who may open a repository's settings: a signed-in person with a role on it. */
export type SettingsAccess = RepositoryPage & {
  readonly role: ViewerRole;
  readonly session: WebSession;
};

/**
 * The repository at `params` if the viewer may open its settings, else a 404 (the same as a
 * missing repository). `app/[owner]/[repo]/settings/layout.tsx` asks before anything streams;
 * the session and the repository are memoised per request, so the pages' own ask is free.
 */
export async function settingsAccess(params: RepositoryParams): Promise<SettingsAccess> {
  const [page, session] = await Promise.all([repositoryPage(params), currentSession()]);
  const { role } = page;
  if (role === null || session === null) notFound();
  return { ...page, role, session };
}

export async function repositorySettings(
  params: RepositoryParams,
  section: RepoSection | 'landing',
): Promise<RepositorySettings> {
  const { record, base, role, session } = await settingsAccess(params);
  const actor = { id: session.user.id, handle: session.user.handle };
  const actions = await actionsSession({ actor, repoId: record.id });
  const isArchived = record.archived_at !== null;
  const facts: RepoSettingsFacts = { role, isArchived, hasActions: actions !== null };
  const allowed = repoSections(facts).some((link) => link.slug === section);
  if (!allowed) redirect(repoSettingsPath(base, firstRepoSection(facts)));
  return {
    record,
    base,
    role,
    session,
    actor,
    facts,
    actions,
    isOwner: role === 'owner',
    maintains: role === 'owner' || role === 'maintain',
    isArchived,
  };
}

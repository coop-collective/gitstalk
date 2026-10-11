import { env } from 'cloudflare:workers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { ownerByHandle } from '@gitstalk/shared-identity/orgs';
import { mayCreateRepository, mayInOrg } from '@gitstalk/shared-identity/orgs';
import { getProfile, resolveRetiredHandle } from '@gitstalk/shared-identity/profiles';

import { Avatar } from '../../components/account/avatar';

import { OrgMark } from '../../components/orgs/org-mark';
import orgStyles from '../../components/orgs/orgs.module.css';
import styles from '../../components/repository/repository.module.css';
import { currentUser } from '../../src/auth/user';
import type { OrgPage } from '../../src/orgs/org-page';
import { orgPage } from '../../src/orgs/org-page';
import { isReservedOwner, repositoryPath } from '../../src/repositories/paths';
import type { RepositoryRecord } from '../../src/repositories/registry-client';
import { registryClient } from '../../src/repositories/registry-client';

type PageProps = { readonly params: Promise<{ readonly owner: string }> };

export async function generateMetadata({ params }: PageProps) {
  return { title: decodeURIComponent((await params).owner) };
}

/**
 * A person's or an org's page: the repositories the viewer may read (the gateway decides),
 * archived ones for those who administer them, and for an org its members and, for its
 * owners and admins, Settings.
 */
export default async function OwnerPage({ params }: PageProps) {
  const handle = decodeURIComponent((await params).owner);
  if (isReservedOwner(handle)) notFound();
  const [owner, user] = await Promise.all([ownerByHandle(env, handle), currentUser()]);
  if (owner === null) {
    // A handle its person retired keeps pointing at them (docs/claude-opus/29-settings.md).
    const moved = await resolveRetiredHandle(env, handle);
    if (moved !== null) redirect(`/${encodeURIComponent(moved)}`);
    notFound();
  }
  const viewer = user?.id ?? null;
  const registry = registryClient(env.GATEWAY);
  // The profile is a person's only; an org's page never reads it.
  const [listed, archivedList, profile] = await Promise.all([
    registry.list(owner.id, viewer),
    registry.list(owner.id, viewer, 'archived'),
    owner.kind === 'org' ? null : getProfile(env, owner.id),
  ]);
  const records = listed.ok ? listed.value : [];
  const archived = archivedList.ok ? archivedList.value : [];
  if (owner.kind === 'org') {
    const page = await orgPage(owner.handle, viewer);
    if (page === null) notFound();
    return <OrgView page={page} records={records} archived={archived} />;
  }
  const isSelf = user !== null && user.id === owner.id;
  const name = profile === null || profile.displayName === '' ? owner.handle : profile.displayName;
  return (
    <main className={`${styles.page} ${styles.narrow}`}>
      <div className={styles.profileHead}>
        <Avatar seed={owner.id} label={name} imageKey={profile?.avatarKey ?? null} size={88} />
        <div className={styles.profileText}>
          <h1 className={styles.lead}>{name}</h1>
          <p className={`${styles.muted} ${styles.mono}`}>@{owner.handle}</p>
          {profile === null || profile.bio === '' ? null : (
            <p className={styles.profileBio}>{profile.bio}</p>
          )}
          {profile === null || profile.website === '' ? null : (
            <a href={profile.website} rel="nofollow noopener ugc" className={styles.profileLink}>
              {profile.website.replace(/^https?:\/\//, '')}
            </a>
          )}
        </div>
        {isSelf ? (
          <div className={styles.profileActions}>
            <Link href="/settings" className={styles.secondary}>
              Edit profile
            </Link>
            <Link href="/new" className={styles.primary}>
              New repository
            </Link>
          </div>
        ) : null}
      </div>
      <Repositories records={records} empty="No repositories you can see yet." />
      {isSelf ? <Archived records={archived} /> : null}
    </main>
  );
}

function OrgView(props: {
  readonly page: OrgPage;
  readonly records: readonly RepositoryRecord[];
  readonly archived: readonly RepositoryRecord[];
}) {
  const { org, role, members } = props.page;
  const mayCreate = mayCreateRepository(role, org.repoCreation);
  const manages = mayInOrg(role, 'settings');
  return (
    <main className={`${styles.page}`}>
      <header className={orgStyles.head}>
        <OrgMark handle={org.handle} iconKey={org.iconKey} size={56} />
        <div className={orgStyles.headText}>
          <h1>{org.name}</h1>
          <span className={orgStyles.handle}>{org.handle}</span>
          {org.description === '' ? null : <p>{org.description}</p>}
        </div>
        <div className={orgStyles.headActions}>
          {mayCreate ? (
            <Link href={`/new?owner=${encodeURIComponent(org.handle)}`} className={styles.primary}>
              New repository
            </Link>
          ) : null}
          {role === null ? null : (
            <Link href={`/orgs/${org.handle}/settings`} className={styles.secondary}>
              {manages ? 'Settings' : 'Leave or view settings'}
            </Link>
          )}
        </div>
      </header>
      <div className={orgStyles.columns}>
        <div>
          <Repositories
            records={props.records}
            empty={
              mayCreate
                ? 'No repositories yet. Create the first one, or transfer one in from its Settings.'
                : 'No repositories you can see yet.'
            }
          />
          {manages ? <Archived records={props.archived} /> : null}
        </div>
        {members.length === 0 ? null : <Roster members={members} />}
      </div>
    </main>
  );
}

const ROLE_GROUPS = [
  ['owner', 'Owners'],
  ['admin', 'Admins'],
  ['member', 'Members'],
  ['viewer', 'Viewers'],
] as const;

function Roster(props: { readonly members: OrgPage['members'] }) {
  return (
    <section className={styles.panel} aria-labelledby="people-title">
      <div className={styles.panelHead}>
        <h2 id="people-title">People</h2>
        <span className={styles.muted}>{props.members.length}</span>
      </div>
      <dl className={orgStyles.roster}>
        {ROLE_GROUPS.map(([role, title]) => {
          const group = props.members.filter((member) => member.role === role);
          if (group.length === 0) return null;
          return (
            <div key={role}>
              <dt>{title}</dt>
              <dd>
                {group.map((member) => (
                  <Link key={member.userId} href={`/${member.handle}`} className={orgStyles.person}>
                    @{member.handle}
                  </Link>
                ))}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function Repositories(props: {
  readonly records: readonly RepositoryRecord[];
  readonly empty: string;
}) {
  return (
    <section id="repositories" className={styles.panel} aria-label="Repositories">
      {props.records.length === 0 ? (
        <p className={styles.empty}>{props.empty}</p>
      ) : (
        <RepositoryList records={props.records} />
      )}
    </section>
  );
}

function Archived(props: { readonly records: readonly RepositoryRecord[] }) {
  if (props.records.length === 0) return null;
  return (
    <section className={styles.panel} aria-labelledby="archived-title">
      <div className={styles.panelHead}>
        <h2 id="archived-title">Archived</h2>
        <span className={styles.muted}>{props.records.length}</span>
      </div>
      <p className={styles.sub}>Read-only. Unarchive one from its Settings.</p>
      <RepositoryList records={props.records} />
    </section>
  );
}

function RepositoryList({ records }: { readonly records: readonly RepositoryRecord[] }) {
  return (
    <ul className={styles.repoList}>
      {records.map((record) => (
        <li key={record.id} className={styles.repoRow}>
          <span />
          <div>
            <Link
              href={repositoryPath(record.owner.handle, record.name)}
              className={styles.repoName}
            >
              {record.name}
            </Link>
            {record.description === '' ? null : (
              <p className={styles.repoDescription}>{record.description}</p>
            )}
          </div>
          <span className={styles.pill}>
            {record.archived_at === null ? record.visibility : 'archived'}
          </span>
        </li>
      ))}
    </ul>
  );
}

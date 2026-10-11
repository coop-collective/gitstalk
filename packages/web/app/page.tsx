import { env } from 'cloudflare:workers';
import { redirect } from 'next/navigation';

import { HomeDashboard } from '../components/repository/home-dashboard';
import { Invitations } from '../components/repository/invitations';
import { OrgInvitations } from '../components/orgs/org-people';
import { YourOrgs } from '../components/orgs/your-orgs';
import { connectedSessions } from '../src/auth/connected-sessions';
import { orgInvitationsFor } from '@gitstalk/shared-identity/org-members';
import { orgsOf } from '@gitstalk/shared-identity/orgs';

import { currentSession } from '../src/auth/user';
import { loadHomeGrowth } from '../src/home/home-growth';
import { collaboratorsClient } from '../src/repositories/collaborators-client';
import { growthOf } from '../src/repositories/engine-summary';
import { readEngineFeeds } from '../src/repositories/home-activity';
import { indexClient } from '../src/repositories/index-client';
import { registryClient } from '../src/repositories/registry-client';

type PageProps = {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
};

/**
 * Signed in: Home (first steps, your repositories, your sessions, recent activity). Signed out,
 * where the site is not served on this origin (it answers `/` itself otherwise): sign in.
 *
 * Everything that needs only the person is read at once. The repository list renders from that;
 * growth, activity and the sessions (an MCP call) are promises the page does not await, so
 * their panels stream in behind `<Suspense>` (see `HomeDashboard`).
 */
export default async function Home({ searchParams }: PageProps) {
  const session = await currentSession();
  if (session === null) redirect('/login');
  const { user } = session;
  const registry = registryClient(env.GATEWAY);
  const collaborators = collaboratorsClient(env.GATEWAY);
  const sessions = connectedSessions(user.id);
  const [orgs, orgInvitations, listed, archived, activity, invitations, shared, query] =
    await Promise.all([
      orgsOf(env, user.id),
      orgInvitationsFor(env, user.id, Date.now()),
      registry.list(user.id, user.id),
      registry.list(user.id, user.id, 'archived'),
      registry.activity(user.id, 40),
      collaborators.invitations(user.id),
      collaborators.shared(user.id),
      searchParams,
    ]);
  // Archived repositories leave the default lists (the owner finds them on their page).
  const own = listed.ok ? listed.value : [];
  const others = (shared.ok ? shared.value : []).filter((record) => record.archived_at === null);
  const growth = loadHomeGrowth(
    { records: [...own, ...others], registryActivity: activity.ok ? activity.value : [] },
    {
      indexGrowth: async (repoIds) => {
        const indexed = await indexClient(env.GATEWAY).growth(repoIds, user.id);
        return indexed.ok ? indexed.value : [];
      },
      engineFeeds: (engineIds) => readEngineFeeds(env.GATEWAY, engineIds),
      engineView: (engineId) => growthOf(env.GATEWAY, engineId),
    },
  );
  const notice = noticeOf(listed.ok ? null : listed.error.message, {
    deleted: stringParam(query['deleted']),
    left: stringParam(query['left']),
  });
  return (
    <HomeDashboard
      user={user}
      repositories={own}
      shared={others}
      invitations={
        <>
          <OrgInvitations invitations={orgInvitations} csrf={session.csrfToken} />
          <Invitations
            invitations={invitations.ok ? invitations.value : []}
            csrf={session.csrfToken}
          />
          <YourOrgs memberships={orgs} />
        </>
      }
      growth={growth}
      sessions={sessions}
      archivedCount={archived.ok ? archived.value.length : 0}
      nowMs={Date.now()}
      notice={notice}
    />
  );
}

function noticeOf(
  listError: string | null,
  done: { readonly deleted: string | null; readonly left: string | null },
): { readonly tone: 'good' | 'warn'; readonly text: string } | null {
  if (listError !== null)
    return { tone: 'warn', text: `Your repositories could not be listed: ${listError}` };
  if (done.left !== null) return { tone: 'good', text: `You left ${done.left}.` };
  return done.deleted === null ? null : { tone: 'good', text: `Deleted ${done.deleted}.` };
}

function stringParam(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

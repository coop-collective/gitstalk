/**
 * Home after sign-in (`docs/claude-opus/16` §2.3 and item 1.6): your repositories with what
 * each has grown, your agent sessions, recent activity and New repository. Until the first bean, a checklist: connect a session, create or import a
 * repository, push a bean.
 *
 * The shell and the repository names render from what the registry answered. What needs more
 * calls streams in behind `<Suspense>` with placeholders of the final size: growth (lead,
 * per-repository line, checklist, activity) and the connected sessions (an MCP Worker call).
 */
import { IntentLink as Link } from '../shell/intent-link';
import type { ReactNode } from 'react';
import { Suspense } from 'react';

import type { AgentSession } from '@gitstalk/shared-identity/agent-sessions';

import type { User as SessionUser } from '../../src/auth/user';
import type { HomeGrowth } from '../../src/home/home-growth';
import { repositoryPath } from '../../src/repositories/paths';
import type { RepositoryRecord } from '../../src/repositories/registry-client';
import {
  ActivityFallback,
  ActivityList,
  FirstStepsFallback,
  HomeFirstSteps,
  HomeLead,
  HomeLeadFallback,
  HomeSessionsPanel,
  RepoMeta,
  RepoMetaFallback,
  RepoSprig,
  SessionsPanelFallback,
  Sprig,
  leadOf,
} from './home-panels';
import styles from './repository.module.css';

export function HomeDashboard(props: {
  readonly user: SessionUser;
  readonly repositories: readonly RepositoryRecord[];
  /** Growth figures and recent activity, read while the shell streams (never rejects). */
  readonly growth: Promise<HomeGrowth>;
  /** Connected agent sessions (null: the MCP Worker did not answer); never rejects. */
  readonly sessions: Promise<readonly AgentSession[] | null>;
  /** Repositories others invited this person to (accepted). */
  readonly shared?: readonly RepositoryRecord[];
  /** Invitations waiting for an answer (rendered by the page: they are forms). */
  readonly invitations?: ReactNode;
  readonly nowMs: number;
  /** A sentence when something just happened (a deletion), or a registry problem. */
  readonly notice: { readonly tone: 'good' | 'warn'; readonly text: string } | null;
  /** The person's archived repositories, listed on their own page rather than here. */
  readonly archivedCount?: number;
}) {
  const archivedCount = props.archivedCount ?? 0;
  const shared = props.shared ?? [];
  const lead = { user: props.user, repositories: props.repositories, archivedCount };
  return (
    <main className={styles.page}>
      {props.notice === null ? null : (
        <p
          className={`${styles.notice} ${props.notice.tone === 'good' ? styles.noticeGood : ''}`}
          role="status"
        >
          {props.notice.text}
        </p>
      )}
      <div className={styles.homeHead}>
        <div>
          {props.repositories.length === 0 ? (
            <h1 className={styles.lead}>{leadOf(lead, 0)}</h1>
          ) : (
            <Suspense fallback={<HomeLeadFallback />}>
              <HomeLead {...lead} growth={props.growth} />
            </Suspense>
          )}
          <p className={styles.sub}>
            Agents and people push beans; Gitstalk checks each one on the exact tree it would land
            on and grows the stalk.
          </p>
        </div>
        <Link href="/new" className={styles.primary}>
          New repository
        </Link>
      </div>
      {props.invitations}
      <div className={styles.homeGrid}>
        <div className={styles.homeColumn}>
          <Suspense fallback={props.repositories.length === 0 ? <FirstStepsFallback /> : null}>
            <HomeFirstSteps
              userId={props.user.id}
              sessions={props.sessions}
              growth={props.growth}
              repositories={props.repositories.length + archivedCount}
            />
          </Suspense>
          <section className={styles.panel} aria-labelledby="repos-title">
            <div className={styles.panelHead}>
              <h2 id="repos-title">Your repositories</h2>
              <span className={styles.muted}>
                {props.repositories.length || ''}
                {archivedCount === 0 ? null : (
                  <>
                    {' '}
                    <Link href={`/${props.user.handle}`}>{archivedCount} archived</Link>
                  </>
                )}
              </span>
            </div>
            {props.repositories.length === 0 && archivedCount > 0 ? (
              <p className={styles.empty}>
                Every repository of yours is archived.{' '}
                <Link href={`/${props.user.handle}`}>Your page lists them</Link>; unarchive one from
                its Settings, or start a new one.
              </p>
            ) : null}
            <RepoList records={props.repositories} growth={props.growth} nowMs={props.nowMs} />
          </section>
          {shared.length === 0 ? null : (
            <section className={styles.panel} aria-labelledby="shared-title">
              <div className={styles.panelHead}>
                <h2 id="shared-title">Shared with you</h2>
                <span className={styles.muted}>{shared.length}</span>
              </div>
              <RepoList records={shared} growth={props.growth} nowMs={props.nowMs} />
            </section>
          )}
        </div>
        <div className={styles.homeColumn}>
          <Suspense fallback={<SessionsPanelFallback />}>
            <HomeSessionsPanel userId={props.user.id} sessions={props.sessions} />
          </Suspense>
          <section className={styles.panel} aria-labelledby="activity-title">
            <div className={styles.panelHead}>
              <h2 id="activity-title">Recent activity</h2>
            </div>
            <Suspense fallback={<ActivityFallback />}>
              <ActivityList growth={props.growth} nowMs={props.nowMs} />
            </Suspense>
          </section>
        </div>
      </div>
    </main>
  );
}

function RepoList(props: {
  readonly records: readonly RepositoryRecord[];
  readonly growth: Promise<HomeGrowth>;
  readonly nowMs: number;
}) {
  return (
    <ul className={styles.repoList}>
      {props.records.map((record) => (
        <li key={record.id} className={styles.repoRow}>
          <Suspense fallback={<Sprig grown={false} />}>
            <RepoSprig growth={props.growth} repoId={record.id} />
          </Suspense>
          <div>
            <Link
              href={repositoryPath(record.owner.handle, record.name)}
              className={styles.repoName}
            >
              {record.owner.handle}/{record.name}
            </Link>
            {record.description === '' ? null : (
              <p className={styles.repoDescription}>{record.description}</p>
            )}
            <Suspense fallback={<RepoMetaFallback record={record} nowMs={props.nowMs} />}>
              <RepoMeta growth={props.growth} record={record} nowMs={props.nowMs} />
            </Suspense>
          </div>
          <span className={styles.pill}>{record.visibility}</span>
        </li>
      ))}
    </ul>
  );
}

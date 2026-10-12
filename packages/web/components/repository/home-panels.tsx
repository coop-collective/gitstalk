/**
 * Home's streamed pieces: server components that wait for a promise the page started (growth
 * from the index and engines, or the connected sessions from the MCP Worker) so the page's
 * shell and repository list can reach the browser first. Each is used inside a `<Suspense>`
 * whose fallback has the loaded piece's layout.
 */
import { IntentLink as Link } from '../shell/intent-link';

import type { AgentSession } from '@gitstalk/shared-identity/agent-sessions';

import type { HomeGrowth } from '../../src/home/home-growth';
import type { User as SessionUser } from '../../src/auth/user';
import type { Growth } from '../../src/repositories/engine-summary';
import { growthText } from '../../src/repositories/engine-summary';
import { repositoryPath } from '../../src/repositories/paths';
import type { RepositoryRecord } from '../../src/repositories/registry-client';
import { timeAgo } from '../../src/repositories/when';
import { FirstSteps, SessionsPanel } from './home-sessions';
import skeleton from './home-skeleton.module.css';
import styles from './repository.module.css';

/** A pulsing placeholder for text; `width` is a CSS length. */
export function Bar({ width }: { readonly width?: string }) {
  return (
    <span
      className={skeleton.bar}
      style={width === undefined ? undefined : { width }}
      aria-hidden="true"
    />
  );
}

/** The stalk mark: a stem and a leaf, lit once something has grown. */
export function Sprig({ grown }: { readonly grown: boolean }) {
  return (
    <svg className={styles.sprig} viewBox="0 0 14 22" aria-hidden="true">
      <path d="M7 21V5" stroke="currentColor" strokeWidth="2" opacity={grown ? 1 : 0.45} />
      <path d="M7 10c0-3 2-5 6-5 0 3-2 5-6 5Z" fill="currentColor" opacity={grown ? 1 : 0.45} />
      <ellipse cx="7" cy="21" rx="4" ry="1.5" fill="currentColor" opacity="0.35" />
    </svg>
  );
}

async function growthOfRepo(growth: Promise<HomeGrowth>, repoId: string): Promise<Growth> {
  return (await growth).byRepo.get(repoId) ?? { kind: 'unknown' };
}

export async function RepoSprig(props: {
  readonly growth: Promise<HomeGrowth>;
  readonly repoId: string;
}) {
  return <Sprig grown={(await growthOfRepo(props.growth, props.repoId)).kind === 'grown'} />;
}

/** A repository's meta line: what it has grown, then when it was created. */
export async function RepoMeta(props: {
  readonly growth: Promise<HomeGrowth>;
  readonly record: RepositoryRecord;
  readonly nowMs: number;
}) {
  const growth = await growthOfRepo(props.growth, props.record.id);
  const created = `Created ${timeAgo(props.record.created_at, props.nowMs)}.`;
  const grown = growth.kind === 'unknown' ? '— · ' : `${growthText(growth)}. `;
  return (
    <p className={styles.repoMeta}>
      {grown}
      {created}
    </p>
  );
}

export function RepoMetaFallback(props: {
  readonly record: RepositoryRecord;
  readonly nowMs: number;
}) {
  return (
    <p className={styles.repoMeta}>
      <Bar width="14ch" /> Created {timeAgo(props.record.created_at, props.nowMs)}.
    </p>
  );
}

/** The headline, which counts the repositories that are growing. */
export async function HomeLead(props: {
  readonly user: SessionUser;
  readonly repositories: readonly RepositoryRecord[];
  readonly archivedCount: number;
  readonly growth: Promise<HomeGrowth>;
}) {
  const { byRepo } = await props.growth;
  const growing = props.repositories.filter((record) => {
    const growth = byRepo.get(record.id);
    return growth?.kind === 'grown' && growth.growing > 0;
  }).length;
  return <h1 className={styles.lead}>{leadOf(props, growing)}</h1>;
}

export function HomeLeadFallback() {
  return (
    <h1 className={styles.lead}>
      <Bar width="22em" />
    </h1>
  );
}

/** The headline when it needs no growth (no repositories listed). */
export function leadOf(
  input: {
    readonly user: SessionUser;
    readonly repositories: readonly RepositoryRecord[];
    readonly archivedCount: number;
  },
  growing: number,
): string {
  const { user, repositories } = input;
  if (repositories.length === 0 && input.archivedCount > 0)
    return `Welcome back, ${user.handle}. Your repositories are archived.`;
  if (repositories.length === 0) return `Welcome, ${user.handle}. Start your first repository.`;
  if (growing > 0)
    return `${growing === 1 ? 'One repository is' : `${growing} repositories are`} growing right now.`;
  return `${repositories.length === 1 ? 'Your repository is' : `All ${repositories.length} repositories are`} quiet. Push a bean to grow one.`;
}

/** The checklist: needs the sessions (connect) and the growth (first bean). */
export async function HomeFirstSteps(props: {
  readonly userId: string;
  readonly sessions: Promise<readonly AgentSession[] | null>;
  readonly growth: Promise<HomeGrowth>;
  readonly repositories: number;
}) {
  const [sessions, { byRepo }] = await Promise.all([props.sessions, props.growth]);
  const withBeans = [...byRepo.values()].filter((growth) => growth.kind === 'grown').length;
  return (
    <FirstSteps
      seed={{ userId: props.userId, sessions, readAtMs: Date.now() }}
      repositories={props.repositories}
      repositoriesWithBeans={withBeans}
    />
  );
}

export function FirstStepsFallback() {
  return (
    <section className={styles.panel} aria-label="Get started">
      <div className={styles.panelHead}>
        <h2>Get started</h2>
        <span className={styles.muted}>
          <Bar width="8ch" />
        </span>
      </div>
      <ol className={styles.steps}>
        {[0, 1, 2].map((step) => (
          <li key={step}>
            <span className={styles.stepMark} aria-hidden="true" />
            <div>
              <Bar width="90%" />
              <br />
              <Bar width="60%" />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** "Your sessions" with the list the MCP Worker answered (it polls from there). */
export async function HomeSessionsPanel(props: {
  readonly userId: string;
  readonly sessions: Promise<readonly AgentSession[] | null>;
}) {
  const sessions = await props.sessions;
  return <SessionsPanel seed={{ userId: props.userId, sessions, readAtMs: Date.now() }} />;
}

export function SessionsPanelFallback() {
  return (
    <section className={styles.panel} aria-labelledby="sessions-title">
      <div className={styles.panelHead}>
        <h2 id="sessions-title">Your sessions</h2>
        <Link href="/signup/agent" className={styles.muted}>
          Connect another
        </Link>
      </div>
      <ul className={styles.repoList}>
        <li className={styles.sessionRow}>
          <span className={skeleton.dot} aria-hidden="true" />
          <div>
            <Bar width="12ch" />
            <p className={styles.repoMeta}>
              <Bar width="24ch" />
            </p>
          </div>
        </li>
      </ul>
    </section>
  );
}

/** The activity list, after its heading. */
export async function ActivityList(props: {
  readonly growth: Promise<HomeGrowth>;
  readonly nowMs: number;
}) {
  const { activity } = await props.growth;
  if (activity.length === 0)
    return <p className={styles.empty}>What happens in your repositories shows up here.</p>;
  return (
    <ul className={styles.activity}>
      {activity.map((line) => (
        <li key={line.key} data-tone={line.tone}>
          <span>
            <Link href={repositoryPath(line.owner, line.repo)} className={styles.mono}>
              {line.owner}/{line.repo}
            </Link>{' '}
            {line.bean === null ? null : (
              <>
                <Link
                  href={`${repositoryPath(line.owner, line.repo)}/changes/${encodeURIComponent(line.bean)}`}
                  className={styles.activityBean}
                >
                  {line.bean}
                </Link>{' '}
              </>
            )}
            {line.text}
            <time dateTime={line.at}>{timeAgo(line.at, props.nowMs)}</time>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ActivityFallback() {
  return (
    <ul className={styles.activity} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((row) => (
        <li key={row} data-tone="neutral">
          <span>
            <Bar width={row % 2 === 0 ? '80%' : '65%'} />
            <time>
              <Bar width="9ch" />
            </time>
          </span>
        </li>
      ))}
    </ul>
  );
}

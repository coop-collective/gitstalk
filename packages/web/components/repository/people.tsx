/**
 * A repository's People: who has access and with which role, and which credentials acted for
 * whom (agent sessions, personal tokens, SSH keys, deploy tokens: every session belongs to a
 * person). Members see it; a public repository's other readers are told who owns it.
 */
import { IntentLink as Link } from '../shell/intent-link';

import type {
  RepositoryPeople,
  RepositorySession,
} from '../../src/repositories/collaborators-client';
import { timeAgo } from '../../src/repositories/when';
import { LeaveRepository } from './collaborators';
import { ROLE_SUMMARY } from './roles';
import styles from './repository.module.css';

const VIA: Readonly<Record<RepositorySession['via'], string>> = {
  'agent-session': 'agent session',
  mcp: 'agent over MCP',
  'personal-token': 'personal token',
  'ssh-key': 'SSH key',
  'deploy-token': 'deploy token',
};

export function PeoplePanels(props: {
  readonly fullName: string;
  readonly ownerHandle: string;
  readonly people: RepositoryPeople | null;
  readonly settingsHref: string | null;
  readonly leave: {
    readonly userId: string;
    readonly csrf: string;
    readonly repoId: string;
    readonly path: string;
  } | null;
  readonly nowMs: number;
}) {
  if (props.people === null)
    return (
      <section className={`${styles.panel} ${styles.settingsSection}`}>
        <h2>People</h2>
        <p className={styles.sub}>
          {props.fullName} is public and belongs to <b>@{props.ownerHandle}</b>. Only people on it
          see who else is.
        </p>
      </section>
    );
  const { people } = props;
  return (
    <>
      <section
        className={`${styles.panel} ${styles.settingsSection}`}
        aria-labelledby="access-title"
      >
        <h2 id="access-title">Who has access</h2>
        <p className={styles.sub}>
          You are <b>{people.viewer_role}</b>: {ROLE_SUMMARY[people.viewer_role].toLowerCase()}
          {props.settingsHref === null ? null : (
            <>
              {' '}
              <Link href={props.settingsHref}>Manage people in Settings</Link>.
            </>
          )}
        </p>
        <ul className={styles.deployList}>
          {people.collaborators.map((person) => (
            <li key={person.user_id}>
              <div>
                <b>@{person.handle}</b> <span className={styles.pill}>{person.role}</span>
                <br />
                <span className={styles.muted}>{ROLE_SUMMARY[person.role]}</span>
              </div>
              <span className={styles.muted}>since {timeAgo(person.since, props.nowMs)}</span>
            </li>
          ))}
        </ul>
        {props.leave === null ? null : (
          <LeaveRepository
            fullName={props.fullName}
            userId={props.leave.userId}
            access={{
              repoId: props.leave.repoId,
              csrf: props.leave.csrf,
              path: props.leave.path,
            }}
          />
        )}
      </section>
      <section
        className={`${styles.panel} ${styles.settingsSection}`}
        aria-labelledby="sessions-title"
      >
        <h2 id="sessions-title">Sessions and tokens</h2>
        <p className={styles.sub}>
          Every agent session, token and key acts for a person. These reached {props.fullName}{' '}
          lately.
        </p>
        {people.sessions.length === 0 ? (
          <p className={styles.muted}>Nothing has cloned or pushed yet.</p>
        ) : (
          <table className={styles.sessionsTable}>
            <thead>
              <tr>
                <th scope="col">For</th>
                <th scope="col">Through</th>
                <th scope="col">Last read</th>
                <th scope="col">Last push</th>
                <th scope="col">Pushes</th>
              </tr>
            </thead>
            <tbody>
              {people.sessions.map((session) => (
                <tr key={`${session.via}-${session.label}-${session.handle}`}>
                  <td>@{session.handle}</td>
                  <td>
                    {session.label} <span className={styles.muted}>{VIA[session.via]}</span>
                  </td>
                  <td>{when(session.last_read_at, props.nowMs)}</td>
                  <td>{when(session.last_push_at, props.nowMs)}</td>
                  <td>{session.pushes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function when(at: string | null, nowMs: number): string {
  return at === null ? '—' : timeAgo(at, nowMs);
}

/**
 * A new repository's page before anything has grown: the first screen a new user sees. It
 * says what is on the stalk and exactly how a person or an agent starts: connecting git (the
 * Plugin, HTTPS and Env vars tabs), what to ask an agent, a first bean pushed with plain git,
 * the clone URL, and what counts as green. The stalk on the left is the real one: its root commit, and a socket where the
 * first bean will grow.
 */
import { CHECKS_PATH } from '@gitstalk/shared-race/checks-config';
import { IntentLink as Link } from '../shell/intent-link';

import type { StartGuide } from '../../src/repositories/paths';
import type { RepositoryFiles, RepositoryRecord } from '../../src/repositories/registry-client';
import { ChecksSummary } from './checks-config';
import type { DeployTokenAccess } from './connect-tabs';
import { ConnectTabs } from './connect-tabs';
import { CopyButton } from './copy-button';
import styles from './repository.module.css';

export function StartHere(props: {
  readonly record: RepositoryRecord;
  readonly files: RepositoryFiles | null;
  readonly guide: StartGuide;
  readonly deploy: DeployTokenAccess;
}) {
  const { record, files, guide } = props;
  return (
    <div className={styles.start}>
      <Seedling record={record} files={files} />
      <section className={styles.guide} aria-labelledby="start-title">
        <div>
          <h2 id="start-title" className={styles.lead}>
            {record.name} is ready. {leadOf(record, files)}
          </h2>
          {record.description === '' ? null : <p className={styles.sub}>{record.description}</p>}
        </div>
        <div className={styles.steps}>
          <ConnectTabs guide={guide} deploy={props.deploy} />
          <AgentStep guide={guide} />
          <GitStep guide={guide} />
          <section className={styles.step} aria-labelledby="clone-title">
            <h2 id="clone-title">Clone it</h2>
            <div className={styles.cloneRow}>
              <input readOnly value={guide.cloneUrl} aria-label="Clone URL" spellCheck={false} />
              <CopyButton text={guide.cloneUrl} label="the clone URL" />
            </div>
            {guide.ssh === null ? null : (
              <>
                <div className={styles.cloneRow}>
                  <input
                    readOnly
                    value={guide.ssh.cloneUrl}
                    aria-label="SSH clone URL"
                    spellCheck={false}
                  />
                  <CopyButton text={guide.ssh.cloneUrl} label="the SSH clone URL" />
                </div>
                {guide.ssh.hostKeyFingerprint === '' ? null : (
                  <p>
                    Over SSH, check the server&apos;s host key on first connect:{' '}
                    <code>{guide.ssh.hostKeyFingerprint}</code>
                  </p>
                )}
              </>
            )}
          </section>
        </div>
        <Facts files={files} />
      </section>
    </div>
  );
}

function AgentStep({ guide }: { readonly guide: StartGuide }) {
  return (
    <section className={styles.step} aria-labelledby="agent-title">
      <h2 id="agent-title">Hand it to an agent</h2>
      <p>
        Once git is connected, ask for the change you want: the agent opens a bean, pushes it, and
        reworks it if a check fails. You answer the decisions only people should make. Any other MCP
        client connects to <code>{guide.agents.at(-1)?.line}</code>.
      </p>
      <div className={styles.say}>
        <q>{guide.prompt}</q>
        <CopyButton text={guide.prompt} label="what to ask your agent" />
      </div>
    </section>
  );
}

function GitStep(props: { readonly guide: StartGuide }) {
  const script = props.guide.gitSteps.filter((line) => !line.startsWith('#')).join('\n');
  return (
    <section className={styles.step} aria-labelledby="git-title">
      <h2 id="git-title">Or push a bean with git</h2>
      <p>
        A branch named <code>bean/&lt;name&gt;</code> is a bean. Push it and Gitstalk checks it on
        the exact tree it would land on, then puts it on the sprout. With <code>-o wait</code> the
        push stays open until the bean lands, or tells you why it came back.
      </p>
      <div className={styles.terminalBar}>
        <span>In a terminal</span>
        <CopyButton text={script} label="the git steps" />
      </div>
      <div className={styles.terminal}>
        {props.guide.gitSteps.map((line) =>
          line.startsWith('#') ? (
            <code key={line} className={styles.comment}>
              {line}
            </code>
          ) : (
            <code key={line} className={styles.prompt}>
              {line}
            </code>
          ),
        )}
      </div>
      <ul className={styles.rules}>
        <li>
          Push only to <code>bean/&lt;name&gt;</code>. The stalk and the sprout move when beans
          land, never by a push.
        </li>
        <li>
          git signs in with what Connect git set up. Without it git asks for a password: paste a
          personal token with write access from{' '}
          <Link href="/settings/tokens">Settings, Tokens</Link>; any user name works.
        </li>
      </ul>
    </section>
  );
}

function Facts({ files }: { readonly files: RepositoryFiles | null }) {
  return (
    <div className={styles.facts}>
      <section className={styles.panel} aria-labelledby="files-title">
        <div className={styles.panelHead}>
          <h2 id="files-title">On the stalk</h2>
          {files === null || files.sha === null ? null : (
            <span className={`${styles.muted} ${styles.mono}`}>{files.sha.slice(0, 7)}</span>
          )}
        </div>
        {files === null || files.files.length === 0 ? (
          <p className={styles.empty}>The stalk is being read. Refresh in a moment.</p>
        ) : (
          <ul className={styles.fileList}>
            {files.files.map((path) => (
              <li key={path}>
                <span>{directoryOf(path)}</span>
                {path.slice(directoryOf(path).length)}
              </li>
            ))}
            {files.truncated ? <li className={styles.muted}>and more</li> : null}
          </ul>
        )}
      </section>
      <section className={styles.panel} aria-labelledby="checks-title">
        <div className={styles.panelHead}>
          <h2 id="checks-title">What counts as green</h2>
          <span className={`${styles.muted} ${styles.mono}`}>
            {files?.checksPath ?? CHECKS_PATH}
          </span>
        </div>
        {files === null ? (
          <p className={styles.empty}>The stalk is being read. Refresh in a moment.</p>
        ) : (
          <ChecksSummary file={files.checks} path={files.checksPath} />
        )}
      </section>
    </div>
  );
}

function Seedling(props: {
  readonly record: RepositoryRecord;
  readonly files: RepositoryFiles | null;
}) {
  const sha = props.files?.sha ?? null;
  return (
    <aside className={styles.seedling} aria-label="The stalk">
      <p className={styles.seedlingHead}>
        the stalk
        <span>nothing growing yet</span>
      </p>
      <div className={`${styles.plant} ${styles.socketRow}`}>
        <span className={styles.tick}>next</span>
        <span className={styles.stemLine}>
          <i className={styles.socket} />
        </span>
        <span className={styles.socketText}>
          Your first bean grows here
          <small>bean/first-change</small>
        </span>
      </div>
      <div className={`${styles.plant} ${styles.leafRow}`}>
        <span className={styles.tick}>base</span>
        <span className={styles.stemLine}>
          <i className={styles.leafMark} />
        </span>
        <span className={styles.leafText}>
          {firstCommitTitle(props.record)}
          <small>{sha === null ? 'stalk' : `stalk ${sha.slice(0, 7)}`}</small>
        </span>
      </div>
      <div className={`${styles.plant} ${styles.rootRow}`}>
        <span />
        <span className={styles.stemLine} />
        <span>Fertilized by {props.record.owner.handle}</span>
      </div>
    </aside>
  );
}

function leadOf(record: RepositoryRecord, files: RepositoryFiles | null): string {
  const count = files === null ? null : files.files.length;
  switch (record.origin.kind) {
    case 'template':
      return `Its stalk holds the TypeScript starter${count === null ? '' : `, ${count} files`}, with tests every bean must pass before it lands.`;
    case 'empty':
      return 'Its stalk holds a README. Push a first bean to grow it.';
    case 'import':
      return `Its stalk is the default branch of ${record.origin.url}.`;
    default:
      return assertNever(record.origin);
  }
}

function firstCommitTitle(record: RepositoryRecord): string {
  switch (record.origin.kind) {
    case 'template':
      return 'Start from the TypeScript starter';
    case 'empty':
      return 'Initial commit';
    case 'import':
      return 'Imported history';
    default:
      return assertNever(record.origin);
  }
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash + 1);
}

function assertNever(value: never): never {
  throw new Error(`unexpected origin: ${JSON.stringify(value)}`);
}

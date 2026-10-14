/**
 * What counts as green on a repository: the effective checks of its stalk, read from
 * `.gitstalk/checks.yml` (or an older checks file, `CHECKS_PATHS`) with the parser the engine uses, so the page says exactly what the
 * next pre-land check will run (a bean that changes the file is checked by its own copy).
 */
import {
  ALWAYS_PROTECTED,
  CHECKS_PATH,
  readChecksConfig,
} from '@gitstalk/shared-race/checks-config';
import type { ChecksConfig } from '@gitstalk/shared-race/checks-config';
import { DEFAULT_SUITE, suiteCommand } from '@gitstalk/shared-race/suite';

import styles from './repository.module.css';

export function ChecksSummary(props: {
  readonly file: string | null;
  readonly path: string | null;
}) {
  const resolution = readChecksConfig(props.file, props.path ?? CHECKS_PATH);
  switch (resolution.kind) {
    case 'missing':
      return (
        <div className={styles.checksBody}>
          <p>
            <b>Default suite.</b> There is no <code>{CHECKS_PATH}</code> on the stalk, so every bean
            runs the repository&apos;s default suite before it lands. Pushes say so in their{' '}
            <code>remote:</code> lines.
          </p>
          <DefaultSuite />
          <p className={styles.muted}>
            To choose another command, environment or protected paths, the owner or a maintainer
            pushes the file in a bean with a personal token or an SSH key (agents may not change{' '}
            <code>{CHECKS_PATH}</code>).
          </p>
        </div>
      );
    case 'legacy':
      return (
        <div className={styles.checksBody}>
          <p>
            <b>Default suite.</b> <code>{resolution.path}</code> on the stalk is the starter&apos;s
            older <code>[[check]]</code> draft, which does not choose the suite, so every bean runs
            the repository&apos;s default suite, as it always has.
          </p>
          <DefaultSuite />
          <p className={styles.muted}>
            To choose another, a maintainer replaces it with <code>{CHECKS_PATH}</code> and its{' '}
            <code>run</code> list (such as <code>run: [node, --test]</code>).
          </p>
          <RawFile file={props.file} />
        </div>
      );
    case 'invalid':
      return (
        <div className={styles.checksBody}>
          <p>
            <b>Invalid.</b> Every bean&apos;s pre-land check is red until a maintainer fixes{' '}
            <code>{resolution.path}</code>:
          </p>
          <ul className={styles.checksProblems}>
            {resolution.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          <RawFile file={props.file} />
        </div>
      );
    case 'valid':
      return (
        <div className={styles.checksBody}>
          <EffectiveChecks config={resolution.config} />
          <RawFile file={props.file} />
        </div>
      );
    default:
      return resolution satisfies never;
  }
}

function EffectiveChecks(props: { readonly config: ChecksConfig }) {
  const { config } = props;
  const env = Object.entries(config.env);
  const protectedPaths = [...ALWAYS_PROTECTED, ...config.protected_paths];
  return (
    <dl className={styles.checksFacts}>
      <dt>Runs</dt>
      <dd className={styles.mono}>{suiteCommand({ argv: [...config.command] })}</dd>
      <dt>Image</dt>
      <dd>{config.image} (Node 25.8.1; nothing is installed at check time)</dd>
      <dt>Time limit</dt>
      <dd>{config.timeout_seconds} s</dd>
      <dt>Environment</dt>
      <dd className={styles.mono}>
        {env.length === 0 ? 'none' : env.map(([name, value]) => `${name}=${value}`).join('  ')}
      </dd>
      <dt>Protected</dt>
      <dd className={styles.mono}>{protectedPaths.join(', ')}</dd>
    </dl>
  );
}

/** The engine's own suite, which a repository without a usable declaration runs. */
function DefaultSuite() {
  return (
    <dl className={styles.checksFacts}>
      <dt>Runs</dt>
      <dd className={styles.mono}>{suiteCommand(DEFAULT_SUITE)}</dd>
      <dt>Time limit</dt>
      <dd>{DEFAULT_SUITE.timeout_seconds} s</dd>
      <dt>Protected</dt>
      <dd className={styles.mono}>{ALWAYS_PROTECTED.join(', ')}</dd>
    </dl>
  );
}

function RawFile(props: { readonly file: string | null }) {
  return props.file === null ? null : (
    <details>
      <summary className={styles.muted}>The file</summary>
      <pre className={styles.checksFile}>{props.file}</pre>
    </details>
  );
}

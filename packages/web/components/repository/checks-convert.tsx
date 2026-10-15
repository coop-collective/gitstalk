'use client';

/**
 * Settings → Checks for a repository whose checks are still a `checks.toml`: the equivalent
 * `.gitstalk/checks.yml` (converted by the engine's own `tomlChecksToYaml`, so it declares
 * exactly the same checks) and, for owners and maintainers, a "Convert to YAML" button that saves
 * it as a bean authored by the person, deleting the TOML in the same commit.
 */
import { useState } from 'react';

import { CHECKS_PATH } from '@gitstalk/shared-race/checks-config';

import { saveKeys } from '../../src/automations/automation-save';
import type { ChecksConvertState } from '../../src/server/checks-actions';
import { convertChecksAction } from '../../src/server/checks-actions';
import { IntentLink as Link } from '../shell/intent-link';
import builder from '../automations/builder.module.css';
import styles from './repository.module.css';

export type ChecksConvertProps = {
  readonly repo: { readonly owner: string; readonly name: string; readonly base: string };
  readonly csrf: string | null;
  /** The TOML file the stalk has. */
  readonly from: string;
  /** Its equivalent `checks.yml`. */
  readonly yaml: string;
  /** Null when the person may convert; else why not. */
  readonly refusal: string | null;
};

type Phase = { readonly kind: 'ready' } | { readonly kind: 'converting' } | ChecksConvertState;

export function ChecksConvert(props: ChecksConvertProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'ready' });
  const [keyOf] = useState(() => saveKeys());
  const convert = async () => {
    setPhase({ kind: 'converting' });
    const form = new FormData();
    form.set('csrf', props.csrf ?? '');
    form.set('owner', props.repo.owner);
    form.set('name', props.repo.name);
    form.set('yaml', props.yaml);
    form.set('idempotencyKey', keyOf(props.yaml));
    setPhase(await convertChecksAction(form));
  };
  const canConvert =
    props.refusal === null &&
    props.csrf !== null &&
    (phase.kind === 'ready' || phase.kind === 'refused');
  return (
    <div className={styles.checksBody}>
      <p>
        <b>{props.from} is the older TOML format.</b> It still works; {CHECKS_PATH} is the format
        now, like every other file in <code>.gitstalk/</code>. This is the same checks in YAML
        (comments are not carried over):
      </p>
      <pre className={styles.checksFile}>{props.yaml}</pre>
      {props.refusal === null ? (
        <p>
          <button
            type="button"
            className={builder.primary}
            disabled={!canConvert}
            onClick={() => void convert()}
          >
            {phase.kind === 'converting' ? 'Converting…' : 'Convert to YAML'}
          </button>{' '}
          One bean with you as its author writes {CHECKS_PATH} and deletes {props.from}; it lands
          through the pre-land check.
        </p>
      ) : (
        <p className={styles.muted}>{props.refusal}</p>
      )}
      <ConvertedLine phase={phase} base={props.repo.base} />
    </div>
  );
}

function ConvertedLine(props: { readonly phase: Phase; readonly base: string }) {
  const { phase } = props;
  if (phase.kind === 'refused')
    return (
      <p className={builder.banner} data-tone="bad" role="alert">
        {phase.message}
      </p>
    );
  if (phase.kind !== 'converted') return null;
  return (
    <p className={builder.beanLine} data-phase="checking" role="status">
      Converted in commit <span className={styles.mono}>{phase.commit.slice(0, 7)}</span> on{' '}
      <Link
        href={`${props.base}/changes/${encodeURIComponent(phase.bean)}`}
        className={styles.mono}
      >
        bean/{phase.bean}
      </Link>
      : it lands through the pre-land check like any change.
    </p>
  );
}

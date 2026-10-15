'use client';

/**
 * Settings → Rules' editor: the approval rules' YAML, checked as you type by the engine's own
 * parser (`@gitstalk/shared-race/policy-file`, the same errors with their lines), then saved as a
 * bean authored by the signed-in person. After saving it shows the commit and follows the bean
 * until it lands. Read-only for anyone who may not save, with why.
 */
import { useEffect, useRef, useState } from 'react';

import { STARTER_POLICY, readApprovalPolicy } from '@gitstalk/shared-race/policy-file';

import { saveKeys } from '../../src/automations/automation-save';
import type { BeanStatus } from '../../src/automations/editor-client';
import { rulesBeanAction, saveRulesAction } from '../../src/server/rules-actions';
import { IntentLink as Link } from '../shell/intent-link';
import { YamlPane } from '../automations/yaml-pane';
import styles from '../automations/builder.module.css';

const POLL_MS = 2000;

export type RulesEditorProps = {
  readonly repo: { readonly owner: string; readonly name: string; readonly base: string };
  readonly csrf: string | null;
  readonly path: string;
  readonly opened: {
    readonly base: { commit: string; blob: string | null };
    readonly text: string | null;
  };
  /** Null when the person may save; else why not. */
  readonly refusal: string | null;
};

type Phase =
  | { readonly kind: 'editing' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'refused'; readonly message: string }
  | {
      readonly kind: 'pushed';
      readonly bean: string;
      readonly commit: string;
      readonly status: BeanStatus | null;
    };

export function RulesEditor(props: RulesEditorProps) {
  const initial = props.opened.text ?? STARTER_POLICY;
  const [text, setText] = useState(initial);
  const [phase, setPhase] = useState<Phase>({ kind: 'editing' });
  const [keyOf] = useState(() => saveKeys());
  const resolution = readApprovalPolicy(text, props.path);
  const problems =
    resolution.kind === 'invalid'
      ? resolution.problems.map((problem) => ({
          line: problem.line,
          message: problem.field === '' ? problem.message : `${problem.field}: ${problem.message}`,
        }))
      : [];
  const formData = (fields: Record<string, string>): FormData => {
    const data = new FormData();
    data.set('csrf', props.csrf ?? '');
    data.set('owner', props.repo.owner);
    data.set('name', props.repo.name);
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  };
  useBeanPolling(phase, setPhase, (bean) => rulesBeanAction(formData({ bean })));
  const canSave =
    props.refusal === null &&
    props.csrf !== null &&
    problems.length === 0 &&
    text !== props.opened.text &&
    phase.kind !== 'saving';
  const save = async () => {
    setPhase({ kind: 'saving' });
    const fields = { base: JSON.stringify(props.opened.base), content: text };
    const answer = await saveRulesAction(
      formData({ ...fields, idempotencyKey: keyOf(JSON.stringify(fields)) }),
    );
    if (answer.kind === 'refused') return setPhase({ kind: 'refused', message: answer.message });
    if (answer.result.kind === 'stale')
      return setPhase({
        kind: 'refused',
        message: 'The rules changed since this page opened. Reload to see them, then edit again.',
      });
    return setPhase({
      kind: 'pushed',
      bean: answer.result.bean,
      commit: answer.result.commit,
      status: null,
    });
  };
  return (
    <div>
      {props.refusal === null ? null : (
        <p className={styles.banner} data-tone="bad">
          {props.refusal}
        </p>
      )}
      {props.opened.text === null ? (
        <p className={styles.banner}>
          This repository has no rules yet, so every bean lands on its tests. Below are the
          recommended starter rules; nothing changes until they are saved.
        </p>
      ) : null}
      <YamlPane
        path={props.path}
        text={text}
        problems={problems}
        onChange={(next) => {
          if (props.refusal === null) setText(next);
        }}
      />
      {props.refusal === null ? (
        <p>
          <button
            type="button"
            className={styles.primary}
            disabled={!canSave}
            onClick={() => void save()}
          >
            {phase.kind === 'saving' ? 'Saving…' : 'Save rules'}
          </button>{' '}
          Saving pushes a bean with you as its author; it lands through the pre-land check.
        </p>
      ) : null}
      {phase.kind === 'refused' ? (
        <p className={styles.banner} data-tone="bad" role="alert">
          {phase.message}
        </p>
      ) : null}
      <SavedLine phase={phase} base={props.repo.base} path={props.path} />
    </div>
  );
}

function SavedLine(props: { readonly phase: Phase; readonly base: string; readonly path: string }) {
  const { phase } = props;
  if (phase.kind !== 'pushed') return null;
  const beanLink = (
    <Link href={`${props.base}/changes/${encodeURIComponent(phase.bean)}`} className={styles.mono}>
      bean/{phase.bean}
    </Link>
  );
  const status = phase.status;
  const sha = status?.landedSha ?? phase.commit;
  const commitLink = (
    <Link
      className={styles.mono}
      href={`${props.base}/blob/${props.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(sha)}`}
    >
      {sha.slice(0, 7)}
    </Link>
  );
  if (status === null || status.phase === 'checking' || status.phase === 'waiting')
    return (
      <p className={styles.beanLine} data-phase="checking" role="status">
        Saved as commit {commitLink} on {beanLink}: checking…
      </p>
    );
  if (status.phase === 'landed' || status.phase === 'green')
    return (
      <p className={styles.beanLine} data-phase="landed" role="status">
        ✓ Saved. {beanLink} landed as {commitLink}; the rules apply once the stalk takes it.
      </p>
    );
  return (
    <p className={styles.beanLine} data-phase="red" role="alert">
      {beanLink} did not land ({status.phase}): {status.reason}
    </p>
  );
}

/** Polls the pushed bean until it has a verdict. */
function useBeanPolling(
  phase: Phase,
  setPhase: (phase: Phase) => void,
  read: (
    bean: string,
  ) => Promise<{ kind: 'status'; status: BeanStatus } | { kind: 'refused'; message: string }>,
): void {
  const latest = useRef(phase);
  latest.current = phase;
  const bean = phase.kind === 'pushed' ? phase.bean : null;
  const isWaiting =
    phase.kind === 'pushed' &&
    (phase.status === null ||
      phase.status.phase === 'checking' ||
      phase.status.phase === 'waiting');
  useEffect(() => {
    const timer = setTimeout(() => {
      if (bean === null || !isWaiting) return;
      void (async () => {
        const answer = await read(bean);
        const current = latest.current;
        if (answer.kind !== 'status' || current.kind !== 'pushed' || current.bean !== bean) return;
        setPhase({ ...current, status: answer.status });
      })();
    }, POLL_MS);
    return () => clearTimeout(timer);
  });
}

import { IntentLink as Link } from '../shell/intent-link';

import type { Answer, Chip } from '@gitstalk/shared-ask/ask/answer';
import { CATALOG, specWithView } from '@gitstalk/shared-ask/ask/view-spec';
import { VISIBLE_FILE_CHIPS } from '@gitstalk/shared-ask/ask/chips';
import styles from './explorer.module.css';
import type { ExplorerState } from './explorer-url';
import { explorerHref } from './explorer-url';

const KIND_LABEL: Readonly<Record<Chip['kind'], string>> = {
  feature: 'about',
  range: 'range',
  agent: 'agent',
  bean: 'bean',
  path: 'path',
  file: 'file',
};

/** Who produced the view spec, named for a person. */
const CLASSIFIER_LABELS: Readonly<Record<Answer['classifiedBy'], string>> = {
  keywords: 'keyword router',
  'workers-ai': 'Workers AI',
  clef: 'Clef',
  jev: 'Jev',
};

/**
 * What Ask understood: the question's class, one computed sentence, and the parsed question
 * as chips. Removing a chip re-runs the question without it.
 */
export function AnswerPanel(props: {
  readonly base: string;
  readonly state: ExplorerState;
  readonly answer: Answer;
}) {
  const { base, state, answer } = props;
  const hiddenFiles = Math.max(
    0,
    answer.fileSet.filter((file) => answer.tree.matched.includes(file.path)).length -
      VISIBLE_FILE_CHIPS,
  );
  return (
    <section className={styles.answer} aria-label="Answer">
      <p className={styles.answerTop}>
        <span className={styles.answerClass}>{CATALOG[answer.spec.class].label}</span>
        <span className={styles.headline} role="status">
          {answer.headline}
        </span>
      </p>
      {answer.chips.length > 0 || state.removed.length > 0 ? (
        <div className={styles.chips}>
          {answer.chips.map((chip) => (
            <Link
              key={chip.id}
              href={explorerHref(base, state, {
                removed: [...state.removed, chip.id],
                file: null,
                bean: null,
              })}
              className={styles.chip}
              aria-label={`Remove ${KIND_LABEL[chip.kind]} ${chip.label}`}
            >
              <span className={styles.chipKind}>{KIND_LABEL[chip.kind]}</span>
              {chip.label}
              <span className={styles.chipRemove} aria-hidden="true">
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <path
                    d="M2 2 8 8M8 2 2 8"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            </Link>
          ))}
          {hiddenFiles > 0 ? (
            <span className={styles.chipsNote}>and {hiddenFiles} more files</span>
          ) : null}
          {state.removed.length > 0 ? (
            <Link href={explorerHref(base, state, { removed: [] })} className={styles.restore}>
              Restore {state.removed.length} removed
            </Link>
          ) : null}
        </div>
      ) : null}
      <details className={styles.spec}>
        <summary>
          View spec ({CLASSIFIER_LABELS[answer.classifiedBy]}), as agents get it over MCP
        </summary>
        <pre>{JSON.stringify(specWithView(answer.spec), null, 2)}</pre>
      </details>
    </section>
  );
}

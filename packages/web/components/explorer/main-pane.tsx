import { IntentLink as Link } from '../shell/intent-link';

import type { MainPane as MainPaneModel } from '@gitstalk/shared-ask/ask/answer';
import type { Pushers } from '@gitstalk/shared-ask/home/sessions';
import { BeanList, BeanView } from './bean-view';
import { DiffView } from './diff-view';
import styles from './explorer.module.css';
import type { ExplorerState } from './explorer-url';
import { explorerHref } from './explorer-url';
import { FileView } from './file-view';

/** The centre of the explorer: a diff, a file, a bean, or a list of beans. */
export function MainPane(props: {
  readonly base: string;
  readonly state: ExplorerState;
  readonly main: MainPaneModel;
  /** The bean whose history the rail already shows, if any. */
  readonly railBean: string | null;
  /** Who pushed each bean (a repository's); empty for races. */
  readonly pushers: Pushers;
}) {
  const { base, state, main } = props;
  switch (main.kind) {
    case 'diff': {
      const additions = main.diff.files.reduce((sum, file) => sum + file.additions, 0);
      const deletions = main.diff.files.reduce((sum, file) => sum + file.deletions, 0);
      return (
        <>
          <div className={styles.mainHead}>
            <h2 className={styles.mainTitle}>{main.title}</h2>
            <span className={styles.mainMeta}>
              {main.fromLabel} to {main.toLabel}, <span className={styles.add}>+{additions}</span>{' '}
              <span className={styles.del}>−{deletions}</span>
            </span>
          </div>
          <div className={styles.mainBody}>
            <DiffView files={main.diff.files} />
          </div>
        </>
      );
    }
    case 'file':
      return (
        <>
          <div className={styles.mainHead}>
            <h2 className={styles.mainTitle}>{main.title}</h2>
            <span className={styles.mainMeta}>
              {main.blame === null ? null : 'Blame by bean. '}
              {main.highlights.length === 0
                ? ''
                : `${main.highlights.length} lines changed in this range are marked.`}
            </span>
            <span className={styles.viewSwitch}>
              <Link
                href={explorerHref(base, state, { file: main.title, view: 'diff', bean: null })}
              >
                Diff in this range
              </Link>
            </span>
          </div>
          <FileView
            beanHref={(bean) => explorerHref(base, state, { bean, file: null, view: null })}
            text={main.file.text}
            highlights={main.highlights}
            blame={main.blame}
          />
        </>
      );
    case 'bean':
      return (
        <BeanView
          base={base}
          state={state}
          bean={main.bean}
          diff={main.diff}
          showSteps={props.railBean !== main.bean.id}
          pusher={props.pushers[main.bean.id] ?? null}
        />
      );
    case 'beans':
      return (
        <>
          <div className={styles.mainHead}>
            <h2 className={styles.mainTitle}>{main.title}</h2>
          </div>
          <BeanList base={base} state={state} beans={main.beans} pushers={props.pushers} />
        </>
      );
    case 'empty':
      return (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{main.title}</p>
          <p>{main.message}</p>
        </div>
      );
    default:
      return null;
  }
}

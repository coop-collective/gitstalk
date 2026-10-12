import { IntentLink as Link } from '../shell/intent-link';

import type { BlameLine } from '@gitstalk/shared-ask/ask/answer';
import { textLines } from '@gitstalk/shared-ask/repo/file-diff';
import styles from './explorer.module.css';

/**
 * A file at the ref: line numbers, the lines the question's range changed highlighted, and
 * optionally blame by bean (which bean last changed each run of lines).
 */
export function FileView(props: {
  /** Where a bean in the blame column links to. */
  readonly beanHref: (bean: string) => string;
  readonly text: string;
  readonly highlights: readonly number[];
  readonly blame: readonly BlameLine[] | null;
}) {
  const lines = textLines(props.text);
  const marked = new Set(props.highlights);
  return (
    <div className={styles.code}>
      <table className={styles.codeTable}>
        <tbody>
          {lines.map((line, index) => {
            const number = index + 1;
            return (
              <tr key={number} className={marked.has(number) ? styles.lineHl : undefined}>
                {props.blame === null ? null : (
                  <BlameCell beanHref={props.beanHref} blame={props.blame} index={index} />
                )}
                <td className={styles.lineNo}>{number}</td>
                <td className={styles.text}>
                  {marked.has(number) ? <span className="visually-hidden">changed: </span> : null}
                  {line}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The bean of a run of lines, printed once at the top of the run. */
function BlameCell(props: {
  readonly beanHref: (bean: string) => string;
  readonly blame: readonly BlameLine[];
  readonly index: number;
}) {
  const current = props.blame[props.index];
  const previous = props.blame[props.index - 1];
  const startsRun = previous === undefined || previous.task !== current?.task;
  if (current === undefined || !startsRun) return <td className={styles.blame} />;
  if (current.task === null) return <td className={`${styles.blame} ${styles.blameBase}`}>base</td>;
  return (
    <td className={styles.blame}>
      <Link href={props.beanHref(current.task)}>
        {current.task}
        {current.idx === null ? '' : ` #${current.idx}`}
      </Link>
    </td>
  );
}

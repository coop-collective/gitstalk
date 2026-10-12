import { IntentLink as Link } from '../shell/intent-link';

import type { RaceMoment } from '../../src/race/race-moments';
import { formatClock } from '../../src/race/race-format';
import { AskShortcut } from './ask-shortcut';
import { AutoSubmitSelect } from './auto-submit-select';
import styles from './explorer.module.css';
import type { ExplorerState } from './explorer-url';
import { askHref } from './explorer-url';

export type Suggestion = { readonly q: string; readonly at?: number };

const INPUT_ID = 'ask-input';

/**
 * The Ask bar: a plain GET form (it works without JavaScript), the line selector, and for a
 * recorded run the moment of the race to look at.
 */
export function AskBar(props: {
  readonly base: string;
  readonly state: ExplorerState;
  readonly policy: 'queue' | 'beanstalk' | null;
  readonly moments: readonly RaceMoment[] | null;
  readonly endedAt: number | null;
  readonly suggestions: readonly Suggestion[];
}) {
  const { base, state } = props;
  return (
    <div className={styles.askWrap}>
      <form action={`${base}/files`} method="get" className={styles.ask} role="search">
        <div className={styles.askForm}>
          <label htmlFor={INPUT_ID} className={styles.askLabel}>
            <AskGlyph />
            <span>Ask</span>
          </label>
          <input
            id={INPUT_ID}
            name="q"
            type="search"
            className={styles.askInput}
            defaultValue={state.q}
            placeholder="what changed recently on coupons?"
            autoComplete="off"
            enterKeyHint="search"
            aria-describedby="ask-hint"
          />
          <button type="submit" className={styles.askButton}>
            Ask
          </button>
        </div>
        <div className={styles.controls}>
          {props.policy === 'queue' ? (
            <input type="hidden" name="ref" value="stalk" />
          ) : (
            <label className={styles.control} htmlFor="ask-ref">
              Line
              <AutoSubmitSelect
                id="ask-ref"
                name="ref"
                defaultValue={state.ref ?? 'sprout'}
                className={styles.select}
              >
                <option value="sprout">Sprout (staged)</option>
                <option value="stalk">Stalk (stable)</option>
              </AutoSubmitSelect>
            </label>
          )}
          {props.moments === null ? null : (
            <label className={styles.control} htmlFor="ask-at">
              As of
              <AutoSubmitSelect
                id="ask-at"
                name="at"
                defaultValue={state.at === null ? '' : String(Math.round(state.at))}
                className={styles.select}
              >
                <option value="">
                  End of the race{props.endedAt === null ? '' : ` (${formatClock(props.endedAt)})`}
                </option>
                {props.moments.map((moment) => (
                  <option key={`${moment.t}-${moment.label}`} value={String(Math.round(moment.t))}>
                    {moment.label}
                  </option>
                ))}
              </AutoSubmitSelect>
            </label>
          )}
        </div>
        {state.removed.map((removed) => (
          <input key={removed} type="hidden" name="x" value={removed} />
        ))}
      </form>
      <p id="ask-hint" className={styles.askHint}>
        Ask about the repository in plain words; press <kbd>/</kbd> to ask from anywhere.
      </p>
      {state.q === '' ? (
        <div className={styles.suggestions}>
          <span>Try</span>
          {props.suggestions.map((suggestion) => (
            <Link
              key={suggestion.q}
              className={styles.suggestion}
              href={askHref(base, { ...state, at: suggestion.at ?? state.at }, suggestion.q)}
            >
              {suggestion.q}
              {suggestion.at === undefined ? '' : ` (at ${formatClock(suggestion.at)})`}
            </Link>
          ))}
        </div>
      ) : null}
      <AskShortcut target={INPUT_ID} />
    </div>
  );
}

function AskGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 20 20"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
    >
      <path d="M4.5 15.5c3.2.9 7.6-.6 9.6-4.1 2-3.6.4-7.6-3.3-8.2C7.2 2.6 3.5 5.5 3.7 9.3c.1 1.6.8 2.9 1.9 3.8l-1.1 2.4Z" />
      <path d="M8 9.5h.01M11 9.5h.01" strokeWidth="2.2" />
    </svg>
  );
}

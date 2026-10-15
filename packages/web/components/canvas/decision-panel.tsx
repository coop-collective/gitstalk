'use client';

import { IntentLink as Link } from '../shell/intent-link';
import { useActionState, useId, useState } from 'react';

import type { DecisionState } from '../../src/server/actions';
import { decideCard } from '../../src/server/actions';
import type { DecisionCard } from '@gitstalk/shared-ask/race/race-state';
import { formatClock, plural } from '../../src/race/race-format';
import { RepoDiffSchema } from '../../src/repo/repo-schemas';
import type { RepoDiff } from '@gitstalk/shared-ask/repo/repo-types';
import { DiffView } from '../explorer/diff-view';
import { fetchJson } from '../../src/query/fetch-json';
import styles from './canvas.module.css';
import { ADMIN_DEMO_GATE, adminRunPath } from '../../src/admin/admin-paths';

export type DecisionAccess =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'off' }
  | { readonly kind: 'sign-in'; readonly next: string }
  | { readonly kind: 'allowed' };

/** The gateway keeps this much of a decision's wording. */
const MAX_DECISION_TEXT = 2000;

/**
 * Decision cards: when informed reworks keep failing against the same landed bean, the two
 * specs genuinely disagree and a person picks one. Open cards come first, with both specs,
 * the failing tests, both diffs, a line for the decision and a button per side.
 */
export function DecisionPanel(props: {
  readonly run: string;
  readonly cards: readonly DecisionCard[];
  readonly titles: Readonly<Record<string, string>>;
  readonly access: DecisionAccess;
}) {
  const cards = props.cards.toSorted(
    (a, b) => Number(b.status === 'open') - Number(a.status === 'open') || b.openedAt - a.openedAt,
  );
  if (cards.length === 0) {
    return (
      <p className={styles.legend}>
        No decision card yet. Cards appear when two specs genuinely disagree.
      </p>
    );
  }
  return (
    <div>
      {cards.map((card) => (
        <Card
          key={card.card}
          card={card}
          run={props.run}
          titles={props.titles}
          access={props.access}
        />
      ))}
    </div>
  );
}

function Card(props: {
  readonly card: DecisionCard;
  readonly run: string;
  readonly titles: Readonly<Record<string, string>>;
  readonly access: DecisionAccess;
}) {
  const { card } = props;
  const [state, action, pending] = useActionState<DecisionState, FormData>(decideCard, {
    kind: 'idle',
  });
  const textId = useId();
  const isOpen = card.status === 'open' && state.kind !== 'decided';
  const canDecide = isOpen && props.access.kind === 'allowed';
  const sides = [card.task, ...card.against];
  return (
    <section
      className={`${styles.decision} ${isOpen ? styles.decisionOpen : ''}`}
      aria-label={`Decision ${card.card}`}
    >
      <div className={styles.decisionHead}>
        <span className={styles.decisionTitle}>Decision {card.card}</span>
        <span className={styles.decisionText}>
          {isOpen ? 'waiting for a person' : decidedText(card, state)}, opened at{' '}
          {formatClock(card.openedAt)}
        </span>
      </div>
      <p className={styles.decisionText}>
        {card.task} keeps failing against {card.against.join(' and ')} after{' '}
        {plural(card.attempts, 'informed rework')}. These tests disagree:
      </p>
      <ul className={styles.failing}>
        {card.failing.slice(0, 4).map((test) => (
          <li key={test}>{test}</li>
        ))}
      </ul>
      <form action={action}>
        <input type="hidden" name="run" value={props.run} />
        <input type="hidden" name="card" value={card.card} />
        <div className={styles.sides}>
          {sides.map((bean) => (
            <Side
              key={bean}
              bean={bean}
              run={props.run}
              spec={card.specs[bean] ?? props.titles[bean] ?? bean}
              won={card.winner === bean || (state.kind === 'decided' && state.winner === bean)}
              button={isOpen ? { enabled: canDecide && !pending } : null}
            />
          ))}
        </div>
        {canDecide ? (
          <label htmlFor={textId} className={styles.decisionLine}>
            The decision in one line (optional): the losing bean&apos;s tests are amended to it
            <input
              id={textId}
              name="text"
              type="text"
              maxLength={MAX_DECISION_TEXT}
              className={styles.decisionInput}
              placeholder="Amounts show thousands separators everywhere, totals included."
            />
          </label>
        ) : null}
      </form>
      <Outcome card={card} />
      <Note access={props.access} isOpen={isOpen} state={state} />
    </section>
  );
}

function decidedText(card: DecisionCard, state: DecisionState): string {
  if (state.kind === 'decided') return `you kept ${state.winner}`;
  const by =
    card.oracle === 'landed' ? 'the race oracle (landed spec)' : (card.oracle ?? 'a person');
  return `decided by ${by}${card.decidedAt === null ? '' : ` at ${formatClock(card.decidedAt)}`}`;
}

/** v2.2: what deciding did: the wording, the outcome and the test author's amendment. */
function Outcome({ card }: { readonly card: DecisionCard }) {
  if (card.text === null && card.outcome === null && card.amendment === null) return null;
  return (
    <div className={styles.decisionText}>
      {card.text === null ? null : (
        <p className={styles.decisionQuote}>&ldquo;{card.text}&rdquo;</p>
      )}
      {card.outcome === null ? null : <p>{outcomeWords(card.outcome)}</p>}
      {card.amendment === null ? null : (
        <p>
          Test author: {card.amendment.status}
          {card.amendment.paths.length > 0 ? ` (${card.amendment.paths.join(', ')})` : ''}.
        </p>
      )}
    </div>
  );
}

function outcomeWords(outcome: string): string {
  if (outcome === 'adopt-in-place')
    return 'The arriving bean is adopted; the landed one is amended in place.';
  return 'The landed bean stays; the other re-executes under the decided spec.';
}

function Side(props: {
  readonly bean: string;
  readonly run: string;
  readonly spec: string;
  readonly won: boolean;
  readonly button: { readonly enabled: boolean } | null;
}) {
  return (
    <div className={`${styles.side} ${props.won ? styles.sideWon : ''}`}>
      <span>
        <Link className={styles.sideBean} href={`${adminRunPath(props.run)}?bean=${props.bean}`}>
          {props.bean}
        </Link>
        {props.won ? ' (kept)' : ''}
      </span>
      <span className={styles.sideSpec}>{props.spec}</span>
      <BeanDiff run={props.run} bean={props.bean} />
      {props.button === null ? null : (
        <button
          type="submit"
          name="winner"
          value={props.bean}
          className={styles.decide}
          disabled={!props.button.enabled}
        >
          Keep {props.bean}&apos;s spec
        </button>
      )}
    </div>
  );
}

function Note(props: {
  readonly access: DecisionAccess;
  readonly isOpen: boolean;
  readonly state: DecisionState;
}) {
  if (props.state.kind === 'refused') {
    return (
      <p className={styles.result} role="alert">
        {props.state.message}
      </p>
    );
  }
  if (props.state.kind === 'decided') {
    return (
      <p className={styles.result} role="status">
        Sent: {props.state.winner}&apos;s spec stands.
      </p>
    );
  }
  if (!props.isOpen) return null;
  switch (props.access.kind) {
    case 'recorded':
      return (
        <p className={styles.decisionNote}>
          A recorded run: in the race, an oracle answered for the person after 30 s.
        </p>
      );
    case 'off':
      return (
        <p className={styles.decisionNote}>Decisions are off here: no DEMO_PASSWORD is set.</p>
      );
    case 'sign-in':
      return (
        <p className={styles.decisionNote}>
          <Link href={`${ADMIN_DEMO_GATE}?next=${encodeURIComponent(props.access.next)}`}>
            Open the demo gate
          </Link>{' '}
          to decide.
        </p>
      );
    case 'allowed':
      return null;
    default:
      return null;
  }
}

/**
 * A bean's own diff, fetched when opened. The route names the bean, not its commit pair, so
 * the browser's copy is revalidated on every read (a 304 when the pair is unchanged), never
 * reused as it is.
 */
function BeanDiff({ run, bean }: { readonly run: string; readonly bean: string }) {
  const [diff, setDiff] = useState<RepoDiff | 'loading' | 'failed' | null>(null);
  const load = async () => {
    if (diff !== null) return;
    setDiff('loading');
    try {
      setDiff(
        await fetchJson(`/api/runs/${run}/beans/${bean}/diff`, isDiff, {
          httpCache: 'revalidate',
        }),
      );
    } catch {
      // Shown as a failure in the disclosure; the bean view in the explorer still has it.
      setDiff('failed');
    }
  };
  return (
    <details
      className={styles.sideDiff}
      onToggle={(event) => {
        // load() reports its own failure in the disclosure, so the promise needs no handler.
        if (event.currentTarget.open) void load();
      }}
    >
      <summary>Its diff</summary>
      <div className={styles.sideDiffBody}>
        {diff === 'loading' || diff === null ? <p className={styles.legend}>Loading…</p> : null}
        {diff === 'failed' ? <p className={styles.legend}>Could not load the diff.</p> : null}
        {typeof diff === 'object' && diff !== null ? <DiffView files={diff.files} /> : null}
      </div>
    </details>
  );
}

function isDiff(value: unknown): value is RepoDiff {
  return RepoDiffSchema.safeParse(value).success;
}

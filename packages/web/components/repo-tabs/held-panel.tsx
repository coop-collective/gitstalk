'use client';

/**
 * A bean the approval rules hold for a person (`docs/claude-opus/32-approval-rules.md` §5), on
 * its page: why it was held (its classes, the deciding rule, who decided and how sure), the
 * revision waiting and a link to its diff, the reviewers the policy names, and for the owner and
 * maintainers an Approve button with an optional note behind a confirm step. Everyone else reads
 * who can approve. Once approved it says who, when and that the pre-land check runs again; the
 * page's live queries carry the new state, so nothing reloads.
 */
import { useEffect, useRef, useState } from 'react';

import type { BeanApproval, BeanHold } from '@gitstalk/shared-race/bean-approval';

import type { ApproveAccess } from '../../src/changes/approval-client';
import type { RepoScope } from '../../src/changes/change-feed';
import { qk } from '../../src/query/keys';
import { useActionWithInvalidation } from '../../src/query/use-action-with-invalidation';
import { timeAgo } from '../../src/repositories/when';
import type { ApprovalState } from '../../src/server/approval-actions';
import { approveBeanAction } from '../../src/server/approval-actions';
import { Glyph } from './glyph';
import styles from './held-panel.module.css';

const IDLE: ApprovalState = { kind: 'idle' };

export function HeldPanel(props: {
  readonly hold: BeanHold;
  readonly bean: string;
  readonly scope: RepoScope;
  readonly access: ApproveAccess;
  /** Where the bean's diff is on the page. */
  readonly diffHref: string;
  /** Whether the bean has landed since (on the sprout or the stalk). */
  readonly landed: boolean;
  readonly nowMs: number;
}) {
  const { hold } = props;
  const keys = qk.repo(props.scope.uid, props.scope.owner, props.scope.repo);
  const [state, approve, isPending] = useActionWithInvalidation(approveBeanAction, IDLE, {
    isSuccess: (result) => result.kind === 'approved',
    invalidate: [keys.pushed(), keys.events()],
  });
  const approved = approvalShown(hold, state);
  const short = hold.revision.slice(0, 7);
  // The confirm button goes away with the approval: focus moves to the panel's new heading.
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (state.kind === 'approved') title.current?.focus();
  }, [state]);
  return (
    <section
      className={styles.panel}
      data-state={approved === null ? 'held' : 'approved'}
      aria-labelledby="held-title"
    >
      <header className={styles.head}>
        <Glyph kind={approved === null ? 'held' : 'stalk'} />
        <h2 id="held-title" ref={title} tabIndex={-1}>
          {approved === null ? 'Held for approval' : 'Approved'}
        </h2>
        <span className={styles.revision}>
          <span className={styles.mono}>{short}</span>
          <a href={props.diffHref}>See the diff</a>
        </span>
      </header>
      {approved === null ? (
        <p className={styles.lede}>
          The approval rules hold this revision until a person approves it. Nothing in it needs
          fixing for this.
        </p>
      ) : (
        <ApprovedLine
          approval={approved.approval}
          next={nextOf(approved, props.landed, short)}
          nowMs={props.nowMs}
        />
      )}
      <Why hold={hold} />
      {approved === null ? (
        <Action
          access={props.access}
          bean={props.bean}
          revision={hold.revision}
          approve={approve}
          isPending={isPending}
          refusal={state.kind === 'refused' ? state.message : null}
        />
      ) : null}
    </section>
  );
}

type Shown = { readonly approval: BeanApproval; readonly resubmitted: boolean };

/** The approval to show: the action's answer at once, then the live hold's. */
function approvalShown(hold: BeanHold, state: ApprovalState): Shown | null {
  if (state.kind === 'approved' && state.revision === hold.revision)
    return { approval: state.approval, resubmitted: state.resubmitted };
  if (hold.state === 'approved' && hold.approval !== null)
    return { approval: hold.approval, resubmitted: true };
  return null;
}

/** What happens after the approval, as the bean stands now. */
function nextOf(approved: Shown, landed: boolean, short: string): string {
  if (landed) return ' It passed its pre-land check and landed.';
  return approved.resubmitted
    ? ` The pre-land check runs again on ${short}; it lands if it passes.`
    : ' It lands at its next pre-land check.';
}

function ApprovedLine(props: {
  readonly approval: BeanApproval;
  readonly next: string;
  readonly nowMs: number;
}) {
  const { approval } = props;
  return (
    <div className={styles.approved} role="status">
      <p>
        Approved by <strong>@{approval.by}</strong>{' '}
        <time dateTime={approval.at}>{timeAgo(approval.at, props.nowMs)}</time>
        {approval.client === 'web' ? ' on the web' : ` through ${approval.client}`}.{props.next}
      </p>
      {approval.note === null ? null : <blockquote>{approval.note}</blockquote>}
    </div>
  );
}

function Why(props: { readonly hold: BeanHold }) {
  const { hold } = props;
  return (
    <dl className={styles.why}>
      <div>
        <dt>Classes</dt>
        <dd className={styles.classes}>
          {hold.classes.map((name) => (
            <span
              key={name}
              className={styles.chip}
              data-deciding={name === hold.class ? '' : undefined}
            >
              {name}
            </span>
          ))}
        </dd>
      </div>
      <div>
        <dt>Rule</dt>
        <dd>
          {hold.class === null ? (
            'its classes'
          ) : (
            <>
              class <code>{hold.class}</code>
            </>
          )}{' '}
          in <code>{hold.policy.path ?? '.gitstalk/policy.yml'}</code>
          {hold.policy.sha === null ? null : (
            <>
              {' '}
              at <span className={styles.mono}>{hold.policy.sha.slice(0, 7)}</span>
            </>
          )}
        </dd>
      </div>
      <div>
        <dt>Decided by</dt>
        <dd>{decidedBy(hold)}</dd>
      </div>
      <div>
        <dt>Reviewers</dt>
        <dd>
          {hold.reviewers.length === 0
            ? 'None named in the policy.'
            : `${hold.reviewers.join(', ')} (named, not required: any maintainer approves)`}
        </dd>
      </div>
    </dl>
  );
}

function decidedBy(hold: BeanHold): string {
  switch (hold.by) {
    case 'policy':
      return 'The policy: this class always asks a person.';
    case 'clef':
      return `Clef, triaging the class${hold.probability === null ? '' : ` (p=${hold.probability.toFixed(2)})`}.`;
    case 'rules':
      return 'The triage rule, as Clef did not answer in time.';
    default:
      return hold.by;
  }
}

function Action(props: {
  readonly access: ApproveAccess;
  readonly bean: string;
  readonly revision: string;
  readonly approve: (form: FormData) => void;
  readonly isPending: boolean;
  readonly refusal: string | null;
}) {
  const { access } = props;
  const [isConfirming, setConfirming] = useState(false);
  const [attempt, setAttempt] = useState('');
  const confirmRef = useRef<HTMLButtonElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (isConfirming) confirmRef.current?.focus();
    else if (wasConfirming.current) startRef.current?.focus();
    wasConfirming.current = isConfirming;
  }, [isConfirming]);
  if (access.kind === 'read-only') return <p className={styles.readOnly}>{access.reason}</p>;
  const short = props.revision.slice(0, 7);
  return (
    <form className={styles.action} action={props.approve}>
      <input type="hidden" name="csrf" value={access.csrf} />
      <input type="hidden" name="owner" value={access.owner} />
      <input type="hidden" name="name" value={access.name} />
      <input type="hidden" name="bean" value={props.bean} />
      <input type="hidden" name="revision" value={props.revision} />
      <input type="hidden" name="idempotencyKey" value={attempt} />
      <label className={styles.note}>
        <span>Note for the record (optional)</span>
        <textarea name="note" rows={2} maxLength={500} placeholder="What you checked" />
      </label>
      {isConfirming ? (
        <div className={styles.confirm} role="group" aria-labelledby="approve-confirm">
          <p id="approve-confirm">
            Approve <span className={styles.mono}>{short}</span>? Its pre-land check runs again and
            it lands on the sprout if it passes. A later push needs a new approval.
          </p>
          <div className={styles.buttons}>
            <button
              ref={confirmRef}
              type="submit"
              className={styles.primary}
              disabled={props.isPending}
            >
              {props.isPending ? 'Approving…' : `Approve ${short}`}
            </button>
            <button
              type="button"
              className={styles.button}
              onClick={() => setConfirming(false)}
              disabled={props.isPending}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.buttons}>
          <button
            ref={startRef}
            type="button"
            className={styles.primary}
            aria-label={`Approve revision ${short} of ${props.bean}`}
            onClick={() => {
              setAttempt(crypto.randomUUID());
              setConfirming(true);
            }}
          >
            Approve
          </button>
        </div>
      )}
      {props.refusal === null ? null : (
        <p className={styles.refusal} role="status">
          {props.refusal}
        </p>
      )}
    </form>
  );
}

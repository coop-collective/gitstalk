'use client';

/**
 * Home's live half (`docs/claude-opus/16` item 1.6): the person's connected agent sessions,
 * asked for every 3 s until one connects (so a session signed in from a terminal shows up
 * within seconds) and every 30 s after, only while the tab is visible; and the first-visit
 * checklist, which ticks "connect" from the same query. The server renders both with the
 * sessions it read (`initial`), so the first paint needs no request.
 */
import { useQuery } from '@tanstack/react-query';
import { IntentLink as Link } from '../shell/intent-link';
import type { ReactNode } from 'react';

import type { FirstStepId } from '../../src/home/first-steps';
import { firstSteps, isStarted, sessionsPollMs } from '../../src/home/first-steps';
import type { ConnectedSession } from '../../src/home/sessions-answer';
import { isSessionsAnswer } from '../../src/home/sessions-answer';
import { fetchJson } from '../../src/query/fetch-json';
import { qk } from '../../src/query/keys';
import { timeAgo } from '../../src/repositories/when';
import styles from './repository.module.css';

/** The sessions the server rendered with, and when it read them. */
export type SessionsSeed = {
  readonly userId: string;
  /** Null: the list could not be read; the query retries. */
  readonly sessions: readonly ConnectedSession[] | null;
  readonly readAtMs: number;
};

type SessionsPolling = 'poll' | 'read-only';

function useSessions(seed: SessionsSeed, polling: SessionsPolling) {
  return useQuery<readonly ConnectedSession[] | null>({
    queryKey: qk.viewer(seed.userId).sessions(),
    queryFn: async ({ signal }) =>
      (await fetchJson('/api/sessions', isSessionsAnswer, { signal })).sessions,
    initialData: seed.sessions,
    initialDataUpdatedAt: seed.readAtMs,
    // Background tabs do not poll (refetchIntervalInBackground stays false). One observer
    // polls; the other only reads what it fetched.
    refetchInterval: polling === 'poll' ? (query) => sessionsPollMs(query.state.data ?? []) : false,
    enabled: polling === 'poll',
  });
}

/** The three first steps, until all are done. */
export function FirstSteps(props: {
  readonly seed: SessionsSeed;
  readonly repositories: number;
  readonly repositoriesWithBeans: number;
}) {
  const { data: sessions } = useSessions(props.seed, 'read-only');
  const steps = firstSteps({
    sessions: sessions?.length ?? 0,
    repositories: props.repositories,
    repositoriesWithBeans: props.repositoriesWithBeans,
  });
  if (isStarted(steps)) return null;
  const done = steps.filter((step) => step.done).length;
  return (
    <section className={styles.panel} aria-labelledby="steps-title">
      <div className={styles.panelHead}>
        <h2 id="steps-title">Get started</h2>
        <span className={styles.muted}>{done} of 3 done</span>
      </div>
      <ol className={styles.steps}>
        {steps.map((step) => (
          <li key={step.id} className={step.done ? styles.stepDone : undefined}>
            <span className={styles.stepMark} aria-hidden="true">
              {step.done ? '✓' : ''}
            </span>
            <div>
              {STEP_TEXT[step.id]}
              {step.done ? <span className="visually-hidden"> (done)</span> : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

const STEP_TEXT: Readonly<Record<FirstStepId, ReactNode>> = {
  connect: (
    <>
      <strong>Connect an agent session.</strong> Paste one command into Claude Code or Codex and
      approve it in the browser. <Link href="/signup/agent">Connect an agent</Link>
    </>
  ),
  repository: (
    <>
      <strong>Create or import a repository.</strong> The TypeScript starter has a check every bean
      must pass. <Link href="/new">New repository</Link>
    </>
  ),
  bean: (
    <>
      <strong>Push a first bean.</strong> Ask your agent for a change, or push a{' '}
      <code>bean/&lt;name&gt;</code> branch yourself; it lands when its check is green.
    </>
  ),
};

/** "Your sessions": each connected agent, newest first. */
export function SessionsPanel({ seed }: { readonly seed: SessionsSeed }) {
  const { data: sessions, dataUpdatedAt } = useSessions(seed, 'poll');
  return (
    <section className={styles.panel} aria-labelledby="sessions-title">
      <div className={styles.panelHead}>
        <h2 id="sessions-title">Your sessions</h2>
        <Link href="/signup/agent" className={styles.muted}>
          Connect another
        </Link>
      </div>
      <SessionList sessions={sessions ?? null} nowMs={dataUpdatedAt} />
    </section>
  );
}

function SessionList({
  sessions,
  nowMs,
}: {
  readonly sessions: readonly ConnectedSession[] | null;
  readonly nowMs: number;
}) {
  if (sessions === null)
    return (
      <p className={styles.empty}>Sessions could not be loaded; this list retries by itself.</p>
    );
  if (sessions.length === 0)
    return (
      <p className={styles.empty} aria-live="polite">
        No agent connected yet. <Link href="/signup/agent">Connect Claude Code or Codex</Link>; it
        shows up here as soon as you approve it.
      </p>
    );
  return (
    <ul className={styles.repoList} aria-live="polite">
      {sessions.map((session) => (
        <li key={session.grantId} className={styles.sessionRow}>
          <span className={styles.sessionDot} aria-hidden="true" />
          <div>
            <span className={styles.sessionName}>{session.clientName}</span>
            <p className={styles.repoMeta}>
              {session.settling === true ? 'connecting' : 'connected'}{' '}
              {timeAgo(new Date(session.createdAt).toISOString(), nowMs)} ·{' '}
              {session.scopes.join(', ')}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

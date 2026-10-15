import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { BeanHold } from '@gitstalk/shared-race/bean-approval';
import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';

import type { PushedBean } from './pushed-beans';
import { qk } from '../query/keys';
import { GREETER_EVENTS, GREETER_PUSHED } from './testing/greeter';
import {
  APPROVAL,
  BEAN,
  FIRST,
  HOLD,
  approvedEvents,
  heldEvents,
  pushedLogin,
} from './testing/held-bean';

/**
 * A held bean's page and list row as they render (to markup; the approve action and the
 * intent link are replaced): the journey's held step wears the held panel's violet mark and
 * never says red or sent back; an approval reads with who, the note and the check again.
 */
vi.mock('../server/approval-actions', () => ({ approveBeanAction: () => ({ kind: 'idle' }) }));
vi.mock('../../components/shell/intent-link', () => ({
  IntentLink: (props: Record<string, unknown>) => createElement('a', props),
}));

const { ChangeView } = await import('../../components/repo-tabs/change-view');
const { ChangesList } = await import('../../components/repo-tabs/changes-list');

const SCOPE = {
  uid: 'u1',
  owner: 'coop',
  repo: 'greeter',
  base: '/coop/greeter',
  visibility: 'public' as const,
};
const NOW = Date.parse('2026-10-14T12:05:00.000Z');
const HELD: BeanHold = {
  ...HOLD,
  classes: [...HOLD.classes],
  state: 'held',
  revision: FIRST,
  probability: null,
  reviewers: [],
  policy: { path: '.gitstalk/policy.yml', sha: null },
  approval: null,
};

describe('the bean page’s journey', () => {
  it('shows a hold as a violet held step, with no red check and nothing sent back', () => {
    const html = beanPage(heldEvents(), [pushedLogin({ hold: HELD })], BEAN);
    const journey = journeyOf(html);
    expect(journey).toContain('data-tone="held"');
    expect(journey).toContain('aria-label="held for a person’s approval"');
    expect(journey).toContain('Held for approval: class auth, decided by the policy.');
    expect(journey).toContain('classes: auth, tests-only');
    expect(journey).not.toMatch(/Pre-land check red|Sent back|data-tone="bad"|data-tone="rework"/u);
    expect(html).toContain('Nothing in it needs');
  });

  it('shows who approved, their note, the check again and its real result', () => {
    const pushed = pushedLogin({ phase: 'green', pushes: 2, approvals: [APPROVAL] });
    const journey = journeyOf(beanPage(approvedEvents(), [pushed], BEAN));
    expect(journey).toContain('Approved by @dana on the web');
    expect(journey).toContain('<li>Read the session change.</li>');
    expect(journey).toContain(`Checking ${FIRST.slice(0, 7)} again`);
    expect(journey).toContain('Pre-land check green on the merged tree (4.2 s)');
    expect(journey).toContain('data-tone="approved"');
    expect(journey).toMatch(/Journey<\/span><span[^>]*>1 push<\/span>/u);
  });

  it('keeps an ordinary red bean red and sent back', () => {
    const journey = journeyOf(beanPage(GREETER_EVENTS, GREETER_PUSHED, 'shout'));
    expect(journey).toContain('Pre-land check red: 1 failing test');
    expect(journey).toContain('Sent back to @coop to fix and push again');
    expect(journey).not.toContain('data-tone="held"');
  });
});

describe('the Changes list row of a held bean', () => {
  it('says it waits for an approval and nothing needs fixing, with no failing test', () => {
    const html = changesList(heldEvents(), [pushedLogin({})]);
    expect(html).toContain('data-state="held">held for approval</span>');
    expect(html).toContain(`Waits for an owner or maintainer to approve`);
    expect(html).toContain('Nothing in it needs fixing.');
    expect(html).not.toContain('awaits approval by a person');
    expect(html).not.toContain('Why it is red');
  });
});

function journeyOf(html: string): string {
  const start = html.indexOf('aria-label="Journey"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</section>', start));
}

function beanPage(
  events: readonly RaceEvent[],
  pushed: readonly PushedBean[],
  bean: string,
): string {
  return render(
    events,
    pushed,
    createElement(ChangeView, {
      scope: SCOPE,
      bean,
      diff: null,
      filesHref: `/coop/greeter/tree/bean/${bean}`,
      settled: true,
      approveAccess: { kind: 'read-only', reason: 'Sign in to approve it.' },
      nowMs: NOW,
    }),
  );
}

function changesList(events: readonly RaceEvent[], pushed: readonly PushedBean[]): string {
  return render(
    events,
    pushed,
    createElement(ChangesList, { scope: SCOPE, show: 'held', nowMs: NOW }),
  );
}

function render(
  events: readonly RaceEvent[],
  pushed: readonly PushedBean[],
  page: ReturnType<typeof createElement>,
): string {
  const queryClient = new QueryClient();
  const keys = qk.repo(SCOPE.uid, SCOPE.owner, SCOPE.repo);
  queryClient.setQueryData(keys.events(), events);
  queryClient.setQueryData(keys.pushed(), pushed);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient }, page));
}

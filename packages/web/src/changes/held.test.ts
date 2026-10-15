import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { BeanHold } from '@gitstalk/shared-race/bean-approval';

import type { ApproveAccess } from './approval-client';
import { approveAccessOf } from './approval-client';
import { changesOf, groupCounts, inGroup, shownGroup, stateText } from './changes';
import type { PushedBean } from './pushed-beans';
import { qk } from '../query/keys';
import type { RepositoryRecord, ViewerRole } from '../repositories/registry-client';
import { GREETER_EVENTS, GREETER_PUSHED } from './testing/greeter';

/**
 * Held beans in the web: the Changes model (state, the Held filter), who may press Approve, and
 * the bean page's Held panel as each viewer sees it (rendered to markup; the server action is
 * replaced, as the panel only hands it the form).
 */
vi.mock('../server/approval-actions', () => ({ approveBeanAction: () => ({ kind: 'idle' }) }));
vi.mock('../../components/shell/intent-link', () => ({
  IntentLink: (props: Record<string, unknown>) => createElement('a', props),
}));

const { HeldPanel } = await import('../../components/repo-tabs/held-panel');
const { ChangesList } = await import('../../components/repo-tabs/changes-list');

const HEAD = 'a8c8ab782a7c7281f05cb47a8b1722610ccb60d4';
const HELD: BeanHold = {
  state: 'held',
  revision: HEAD,
  classes: ['protected', 'tests-only'],
  class: 'protected',
  by: 'clef',
  probability: 0.81,
  reviewers: ['@dana'],
  policy: { path: '.gitstalk/policy.yml', sha: 'c'.repeat(40) },
  approval: null,
};

function withHold(hold: BeanHold | null): readonly PushedBean[] {
  return GREETER_PUSHED.map((bean) =>
    bean.bean === 'shout' ? Object.assign({}, bean, { hold }) : bean,
  );
}

describe('a held bean in the Changes list', () => {
  it('reads as held for approval, open, and in the Held filter', () => {
    const changes = changesOf(GREETER_EVENTS, withHold(HELD));
    const shout = changes.find((change) => change.bean === 'shout');
    expect(shout).toMatchObject({ state: 'held', group: 'open', hold: HELD });
    expect(stateText('held')).toBe('held for approval');
    expect(groupCounts(changes)).toMatchObject({ open: 1, held: 1 });
    expect(inGroup(changes, 'held').map((change) => change.bean)).toEqual(['shout']);
    expect(shownGroup('held', changes)).toBe('held');
  });

  it('is red again, not held, once approved (its check runs again)', () => {
    const approved: BeanHold = {
      ...HELD,
      state: 'approved',
      approval: { by: 'dana', at: '2026-10-14T12:00:00.000Z', note: null, client: 'web' },
    };
    const shout = changesOf(GREETER_EVENTS, withHold(approved)).find(
      (change) => change.bean === 'shout',
    );
    expect(shout?.state).toBe('red');
    expect(groupCounts(changesOf(GREETER_EVENTS, withHold(approved))).held).toBe(0);
  });
});

function access(role: ViewerRole | null, csrf: string | null = 'csrf-1'): ApproveAccess {
  return approveAccessOf({ record: fullRecord(), role, csrf });
}

describe('who may press Approve', () => {
  it('the owner and maintainers, signed in', () => {
    expect(access('owner')).toEqual({
      kind: 'allowed',
      csrf: 'csrf-1',
      owner: 'coop',
      name: 'greeter',
    });
    expect(access('maintain').kind).toBe('allowed');
  });

  it('nobody else, each told who can', () => {
    expect(access('write')).toEqual({
      kind: 'read-only',
      reason: 'The owner and maintainers approve it; you have the write role.',
    });
    expect(access(null, null)).toMatchObject({
      kind: 'read-only',
      reason: expect.stringContaining('Sign in'),
    });
    const archived = approveAccessOf({
      record: { ...fullRecord(), archived_at: '2026-10-01T00:00:00.000Z' },
      role: 'owner',
      csrf: 'csrf-1',
    });
    expect(archived.kind).toBe('read-only');
  });
});

describe('the Held panel', () => {
  it('shows a maintainer why, the revision, the reviewers and an Approve button', () => {
    const html = panel(access('maintain'));
    expect(html).toContain('Held for approval');
    expect(html).toContain('a8c8ab7');
    expect(html).toContain('href="#bean-diff"');
    expect(html).toContain('protected');
    expect(html).toContain('Clef, triaging the class (p=0.81)');
    expect(html).toContain('@dana (named, not required: any maintainer approves)');
    expect(html).toContain('aria-label="Approve revision a8c8ab7 of shout"');
    expect(html).toContain('name="csrf" value="csrf-1"');
    expect(html).toContain(`name="revision" value="${HEAD}"`);
  });

  it('shows a reader who can approve, and no form', () => {
    const html = panel(access('read'));
    expect(html).toContain('The owner and maintainers approve it; you have the read role.');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('Approve revision');
  });

  it('says who approved and that the check runs again', () => {
    const html = panel(access('maintain'), {
      ...HELD,
      state: 'approved',
      approval: {
        by: 'dana',
        at: '2026-10-14T12:00:00.000Z',
        note: 'Read it.',
        client: 'MCP (Claude Code)',
      },
    });
    expect(html).toContain('Approved by <strong>@dana</strong>');
    expect(html).toContain('through MCP (Claude Code)');
    expect(html).toContain('The pre-land check runs again on a8c8ab7');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('<form');
  });
});

function panel(viewer: ApproveAccess, hold: BeanHold = HELD): string {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(HeldPanel, {
        hold,
        bean: 'shout',
        scope: {
          uid: 'u1',
          owner: 'coop',
          repo: 'greeter',
          base: '/coop/greeter',
          visibility: 'public' as const,
        },
        access: viewer,
        diffHref: '#bean-diff',
        landed: false,
        nowMs: Date.parse('2026-10-14T12:05:00.000Z'),
      }),
    ),
  );
}

function fullRecord(): RepositoryRecord {
  return {
    id: 'r1',
    name: 'greeter',
    owner: { id: 'u1', handle: 'coop' },
    owner_kind: 'user',
    description: '',
    visibility: 'private',
    origin: { kind: 'empty' },
    artifacts_repo: 'repo-greeter',
    engine_id: 'e1',
    default_branch: 'main',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    archived_at: null,
    website: '',
    topics: [],
    social_image_key: null,
  };
}

describe('the Changes list', () => {
  it('badges a held bean and offers the Held filter with its count', () => {
    const html = changesList('open');
    expect(html).toContain('data-state="held">held for approval</span>');
    expect(html).toContain('Waits for an owner or maintainer to approve');
    expect(html).toContain('href="/coop/greeter/changes?show=held"');
    expect(html).toMatch(/data-filter="held"[^>]*>Held<span[^>]*>1<\/span>/u);
  });

  it('shows only held beans under Held', () => {
    const html = changesList('held');
    expect(html).toContain('Shout greetings in capitals');
    expect(html).not.toContain('Add truncate for long titles');
  });
});

function changesList(show: string): string {
  const queryClient = new QueryClient();
  const scope = {
    uid: 'u1',
    owner: 'coop',
    repo: 'greeter',
    base: '/coop/greeter',
    visibility: 'public' as const,
  };
  const keys = qk.repo(scope.uid, scope.owner, scope.repo);
  queryClient.setQueryData(keys.events(), GREETER_EVENTS);
  queryClient.setQueryData(keys.pushed(), withHold(HELD));
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ChangesList, { scope, show, nowMs: Date.parse('2026-10-14T12:05:00.000Z') }),
    ),
  );
}

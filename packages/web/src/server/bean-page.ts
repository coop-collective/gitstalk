/**
 * The start of a bean's page (`changes/[bean]`): the repository's engine tab and the bean as
 * the event log and the pushed beans tell it, or a 404 when there is no such bean. The bean's
 * layout asks first, so the 404 is the response's status; the page asks again (memoised per
 * request) and streams the heavy part, the bean's diff, under a Suspense boundary. Server-only.
 */
import { notFound } from 'next/navigation';

import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';

import type { Change } from '../changes/changes';
import { changesOf } from '../changes/changes';
import type { PushedBean } from '../changes/pushed-beans';
import type { EngineTab } from './repository-tab';
import { engineTab } from './repository-tab';
import { keyedForRequest } from './request-memo';

export type BeanParams = Promise<{
  readonly owner: string;
  readonly repo: string;
  readonly bean: string;
}>;

export type BeanPage = {
  readonly tab: EngineTab;
  /** The bean's name, decoded. */
  readonly name: string;
  readonly change: Change;
  /** Every bean of the repository, for the Changes tab's count. */
  readonly changes: readonly Change[];
  readonly events: readonly RaceEvent[];
  readonly pushed: readonly PushedBean[];
};

const beanPages = keyedForRequest<BeanPage>();

/** The bean at `params`, read once per request; Next's not-found when there is none. */
export async function beanPage(params: BeanParams): Promise<BeanPage> {
  const { owner, repo, bean } = await params;
  return beanPages(`${owner}/${repo}/${bean}`, () => openBean(params, decodeURIComponent(bean)));
}

/**
 * The event log and the pushed beans are the proof: a bean started but never pushed is only in
 * the log, and its journey needs both anyway (the log of a public repository is shared across
 * requests). The diff, two reads in a row, is left to the page's stream.
 */
async function openBean(params: BeanParams, name: string): Promise<BeanPage> {
  const tab = await engineTab(params);
  const [events, pushed] = await Promise.all([tab.reads.events(), tab.reads.pushed()]);
  const changes = changesOf(events, pushed);
  const change = changes.find((candidate) => candidate.bean === name);
  if (change === undefined) notFound();
  return { tab, name, change, changes, events, pushed };
}

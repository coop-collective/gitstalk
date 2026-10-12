/**
 * The start of a run's page (`actions/runs/[run]`, `automations/runs/[run]`): the Actions page
 * and the run, or a 404 when this repository has no such run. The run's layout asks first, so
 * the 404 is the response's status and nothing streams before it; the page asks again (memoised
 * per request, no second read) and streams the heavy part, the chosen job's stored log, under a
 * Suspense boundary. Server-only.
 */
import { notFound } from 'next/navigation';

import type { ActionsClient } from '../actions/actions-client';
import type { RunDetail } from '../actions/actions-contract';
import type { ActionsPage } from './actions-page';
import { actionsPage } from './actions-page';
import { keyedForRequest } from './request-memo';

export type RunParams = Promise<{
  readonly owner: string;
  readonly repo: string;
  readonly run: string;
}>;

/** A run's page: the run with its client, or `run: null` when no control plane answers here. */
export type RunPage =
  | { readonly page: ActionsPage; readonly actions: ActionsClient; readonly run: RunDetail }
  | { readonly page: ActionsPage; readonly actions: null; readonly run: null };

const runPages = keyedForRequest<RunPage>();

/** The run at `params` for this viewer, read once per request; Next's not-found when there is none. */
export async function runPage(params: RunParams): Promise<RunPage> {
  const { owner, repo, run } = await params;
  return runPages(`${owner}/${repo}/${run}`, () => openRun(params, decodeURIComponent(run)));
}

async function openRun(params: RunParams, runId: string): Promise<RunPage> {
  const page = await actionsPage(params);
  if (page.actions === null) return { page, actions: null, run: null };
  // One read proves the run is this repository's (the client checks its repository id) and is
  // the run the page shows: its graph, facts, annotations and summary.
  const run = await page.actions.run(runId);
  if (!run.ok) notFound();
  return { page, actions: page.actions, run: run.value };
}

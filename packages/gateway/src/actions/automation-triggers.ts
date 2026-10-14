/**
 * Which automations a repository event starts (doc 25 §7.2). Each `repo-events` event maps to
 * one Gitstalk event name; an automation fires when its `on:` names that event and its
 * `beans:` and `authors:` filters (GitHub's glob rules) select the event's bean and pusher, and
 * its `paths:` filter (landings and reverts only) selects one of the commit's files. An
 * automation never fires on its own beans, so a fix it pushes cannot loop back into it.
 */
import type { GitstalkEvent, WorkflowTrigger } from '@gitstalk/shared-race/actions';
import type { RepoEvent } from '@gitstalk/shared-race/repo-events';

import { assertNever } from '../engine/errors';
import type { RepoFacts } from './event-payload';
import { repositoryPayload } from './event-payload';
import { selectedBy } from './filter-pattern';

/** A repository event as automations see it. */
export type Occurrence = {
  readonly event: GitstalkEvent;
  readonly seq: number;
  readonly at: string;
  /** The bean it is about, when there is one. */
  readonly bean: string | null;
  /** Who pushed that bean (or answered the card), when known. */
  readonly actor: string | null;
  /** The commit it names (a landing, a stalk head, a red sprout), when there is one. */
  readonly sha: string | null;
  /** The event as the engine sent it, for the run's payload. */
  readonly detail: RepoEvent;
  /**
   * The files the commit changed, read only when an automation filters this event by
   * `paths:`; null when not read or unknown (then a `paths:` filter lets it through).
   */
  readonly changedPaths: readonly string[] | null;
};

/** The Gitstalk event a repository event is, with its bean, actor and commit. */
export function occurrenceOf(event: RepoEvent): Occurrence {
  const base = { seq: event.seq, at: event.at, detail: event, changedPaths: null };
  switch (event.kind) {
    case 'bean.opened':
      return { ...base, event: 'bean_opened', bean: event.bean, actor: event.actor, sha: null };
    case 'bean.landed':
      return {
        ...base,
        event: 'bean_landed',
        bean: event.bean,
        actor: event.actor,
        sha: event.sha,
      };
    case 'bean.rework':
      return { ...base, event: 'bean_red', bean: event.bean, actor: null, sha: null };
    case 'bean.ended':
      return {
        ...base,
        event: event.outcome === 'parked' ? 'bean_parked' : 'bean_dropped',
        bean: event.bean,
        actor: null,
        sha: null,
      };
    case 'bean.reverted':
      return { ...base, event: 'bean_reverted', bean: event.bean, actor: null, sha: event.sha };
    case 'stalk.promoted':
      return { ...base, event: 'stalk_moved', bean: null, actor: null, sha: event.sha };
    case 'stalk.demoted':
      return { ...base, event: 'stalk_reset', bean: null, actor: null, sha: event.sha };
    case 'sprout.red':
      return { ...base, event: 'validation_red', bean: null, actor: null, sha: event.sha };
    case 'decision.asked':
      return { ...base, event: 'decision_opened', bean: event.bean, actor: null, sha: null };
    case 'decision.made':
      return {
        ...base,
        event: 'decision_decided',
        bean: event.winner,
        actor: event.by.startsWith('human:') ? event.by.slice('human:'.length) : null,
        sha: null,
      };
    default:
      return assertNever(event);
  }
}

/** Whether an automation with `triggers`, acting as `actor`, fires for `occurrence`. */
export function automationFires(
  triggers: readonly WorkflowTrigger[],
  occurrence: Occurrence,
  actor: string,
): boolean {
  if (occurrence.actor === actor) return false;
  return triggers.some(
    (trigger) =>
      trigger.kind === 'beanstalk' &&
      trigger.event === occurrence.event &&
      (trigger.beans.length === 0 ||
        (occurrence.bean !== null && selectedBy(trigger.beans, occurrence.bean))) &&
      (trigger.authors.length === 0 ||
        (occurrence.actor !== null && selectedBy(trigger.authors, occurrence.actor))) &&
      touchesPaths(trigger.paths, occurrence.changedPaths),
  );
}

/** Whether any automation's trigger for this event filters it by the files it changed. */
export function needsChangedPaths(
  automations: readonly (readonly WorkflowTrigger[])[],
  occurrence: Occurrence,
): boolean {
  return (
    occurrence.sha !== null &&
    automations.some((triggers) =>
      triggers.some(
        (trigger) =>
          trigger.kind === 'beanstalk' &&
          trigger.event === occurrence.event &&
          (trigger.paths?.length ?? 0) > 0,
      ),
    )
  );
}

/** A `paths:` filter selects one changed file; with no filter, or files unknown, it passes. */
function touchesPaths(
  paths: readonly string[] | undefined,
  changedPaths: readonly string[] | null,
): boolean {
  if (paths === undefined || paths.length === 0 || changedPaths === null) return true;
  return changedPaths.some((path) => selectedBy(paths, path));
}

/**
 * The run's event payload (`$GITHUB_EVENT_PATH`): the Gitstalk event, its bean, actor and
 * commit, and the repository in GitHub's shape. All of it is untrusted data (doc 25 §7.6).
 */
export function occurrencePayload(input: {
  readonly repo: RepoFacts;
  readonly publicUrl: string;
  readonly occurrence: Occurrence;
}): Readonly<Record<string, unknown>> {
  const { repo, occurrence } = input;
  const detail = Object.fromEntries(
    Object.entries(occurrence.detail).filter(([key]) => key !== 'seq'),
  );
  const event = {
    event: occurrence.event,
    ...(occurrence.changedPaths === null ? {} : { changed_paths: occurrence.changedPaths }),
    at: occurrence.at,
    bean: occurrence.bean,
    bean_ref: occurrence.bean === null ? null : `refs/heads/bean/${occurrence.bean}`,
    actor: occurrence.actor,
    sha: occurrence.sha,
    detail,
  };
  // `gitstalk` is the documented key; `beanstalk` repeats it for automations written before the
  // rename (2026-10-10).
  return {
    action: occurrence.event,
    gitstalk: event,
    beanstalk: event,
    repository: repositoryPayload(repo, input.publicUrl),
    sender: { login: occurrence.actor ?? 'gitstalk' },
  };
}

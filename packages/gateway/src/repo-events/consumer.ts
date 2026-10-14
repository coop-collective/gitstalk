/**
 * The `repo-events` consumer: each message is validated, its engine looked up in the
 * registry, and its events written to the D1 indexes. A message that is not a repository
 * event, or whose engine drives no registered repository (a deleted one, an engine opened
 * by the admin route), is acknowledged and dropped; a failed write is retried by the queue.
 */
import type { RepoEvent } from '@gitstalk/shared-race/repo-events';
import { RepoEventsMessage } from '@gitstalk/shared-race/repo-events';

import type { RepoEventsForAutomations, StalkMoved } from '../actions/repo-do';
import type { Logger } from '../log';
import type { Registry } from '../repos/registry';
import { applyRepoEvents } from './index-store';

export type ConsumerDeps = {
  readonly db: D1Database;
  /** Told of each `stalk.promoted` once indexed (Actions' `push`); a failure retries the message. */
  readonly stalkMoved?: (move: StalkMoved) => Promise<void>;
  /** Told of every event once indexed, for the automations they trigger (doc 25 §7.2). */
  readonly repoEvents?: (input: RepoEventsForAutomations) => Promise<void>;
  /**
   * Told of every indexed batch, with the repository's Artifacts repo, for derived history
   * (`derive/`). Fire and forget: derived history catches up on its own reads, so its
   * failures never retry the message.
   */
  readonly derived?: (input: DerivedFeed) => void;
  readonly registry: Pick<Registry, 'byEngine'>;
  readonly log: Logger;
};

/** One engine's indexed events, for derived history. */
export type DerivedFeed = {
  readonly engine: string;
  readonly repo: string;
  readonly events: readonly RepoEvent[];
};

type Owner = { id: string; ownerId: string; artifactsRepo: string };

/** Handles one batch; every message is acked or retried on its own. */
export async function consumeRepoEvents(batch: MessageBatch, deps: ConsumerDeps): Promise<void> {
  const owners = new Map<string, Promise<Owner | null>>();
  const ownerOf = (engine: string) => {
    const known = owners.get(engine);
    if (known !== undefined) return known;
    const found = deps.registry
      .byEngine(engine)
      .then((record) =>
        record === null
          ? null
          : { id: record.id, ownerId: record.owner.id, artifactsRepo: record.artifacts_repo },
      );
    owners.set(engine, found);
    return found;
  };
  // Messages of different engines are independent; one engine's go in order.
  const byEngine = new Map<string, Message[]>();
  for (const message of batch.messages) {
    const parsed = RepoEventsMessage.safeParse(message.body);
    if (!parsed.success) {
      deps.log.warn('repo event message dropped: not a repository event', { id: message.id });
      message.ack();
      continue;
    }
    byEngine.set(parsed.data.engine, [...(byEngine.get(parsed.data.engine) ?? []), message]);
  }
  await Promise.all(
    [...byEngine].map(([engine, messages]) => applyInOrder(engine, messages, { deps, ownerOf })),
  );
}

async function applyInOrder(
  engine: string,
  messages: readonly Message[],
  context: {
    readonly deps: ConsumerDeps;
    readonly ownerOf: (engine: string) => Promise<Owner | null>;
  },
): Promise<void> {
  const { deps } = context;
  let repo: Owner | null;
  try {
    repo = await context.ownerOf(engine);
  } catch (error: unknown) {
    deps.log.error('repo events: registry lookup failed', { engine, error });
    for (const message of messages) message.retry();
    return;
  }
  for (const message of messages) {
    const parsed = RepoEventsMessage.parse(message.body);
    if (repo === null) {
      message.ack();
      continue;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- one engine's messages apply in order
      await applyRepoEvents(
        deps.db,
        { id: repo.id, ownerId: repo.ownerId, engineId: engine },
        parsed.events,
      );
      // oxlint-disable-next-line no-await-in-loop -- one engine's messages apply in order
      await notifyStalkMoves(deps, repo.id, parsed.events);
      // oxlint-disable-next-line no-await-in-loop -- one engine's messages apply in order
      await deps.repoEvents?.({ repoId: repo.id, events: parsed.events });
      message.ack();
      deps.derived?.({ engine, repo: repo.artifactsRepo, events: parsed.events });
      // How far behind the engine the index is: the 2.6 target is under 5 s.
      const last = parsed.events.at(-1);
      deps.log.info('repo events indexed', {
        engine,
        events: parsed.events.length,
        lagMs: last === undefined ? null : Date.now() - Date.parse(last.at),
      });
    } catch (error: unknown) {
      deps.log.error('repo events: index write failed', { engine, id: message.id, error });
      message.retry();
    }
  }
}

async function notifyStalkMoves(
  deps: ConsumerDeps,
  repoId: string,
  events: readonly RepoEvent[],
): Promise<void> {
  const notify = deps.stalkMoved;
  if (notify === undefined) return;
  for (const event of events)
    if (event.kind === 'stalk.promoted')
      // oxlint-disable-next-line no-await-in-loop -- stalk moves are told in order
      await notify({ repoId, sha: event.sha, seq: event.seq, beans: event.beans });
}

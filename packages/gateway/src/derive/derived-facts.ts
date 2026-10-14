/**
 * What derived history keeps from the repository events (`@gitstalk/shared-race/repo-events`):
 * bean titles and actors, decision cards and the beans they weigh, reverted beans and the
 * heads of the sprout and the stalk; and which sprout commit the batch ends at, for the eager derivers.
 */
import type { RepoEvent } from '@gitstalk/shared-race/repo-events';

import { markReverted, recordBean, recordDecision, setLineHead } from './derived-store';

/** Records the events' facts; answers the newest sprout commit they name (a landing or revert), or null. */
export function recordEvents(sql: SqlStorage, events: readonly RepoEvent[]): string | null {
  let sproutHead: string | null = null;
  for (const event of events) {
    switch (event.kind) {
      case 'bean.opened':
        recordBean(sql, { bean: event.bean, title: event.title, actor: event.actor });
        break;
      case 'bean.landed':
        sproutHead = event.sha;
        setLineHead(sql, 'sprout', event.sha);
        break;
      case 'bean.reverted':
        if (event.bean !== null) markReverted(sql, event.bean);
        sproutHead = event.sha;
        setLineHead(sql, 'sprout', event.sha);
        break;
      case 'stalk.promoted':
      case 'stalk.demoted':
        setLineHead(sql, 'stalk', event.sha);
        break;
      case 'decision.asked':
        recordDecision(sql, event.card, [event.bean, ...event.against]);
        break;
      case 'bean.rework':
      case 'bean.ended':
      case 'sprout.red':
      case 'decision.made':
        break;
    }
  }
  return sproutHead;
}

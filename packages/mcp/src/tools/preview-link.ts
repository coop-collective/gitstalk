/**
 * Links into the web app's explorer for the caller's run: a bean, a line, or an Ask question,
 * as `bean_status`, `repo_status` and `ask_repo` give them in `preview_url`. Links never carry
 * the caller's token; the explorer reads runs without one.
 */
import type { RunId, TaskId } from '@gitstalk/shared-race/ids';

import type { LineRef } from '@gitstalk/shared-ask/ask/view-spec';

export type PreviewTarget =
  | { readonly kind: 'bean'; readonly bean: TaskId }
  | { readonly kind: 'ref'; readonly ref: LineRef }
  | { readonly kind: 'ask'; readonly question: string; readonly ref: LineRef | null }
  | { readonly kind: 'run' };

export function previewUrl(webUrl: string, run: RunId, target: PreviewTarget): string {
  const url = new URL(`/runs/${run}`, webUrl);
  switch (target.kind) {
    case 'bean':
      url.searchParams.set('bean', target.bean);
      break;
    case 'ref':
      url.searchParams.set('ref', target.ref);
      break;
    case 'ask':
      url.searchParams.set('q', target.question);
      if (target.ref !== null) url.searchParams.set('ref', target.ref);
      break;
    case 'run':
      break;
    default:
      return assertNever(target);
  }
  return url.toString();
}

function assertNever(value: never): never {
  throw new Error(`unexpected preview target ${JSON.stringify(value)}`);
}

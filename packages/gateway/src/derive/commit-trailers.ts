/**
 * What a sprout commit is, read from the trailers the engine writes (`engine/prompts.ts`):
 * a landing carries `Task: <bean>`, a revert `Reverts: <sha>`, a red-window reset
 * `Reverts: <green>..<head>`. Reading the commit, not the event, keeps the chain right when a
 * read derives a commit before its repository event arrives.
 */

const SHA = /^[0-9a-f]{40}$/;
/** Characters of a commit title kept. */
const MAX_TITLE = 200;

export type CommitTrailers =
  | { readonly kind: 'landing'; readonly bean: string }
  | { readonly kind: 'revert'; readonly reverted: string }
  | { readonly kind: 'reset'; readonly restored: string }
  | { readonly kind: 'commit' };

/** The kind of commit a message describes. */
export function commitTrailers(message: string): CommitTrailers {
  const reverts = trailer(message, 'Reverts');
  if (reverts !== null) {
    const [from, to] = reverts.split('..');
    if (to !== undefined && from !== undefined && SHA.test(from))
      return { kind: 'reset', restored: from };
    if (SHA.test(reverts)) return { kind: 'revert', reverted: reverts };
  }
  const task = trailer(message, 'Task');
  return task === null || task === '' ? { kind: 'commit' } : { kind: 'landing', bean: task };
}

/** The message's first line, cut. */
export function commitTitle(message: string): string {
  const first = message.split('\n', 1)[0]?.trim() ?? '';
  return first.length <= MAX_TITLE ? first : `${first.slice(0, MAX_TITLE - 1)}…`;
}

function trailer(message: string, key: string): string | null {
  const prefix = `${key}: `;
  const line = message.split('\n').findLast((candidate) => candidate.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length).trim();
}

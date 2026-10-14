/**
 * A web editor's save (the automation builder, doc 25 §7.13; Settings → Approval rules,
 * doc 32; Settings → Checks' conversion, doc 24) as a request to the one server-side commit flow
 * (`server-commit.ts`): one file's new text, or its deletion (and, for a conversion, the old
 * file's deletion), on the latest landed commit the editor opened, as a new bean named
 * from its commit, with the person as author. What differs from `bean_commit` is only these
 * parameters: the bean's name, the author and trailers, and the idempotency scope.
 */
import { automationBeanName } from '@gitstalk/shared-race/automation-editor';
import type { BeanCommitted } from '@gitstalk/shared-race/bean-commit';
import { checksBeanName } from '@gitstalk/shared-race/checks-editor';
import { TaskId } from '@gitstalk/shared-race/ids';
import type { Sha } from '@gitstalk/shared-race/ids';
import { rulesBeanName } from '@gitstalk/shared-race/rules-editor';

import type { ProtectedAccess } from '../checks/protected-access';
import { assertNever } from '../engine/errors';
import { pushedBeanRef } from '../push/bean-refs';
import { authorOf } from './bean-commit';
import type { CommitPayload } from './commit-idempotency';
import { replayedCommit } from './commit-idempotency';
import type { CommitDeps, ServerCommit } from './server-commit';
import { commitChanges } from './server-commit';

/** Which editor saves, which names its bean: `automation-<slug>-<short>`, `rules-<short>` or `checks-<short>`. */
export type SaveEditor =
  | { readonly kind: 'automation' }
  | { readonly kind: 'rules' }
  | { readonly kind: 'checks' };

/** One editor save, as the gateway's editor RPC hands it to the repository's engine. */
export type FileSave = {
  readonly editor: SaveEditor;
  /** The person's handle: the author, the pusher and the key's owner. */
  readonly actor: string;
  /** Whether the person may vouch for protected paths (owners and maintainers). */
  readonly protectedAccess: ProtectedAccess;
  /** The latest landed commit the editor opened. */
  readonly base: Sha;
  readonly path: string;
  /** The file's new text; null deletes it. */
  readonly content: string | null;
  /** Another file the same commit deletes: the `checks.toml` a `checks.yml` replaces. */
  readonly deletes?: string;
  readonly message: string;
  /** One per save attempt (the web sends it; a request without one is its own attempt). */
  readonly idempotencyKey: string;
};

/** Commits `save` as a new bean; `hooks` are the engine's refusal and its submit. */
export function commitFileSave(
  deps: CommitDeps,
  save: FileSave,
  hooks: Pick<ServerCommit, 'refusal' | 'afterPush'>,
): ReturnType<typeof commitChanges> {
  return commitChanges(deps, {
    onto: {
      kind: 'new_bean',
      base: save.base,
      beanOf: (short) => TaskId.parse(beanNameOf(save, short)),
      branchOf: (bean) => pushedBeanRef(bean).slice('refs/heads/'.length),
    },
    changes: [
      save.content === null
        ? { path: save.path, delete: true }
        : { path: save.path, content: save.content },
      ...(save.deletes === undefined ? [] : [{ path: save.deletes, delete: true as const }]),
    ],
    message: save.message,
    actor: save.actor,
    author: authorOf(save.actor, `users.${deps.emailHost}`),
    trailers: [`Actor: @${save.actor}`, `Via: ${viaOf(save.editor)}`],
    idempotency: { scope: scopeOf(save), key: save.idempotencyKey, attempt: attemptOf(save) },
    ...hooks,
  });
}

/** The bean an earlier try of this save made, when its key was used with the same input. */
export async function earlierSave(deps: CommitDeps, save: FileSave): Promise<BeanCommitted | null> {
  const identity = { bean: scopeOf(save), actor: save.actor, key: save.idempotencyKey };
  const replay = await replayedCommit(deps.sql, identity, attemptOf(save));
  return replay.kind === 'replay' ? replay.result : null;
}

function beanNameOf(save: FileSave, short: string): string {
  switch (save.editor.kind) {
    case 'automation':
      return automationBeanName(save.path, short);
    case 'rules':
      return rulesBeanName(short);
    case 'checks':
      return checksBeanName(short);
    default:
      return assertNever(save.editor);
  }
}

function viaOf(editor: SaveEditor): string {
  switch (editor.kind) {
    case 'automation':
      return 'the automation builder';
    case 'rules':
      return 'Settings → Approval rules';
    case 'checks':
      return 'Settings → Checks';
    default:
      return assertNever(editor);
  }
}

/** A person's saves share one key space, apart from their `bean_commit` keys. */
function scopeOf(save: FileSave): string {
  return `save:@${save.actor}`;
}

/**
 * What the key stands for: the text saved at the path. Not the base: it is the latest landed
 * commit when the request arrives, so a retry after unrelated beans landed is the same save.
 */
function attemptOf(save: FileSave): CommitPayload {
  return {
    method: 'editor_save',
    input: {
      editor: save.editor.kind,
      path: save.path,
      content: save.content,
      ...(save.deletes === undefined ? {} : { deletes: save.deletes }),
      message: save.message,
    },
  };
}

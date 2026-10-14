/**
 * What the builder sends as a save's starting version, and what a `stale` answer means for the
 * draft (doc 25 §7.13). An edit starts from the file it opened. A new file starts from "absent"
 * on the commit the editor opened, whatever path the editor was opened at: the person may rename
 * it, and a template's default name may already be taken. So a `stale` answer to a new file
 * means the name is taken on the latest landed commit, never that someone deleted it.
 */
import type { AutomationBase } from '@gitstalk/shared-race/automation-editor';

import type { MergeOutcome } from './automation-merge';
import { mergeAutomation } from './automation-merge';

export type BuilderMode = 'new' | 'edit';

/** The version a save is built on: its commit and blob, and the text the three-way merge uses. */
export type SaveBase = { readonly base: AutomationBase; readonly text: string | null };

/** What a `stale` answer asks of the person. */
export type StaleAnswer =
  /** A new file whose name is now taken by this exact text (an earlier save landed). */
  | { readonly kind: 'already-saved' }
  /** A new file whose name is taken by another file: pick another name, or edit that one. */
  | { readonly kind: 'taken' }
  /** An edit whose file changed meanwhile: merge field by field, or ask. */
  | { readonly kind: 'merge'; readonly view: MergeOutcome };

/** The starting version a save of the draft sends. */
export function saveBaseOf(mode: BuilderMode, opened: SaveBase): SaveBase {
  if (mode === 'edit') return opened;
  return { base: { commit: opened.base.commit, blob: null }, text: null };
}

/** What a `stale` answer means: `theirs` is the file on the latest landed commit (null: absent). */
export function staleAnswerOf(input: {
  readonly mode: BuilderMode;
  readonly base: SaveBase;
  readonly theirs: string | null;
  readonly ours: string;
}): StaleAnswer {
  if (input.mode === 'new' && input.theirs !== null)
    return { kind: input.theirs === input.ours ? 'already-saved' : 'taken' };
  return {
    kind: 'merge',
    view: mergeAutomation({ base: input.base.text, theirs: input.theirs, ours: input.ours }),
  };
}

/** The key of a save attempt, given what the save sends. */
export type SaveKeys = (attempt: string) => string;

/**
 * Idempotency keys for an editor's saves, one per attempt: the same save sent again (a double
 * click, a retried request) carries the same key, so the gateway makes one bean; anything
 * else saved starts a new attempt with a new key.
 */
export function saveKeys(newKey: () => string = () => crypto.randomUUID()): SaveKeys {
  let last: { readonly attempt: string; readonly key: string } | null = null;
  return (attempt) => {
    if (last?.attempt !== attempt) last = { attempt, key: newKey() };
    return last.key;
  };
}

import { describe, expect, it } from 'vitest';

import { templateOf } from '@gitstalk/shared-race/automation-templates';
import type { SaveBase } from './automation-save';
import { saveBaseOf, saveKeys, staleAnswerOf } from './automation-save';

const COMMIT = 'c'.repeat(40);
const BLOB = 'b'.repeat(40);
const HEARTBEAT = templateOf('heartbeat').source;
const OTHER = HEARTBEAT.replace('name: Heartbeat', 'name: Someone else');

/** What the builder opened when the template's default name was already on the stalk. */
const TAKEN_OPEN: SaveBase = { base: { commit: COMMIT, blob: BLOB }, text: OTHER };
const FREE_OPEN: SaveBase = { base: { commit: COMMIT, blob: null }, text: null };

describe('the version a save starts from', () => {
  it('starts a new file from absent, even when the opened name was taken', () => {
    expect(saveBaseOf('new', TAKEN_OPEN)).toEqual({
      base: { commit: COMMIT, blob: null },
      text: null,
    });
    expect(saveBaseOf('new', FREE_OPEN)).toEqual(FREE_OPEN);
  });

  it('starts an edit from the file it opened', () => {
    expect(saveBaseOf('edit', TAKEN_OPEN)).toBe(TAKEN_OPEN);
  });
});

describe('a stale answer', () => {
  it('never reads as "someone deleted it" for a renamed new file (the Shell heartbeat case)', () => {
    // Opened at heartbeat.yml (taken), renamed to heartbeat-2.yml, which is absent on the stalk.
    const answer = staleAnswerOf({
      mode: 'new',
      base: saveBaseOf('new', TAKEN_OPEN),
      theirs: null,
      ours: HEARTBEAT,
    });
    if (answer.kind !== 'merge') throw new Error(`expected a merge, got ${answer.kind}`);
    expect(answer.view).toMatchObject({ kind: 'merged', text: HEARTBEAT });
  });

  it('says a new file name is taken when another file landed under it', () => {
    expect(staleAnswerOf({ mode: 'new', base: FREE_OPEN, theirs: OTHER, ours: HEARTBEAT })).toEqual(
      { kind: 'taken' },
    );
  });

  it('says a new file is already saved when the same text landed (an earlier save)', () => {
    expect(
      staleAnswerOf({ mode: 'new', base: FREE_OPEN, theirs: HEARTBEAT, ours: HEARTBEAT }),
    ).toEqual({ kind: 'already-saved' });
  });

  it('still offers recreate or keep-deleted when an edited file was deleted meanwhile', () => {
    const answer = staleAnswerOf({ mode: 'edit', base: TAKEN_OPEN, theirs: null, ours: OTHER });
    expect(answer).toEqual({ kind: 'merge', view: { kind: 'deleted', oursChanged: false } });
  });
});

describe('the key a save sends', () => {
  it('is the same for the same save sent twice, and new for anything else', () => {
    let made = 0;
    const keyOf = saveKeys(() => `key-${(made += 1)}`);
    expect(keyOf('a')).toBe('key-1');
    expect(keyOf('a')).toBe('key-1');
    expect(keyOf('b')).toBe('key-2');
    expect(keyOf('a')).toBe('key-3');
  });
});

import { describe, expect, it } from 'vitest';

import type { ShortcutEvent } from './tree-layout';
import {
  DEFAULT_LAYOUT,
  TREE_WIDTH,
  clampWidth,
  isFinderShortcut,
  isToggleShortcut,
  memoryKey,
  readLayout,
  readMemory,
  resizeByKey,
} from './tree-layout';

const key = (pressed: string, extra: Partial<ShortcutEvent> = {}): ShortcutEvent => ({
  key: pressed,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  inField: false,
  ...extra,
});

describe('the remembered layout', () => {
  it('reads a stored width and collapse, keeping the width in bounds', () => {
    expect(readLayout('{"width":320,"collapsed":true}')).toEqual({ width: 320, collapsed: true });
    expect(readLayout('{"width":9000,"collapsed":false}').width).toBe(TREE_WIDTH.max);
  });

  it('falls back to the default for nothing, junk or the wrong shape', () => {
    expect(readLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(readLayout('not json')).toEqual(DEFAULT_LAYOUT);
    expect(readLayout('{"width":"wide"}')).toEqual(DEFAULT_LAYOUT);
  });

  it('reads a repository’s open folders and scroll, per repository', () => {
    expect(readMemory('{"expanded":["src"],"scrollTop":40}')).toEqual({
      expanded: ['src'],
      scrollTop: 40,
    });
    expect(readMemory('{"expanded":"src"}')).toBeNull();
    expect(memoryKey('coop', 'greeter')).not.toBe(memoryKey('coop', 'other'));
  });
});

describe('resizing', () => {
  it('keeps the width between the bounds and at most half the viewport', () => {
    expect(clampWidth(100, null)).toBe(TREE_WIDTH.min);
    expect(clampWidth(500, 800)).toBe(400);
    expect(clampWidth(300.4, 1440)).toBe(300);
  });

  it('moves by a small step on an arrow, a large one with Shift, and to the ends on Home and End', () => {
    expect(resizeByKey(280, 'ArrowRight', false)).toBe(296);
    expect(resizeByKey(280, 'ArrowLeft', true)).toBe(216);
    expect(resizeByKey(280, 'Home', false)).toBe(TREE_WIDTH.min);
    expect(resizeByKey(280, 'End', false)).toBe(TREE_WIDTH.max);
    expect(resizeByKey(280, 'Enter', false)).toBeNull();
  });
});

describe('the shortcuts', () => {
  it('opens Go to file on t, never while typing or with a modifier', () => {
    expect(isFinderShortcut(key('t'))).toBe(true);
    expect(isFinderShortcut(key('t', { inField: true }))).toBe(false);
    expect(isFinderShortcut(key('t', { metaKey: true }))).toBe(false);
    expect(isFinderShortcut(key('T'))).toBe(false);
  });

  it('toggles the tree on Ctrl+B or Cmd+B, even from a field', () => {
    expect(isToggleShortcut(key('b', { ctrlKey: true }))).toBe(true);
    expect(isToggleShortcut(key('B', { metaKey: true, inField: true }))).toBe(true);
    expect(isToggleShortcut(key('b'))).toBe(false);
    expect(isToggleShortcut(key('b', { ctrlKey: true, shiftKey: true }))).toBe(false);
  });
});

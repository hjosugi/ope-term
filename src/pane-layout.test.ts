import { describe, expect, it } from 'vitest';
import {
  containsPaneSession,
  focusPane,
  paneLeaf,
  paneSessions,
  removePaneSession,
  replacePaneSession,
  resizePane,
  setSplitRatio,
  splitPane,
} from './pane-layout';

describe('pane layout', () => {
  it('splits around a target without duplicating sessions', () => {
    const initial = paneLeaf('a');
    const split = splitPane(initial, 'a', 'b', 'horizontal');
    expect(paneSessions(split)).toEqual(['a', 'b']);
    expect(splitPane(split, 'a', 'b', 'vertical')).toBe(split);
    expect(splitPane(split, 'missing', 'c', 'vertical')).toBe(split);
  });

  it('replaces a leaf and collapses a removed branch', () => {
    const split = splitPane(paneLeaf('a'), 'a', 'b', 'horizontal');
    const replaced = replacePaneSession(split, 'b', 'c');
    expect(paneSessions(replaced)).toEqual(['a', 'c']);
    expect(removePaneSession(replaced, 'a')).toEqual(paneLeaf('c'));
    expect(removePaneSession(paneLeaf('a'), 'a')).toBeNull();
  });

  it('moves focus using pane geometry, including nested panes', () => {
    const right = splitPane(paneLeaf('b'), 'b', 'c', 'vertical');
    const layout = {
      type: 'split' as const,
      axis: 'horizontal' as const,
      ratio: 0.5,
      first: paneLeaf('a'),
      second: right,
    };
    expect(focusPane(layout, 'a', 'right')).toBe('b');
    expect(focusPane(layout, 'b', 'down')).toBe('c');
    expect(focusPane(layout, 'c', 'left')).toBe('a');
    expect(focusPane(layout, 'a', 'left')).toBeNull();
  });

  it('resizes the nearest matching split and clamps its ratio', () => {
    const layout = splitPane(paneLeaf('a'), 'a', 'b', 'horizontal');
    const wider = resizePane(layout, 'a', 'horizontal', 0.1);
    expect(wider?.type).toBe('split');
    if (wider?.type === 'split') expect(wider.ratio).toBeCloseTo(0.6);

    let clamped = wider;
    for (let index = 0; index < 20; index += 1) clamped = resizePane(clamped, 'a', 'horizontal', 0.1);
    if (clamped?.type === 'split') expect(clamped.ratio).toBe(0.85);
    expect(containsPaneSession(clamped, 'b')).toBe(true);
  });

  it('sets a dragged divider ratio by split identity', () => {
    const layout = splitPane(paneLeaf('a'), 'a', 'b', 'horizontal');
    expect(layout.type).toBe('split');
    if (layout.type !== 'split') return;
    const moved = setSplitRatio(layout, layout, 0.99);
    if (moved?.type === 'split') expect(moved.ratio).toBe(0.85);
  });
});

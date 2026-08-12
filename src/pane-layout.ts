export type PaneAxis = 'horizontal' | 'vertical';
export type PaneDirection = 'left' | 'right' | 'up' | 'down';

export type PaneLayout = PaneLeaf | PaneSplit;

export interface PaneLeaf {
  type: 'leaf';
  sessionKey: string;
}

export interface PaneSplit {
  type: 'split';
  axis: PaneAxis;
  /** Fraction assigned to the first child. */
  ratio: number;
  first: PaneLayout;
  second: PaneLayout;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;

export function paneLeaf(sessionKey: string): PaneLeaf {
  return { type: 'leaf', sessionKey };
}

export function paneSessions(layout: PaneLayout | null): string[] {
  if (!layout) return [];
  if (layout.type === 'leaf') return [layout.sessionKey];
  return [...paneSessions(layout.first), ...paneSessions(layout.second)];
}

export function containsPaneSession(layout: PaneLayout | null, sessionKey: string): boolean {
  return paneSessions(layout).includes(sessionKey);
}

export function splitPane(
  layout: PaneLayout | null,
  targetSessionKey: string,
  newSessionKey: string,
  axis: PaneAxis,
  placement: 'before' | 'after' = 'after',
): PaneLayout {
  if (!layout) return paneLeaf(newSessionKey);
  if (containsPaneSession(layout, newSessionKey)) return layout;
  if (layout.type === 'leaf') {
    if (layout.sessionKey !== targetSessionKey) return layout;
    const incoming = paneLeaf(newSessionKey);
    return {
      type: 'split',
      axis,
      ratio: 0.5,
      first: placement === 'before' ? incoming : layout,
      second: placement === 'before' ? layout : incoming,
    };
  }
  const first = splitPane(layout.first, targetSessionKey, newSessionKey, axis, placement);
  if (first !== layout.first) return { ...layout, first };
  const second = splitPane(layout.second, targetSessionKey, newSessionKey, axis, placement);
  return second === layout.second ? layout : { ...layout, second };
}

export function replacePaneSession(
  layout: PaneLayout | null,
  targetSessionKey: string,
  newSessionKey: string,
): PaneLayout {
  if (!layout) return paneLeaf(newSessionKey);
  if (containsPaneSession(layout, newSessionKey)) return layout;
  if (layout.type === 'leaf') {
    return layout.sessionKey === targetSessionKey ? paneLeaf(newSessionKey) : layout;
  }
  const first = replacePaneSession(layout.first, targetSessionKey, newSessionKey);
  if (first !== layout.first) return { ...layout, first };
  const second = replacePaneSession(layout.second, targetSessionKey, newSessionKey);
  return second === layout.second ? layout : { ...layout, second };
}

export function removePaneSession(layout: PaneLayout | null, sessionKey: string): PaneLayout | null {
  if (!layout) return null;
  if (layout.type === 'leaf') return layout.sessionKey === sessionKey ? null : layout;
  const first = removePaneSession(layout.first, sessionKey);
  const second = removePaneSession(layout.second, sessionKey);
  if (!first) return second;
  if (!second) return first;
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second };
}

/** Increase or decrease the active pane along its nearest matching split. */
export function resizePane(
  layout: PaneLayout | null,
  sessionKey: string,
  axis: PaneAxis,
  delta: number,
): PaneLayout | null {
  if (!layout || layout.type === 'leaf') return layout;
  const firstContains = containsPaneSession(layout.first, sessionKey);
  const secondContains = containsPaneSession(layout.second, sessionKey);
  if (!firstContains && !secondContains) return layout;

  const childKey = firstContains ? 'first' : 'second';
  const child = layout[childKey];
  const resizedChild = resizePane(child, sessionKey, axis, delta);
  if (resizedChild !== child) return { ...layout, [childKey]: resizedChild };
  if (layout.axis !== axis) return layout;

  const signedDelta = firstContains ? delta : -delta;
  const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, layout.ratio + signedDelta));
  return ratio === layout.ratio ? layout : { ...layout, ratio };
}

export function setSplitRatio(
  layout: PaneLayout | null,
  target: PaneSplit,
  ratio: number,
): PaneLayout | null {
  if (!layout || layout.type === 'leaf') return layout;
  if (layout === target) {
    const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
    return clamped === layout.ratio ? layout : { ...layout, ratio: clamped };
  }
  const first = setSplitRatio(layout.first, target, ratio);
  if (first !== layout.first) return { ...layout, first: first! };
  const second = setSplitRatio(layout.second, target, ratio);
  return second === layout.second ? layout : { ...layout, second: second! };
}

export function focusPane(
  layout: PaneLayout | null,
  sessionKey: string,
  direction: PaneDirection,
): string | null {
  if (!layout) return null;
  const rectangles = new Map<string, Rect>();
  collectRects(layout, { left: 0, top: 0, width: 1, height: 1 }, rectangles);
  const active = rectangles.get(sessionKey);
  if (!active) return null;

  const activeCenter = center(active);
  let best: { key: string; score: number } | undefined;
  for (const [key, candidate] of rectangles) {
    if (key === sessionKey || !isInDirection(active, candidate, direction)) continue;
    const candidateCenter = center(candidate);
    const horizontal = Math.abs(candidateCenter.x - activeCenter.x);
    const vertical = Math.abs(candidateCenter.y - activeCenter.y);
    const primary = direction === 'left' || direction === 'right' ? horizontal : vertical;
    const secondary = direction === 'left' || direction === 'right' ? vertical : horizontal;
    const overlap = direction === 'left' || direction === 'right'
      ? rangesOverlap(active.top, active.top + active.height, candidate.top, candidate.top + candidate.height)
      : rangesOverlap(active.left, active.left + active.width, candidate.left, candidate.left + candidate.width);
    const score = primary * 10 + secondary + (overlap ? 0 : 10);
    if (!best || score < best.score) best = { key, score };
  }
  return best?.key ?? null;
}

function collectRects(layout: PaneLayout, rect: Rect, output: Map<string, Rect>): void {
  if (layout.type === 'leaf') {
    output.set(layout.sessionKey, rect);
    return;
  }
  if (layout.axis === 'horizontal') {
    const firstWidth = rect.width * layout.ratio;
    collectRects(layout.first, { ...rect, width: firstWidth }, output);
    collectRects(
      layout.second,
      { left: rect.left + firstWidth, top: rect.top, width: rect.width - firstWidth, height: rect.height },
      output,
    );
    return;
  }
  const firstHeight = rect.height * layout.ratio;
  collectRects(layout.first, { ...rect, height: firstHeight }, output);
  collectRects(
    layout.second,
    { left: rect.left, top: rect.top + firstHeight, width: rect.width, height: rect.height - firstHeight },
    output,
  );
}

function center(rect: Rect): { x: number; y: number } {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function isInDirection(active: Rect, candidate: Rect, direction: PaneDirection): boolean {
  const from = center(active);
  const to = center(candidate);
  if (direction === 'left') return to.x < from.x;
  if (direction === 'right') return to.x > from.x;
  if (direction === 'up') return to.y < from.y;
  return to.y > from.y;
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

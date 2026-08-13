import { describe, expect, it } from 'vitest';

import { IncrementalRenderer } from './incremental-render';

describe('IncrementalRenderer', () => {
  it('renders the first range immediately and schedules bounded later ranges', () => {
    const scheduled: Array<() => void> = [];
    const ranges: Array<[number, number]> = [];
    let completed = false;
    const renderer = new IncrementalRenderer((callback) => scheduled.push(callback));

    renderer.render(7, 3, (start, end) => ranges.push([start, end]), () => {
      completed = true;
    });
    expect(ranges).toEqual([[0, 3]]);
    expect(completed).toBe(false);

    scheduled.shift()?.();
    scheduled.shift()?.();
    expect(ranges).toEqual([[0, 3], [3, 6], [6, 7]]);
    expect(completed).toBe(true);
  });

  it('cancels stale scheduled work when a newer render starts', () => {
    const scheduled: Array<() => void> = [];
    const ranges: string[] = [];
    const renderer = new IncrementalRenderer((callback) => scheduled.push(callback));

    renderer.render(4, 2, (start, end) => ranges.push(`old:${start}-${end}`));
    renderer.render(1, 2, (start, end) => ranges.push(`new:${start}-${end}`));
    scheduled.shift()?.();

    expect(ranges).toEqual(['old:0-2', 'new:0-1']);
  });

  it('completes an empty render and rejects unsafe batch parameters', () => {
    const renderer = new IncrementalRenderer(() => undefined);
    let completed = false;

    renderer.render(0, 1, () => undefined, () => {
      completed = true;
    });
    expect(completed).toBe(true);
    expect(() => renderer.render(-1, 1, () => undefined)).toThrow(RangeError);
    expect(() => renderer.render(1, 0, () => undefined)).toThrow(RangeError);
  });
});

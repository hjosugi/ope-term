export type FrameScheduler = (callback: () => void) => void;

export class IncrementalRenderer {
  private generation = 0;

  constructor(
    private readonly schedule: FrameScheduler = (callback) => {
      window.requestAnimationFrame(callback);
    },
  ) {}

  cancel(): void {
    this.generation += 1;
  }

  render(
    itemCount: number,
    batchSize: number,
    renderRange: (start: number, end: number) => void,
    complete: () => void = () => undefined,
  ): void {
    if (!Number.isSafeInteger(itemCount) || itemCount < 0) {
      throw new RangeError('itemCount must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new RangeError('batchSize must be a positive safe integer');
    }

    const generation = ++this.generation;
    let offset = 0;
    const next = (): void => {
      if (generation !== this.generation) return;
      const end = Math.min(offset + batchSize, itemCount);
      if (offset < end) renderRange(offset, end);
      offset = end;
      if (offset < itemCount) {
        this.schedule(next);
      } else {
        complete();
      }
    };
    next();
  }
}

export class PromptQueue<T> {
  private current: T | undefined;
  private readonly pending: T[] = [];

  get active(): T | undefined {
    return this.current;
  }

  enqueue(item: T): void {
    this.pending.push(item);
  }

  activateNext(): T | undefined {
    if (this.current !== undefined) return this.current;
    this.current = this.pending.shift();
    return this.current;
  }

  finish(): T | undefined {
    const finished = this.current;
    this.current = undefined;
    return finished;
  }

  discardPending(predicate: (item: T) => boolean): number {
    let removed = 0;
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const item = this.pending[index];
      if (item !== undefined && predicate(item)) {
        this.pending.splice(index, 1);
        removed += 1;
      }
    }
    return removed;
  }
}

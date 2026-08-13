import { describe, expect, it } from 'vitest';
import { PromptQueue } from './prompt-queue';

describe('PromptQueue', () => {
  it('keeps one active prompt and activates pending prompts in FIFO order', () => {
    const queue = new PromptQueue<string>();
    queue.enqueue('first');
    queue.enqueue('second');

    expect(queue.activateNext()).toBe('first');
    expect(queue.activateNext()).toBe('first');
    expect(queue.finish()).toBe('first');
    expect(queue.activateNext()).toBe('second');
    expect(queue.finish()).toBe('second');
    expect(queue.activateNext()).toBeUndefined();
  });

  it('discards only matching pending prompts without changing the active prompt', () => {
    const queue = new PromptQueue<{ session: string; sequence: number }>();
    queue.enqueue({ session: 'keep', sequence: 1 });
    queue.enqueue({ session: 'drop', sequence: 2 });
    queue.enqueue({ session: 'keep', sequence: 3 });
    queue.enqueue({ session: 'drop', sequence: 4 });
    queue.activateNext();

    expect(queue.discardPending((item) => item.session === 'drop')).toBe(2);
    expect(queue.active).toEqual({ session: 'keep', sequence: 1 });
    queue.finish();
    expect(queue.activateNext()).toEqual({ session: 'keep', sequence: 3 });
  });
});

import { describe, expect, it } from 'vitest';

import {
  MAX_TERMINAL_INPUT_BACKLOG_BYTES,
  boundedTerminalInputBytes,
  chunkTerminalInput,
} from './terminal-input';

describe('terminal input batching', () => {
  it('preserves ASCII and multibyte input across bounded chunks', () => {
    const input = `ascii-${'界🙂'.repeat(20)}-tail`;
    const chunks = chunkTerminalInput(input, 13);
    expect(chunks.join('')).toBe(input);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => new TextEncoder().encode(chunk).length <= 13)).toBe(true);
  });

  it('keeps small input in one chunk and omits empty input', () => {
    expect(chunkTerminalInput('hello', 5)).toEqual(['hello']);
    expect(chunkTerminalInput('')).toEqual([]);
  });

  it('rejects unsafe chunk limits', () => {
    expect(() => chunkTerminalInput('hello', 3)).toThrow(/at least 4 bytes/u);
    expect(() => chunkTerminalInput('hello', Number.NaN)).toThrow(/at least 4 bytes/u);
  });

  it('bounds aggregate pending input in UTF-8 bytes', () => {
    expect(boundedTerminalInputBytes('界🙂', 0, 7)).toBe(7);
    expect(boundedTerminalInputBytes('界🙂', 1, 7)).toBeNull();
    expect(boundedTerminalInputBytes('x', MAX_TERMINAL_INPUT_BACKLOG_BYTES)).toBeNull();
    expect(boundedTerminalInputBytes('x'.repeat(100), 0, 10)).toBeNull();
    expect(boundedTerminalInputBytes('x', -1)).toBeNull();
  });
});

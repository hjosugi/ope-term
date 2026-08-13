import { describe, expect, it } from 'vitest';

import { chunkTerminalInput } from './terminal-input';

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
});

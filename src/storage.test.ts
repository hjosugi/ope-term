import { describe, expect, it } from 'vitest';
import { readStorage, writeStorage } from './storage';

describe('optional WebView storage', () => {
  it('reads and writes available storage', () => {
    let saved = '';
    expect(writeStorage({ setItem: (_key, value) => { saved = value; } }, 'setting', 'enabled')).toBe(true);
    expect(readStorage({ getItem: () => saved }, 'setting')).toBe('enabled');
  });

  it('turns disabled or full storage into an explicit non-fatal result', () => {
    expect(readStorage({ getItem: () => { throw new Error('disabled'); } }, 'setting')).toBeNull();
    expect(writeStorage({ setItem: () => { throw new Error('quota'); } }, 'setting', 'enabled')).toBe(false);
  });
});

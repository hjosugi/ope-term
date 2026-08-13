import { describe, expect, it } from 'vitest';
import { readBoundedStorage, readStorage, writeBoundedStorage, writeStorage } from './storage';

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

  it('rejects oversized UTF-8 values before parsing or writing them', () => {
    expect(readBoundedStorage({ getItem: () => '界界' }, 'setting', 5)).toBeNull();
    expect(readBoundedStorage({ getItem: () => '界界' }, 'setting', 6)).toBe('界界');
    let writes = 0;
    const storage = { setItem: () => { writes += 1; } };
    expect(writeBoundedStorage(storage, 'setting', '界界', 5)).toBe(false);
    expect(writeBoundedStorage(storage, 'setting', '界界', 6)).toBe(true);
    expect(writes).toBe(1);
  });
});

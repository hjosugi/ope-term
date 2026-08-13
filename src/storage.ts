export type ReadableStorage = Pick<Storage, 'getItem'>;
export type WritableStorage = Pick<Storage, 'setItem'>;

/**
 * WebView storage can throw when it is disabled, unavailable, or over quota.
 * Preferences are optional state, so callers must be able to keep operating.
 */
export function readStorage(storage: ReadableStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(storage: WritableStorage, key: string, value: string): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

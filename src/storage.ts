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

export function readBoundedStorage(
  storage: ReadableStorage,
  key: string,
  maximumBytes: number,
): string | null {
  const value = readStorage(storage, key);
  return value !== null && isWithinUtf8Limit(value, maximumBytes) ? value : null;
}

export function writeBoundedStorage(
  storage: WritableStorage,
  key: string,
  value: string,
  maximumBytes: number,
): boolean {
  return isWithinUtf8Limit(value, maximumBytes) && writeStorage(storage, key, value);
}

function isWithinUtf8Limit(value: string, maximumBytes: number): boolean {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || value.length > maximumBytes) return false;
  return new TextEncoder().encode(value).byteLength <= maximumBytes;
}

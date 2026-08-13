import { readBoundedStorage } from './storage';

export type RendererName = 'webgl' | 'fallback' | 'unknown';
export type RendererPreference = 'auto' | 'webgl' | 'fallback';

const RENDERER_STORAGE_KEY = 'ope-term.performance.renderer';

export function loadRendererPreference(
  storage: Pick<Storage, 'getItem'> = localStorage,
): RendererPreference {
  const value = readBoundedStorage(storage, RENDERER_STORAGE_KEY, 16);
  return value === 'webgl' || value === 'fallback' ? value : 'auto';
}

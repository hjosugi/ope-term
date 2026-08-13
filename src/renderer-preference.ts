import { readStorage } from './storage';

export type RendererName = 'webgl' | 'fallback' | 'unknown';
export type RendererPreference = 'auto' | 'webgl' | 'fallback';

const RENDERER_STORAGE_KEY = 'ope-term.performance.renderer';

export function loadRendererPreference(
  storage: Pick<Storage, 'getItem'> = localStorage,
): RendererPreference {
  const value = readStorage(storage, RENDERER_STORAGE_KEY);
  return value === 'webgl' || value === 'fallback' ? value : 'auto';
}

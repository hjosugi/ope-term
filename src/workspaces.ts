import type { PaneLayout } from './pane-layout';

/**
 * Route workspaces persist only `~/.ssh/config` alias references.
 *
 * Hostnames, users, ports and jump chains stay in OpenSSH config so that a
 * saved workspace can never drift away from the connection source of truth.
 */
export interface SavedRoute {
  id: string;
  name: string;
  route: string[];
}

export interface WorkspaceState {
  saved: SavedRoute[];
  tabs: string[][];
  activeTab: number;
  paneLayout: StoredPaneLayout | null;
}

export type StoredPaneLayout =
  | { type: 'leaf'; tab: number }
  | { type: 'split'; axis: 'horizontal' | 'vertical'; ratio: number; first: StoredPaneLayout; second: StoredPaneLayout };

/** Matches `MAX_ROUTE_HOPS` in `src-tauri/src/ssh_config.rs`. */
export const MAX_ROUTE_HOPS = 32;
export const MAX_SAVED_ROUTES = 60;
export const MAX_RESTORED_TABS = 24;
export const MAX_NAME_LENGTH = 60;
/** Mirrors the parser's host-spec bound so a corrupt store cannot flood the DOM. */
const MAX_ALIAS_LENGTH = 4096;
const MAX_ID_LENGTH = 64;

const STORAGE_KEY = 'ope-term.workspaces.v1';

export function emptyWorkspaces(): WorkspaceState {
  return { saved: [], tabs: [], activeTab: -1, paneLayout: null };
}

export function sanitizeName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/gu, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

export function sanitizeRoute(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const route: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const alias = entry.trim();
    if (!alias || alias.length > MAX_ALIAS_LENGTH || route.includes(alias)) continue;
    route.push(alias);
    if (route.length === MAX_ROUTE_HOPS) break;
  }
  return route;
}

/** Aliases of a route that no longer exist in the current SSH config. */
export function missingAliases(route: readonly string[], known: readonly string[]): string[] {
  const available = new Set(known);
  return route.filter((alias) => !available.has(alias));
}

export function suggestRouteName(route: readonly string[]): string {
  return sanitizeName(route.at(-1) ?? '');
}

export function upsertSavedRoute(saved: readonly SavedRoute[], name: string, route: readonly string[]): SavedRoute[] {
  const cleanName = sanitizeName(name);
  const cleanRoute = sanitizeRoute([...route]);
  if (!cleanName || cleanRoute.length === 0) return [...saved];
  const previous = saved.find((entry) => entry.name === cleanName);
  const entry: SavedRoute = { id: previous?.id ?? createId(), name: cleanName, route: cleanRoute };
  return [entry, ...saved.filter((item) => item.name !== cleanName)].slice(0, MAX_SAVED_ROUTES);
}

export function removeSavedRoute(saved: readonly SavedRoute[], id: string): SavedRoute[] {
  return saved.filter((entry) => entry.id !== id);
}

export function parseWorkspaces(raw: string | null): WorkspaceState {
  const state = emptyWorkspaces();
  try {
    const parsed = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    if (Array.isArray(parsed.saved)) {
      for (const entry of parsed.saved) {
        if (typeof entry !== 'object' || entry === null) continue;
        const record = entry as Record<string, unknown>;
        const name = sanitizeName(record.name);
        const route = sanitizeRoute(record.route);
        if (!name || route.length === 0 || state.saved.some((item) => item.name === name)) continue;
        const id = typeof record.id === 'string' && record.id ? record.id.slice(0, MAX_ID_LENGTH) : createId();
        state.saved.push({ id, name, route });
        if (state.saved.length === MAX_SAVED_ROUTES) break;
      }
    }
    if (Array.isArray(parsed.tabs)) {
      for (const entry of parsed.tabs) {
        const route = sanitizeRoute(entry);
        if (route.length === 0) continue;
        state.tabs.push(route);
        if (state.tabs.length === MAX_RESTORED_TABS) break;
      }
    }
    const active = parsed.activeTab;
    if (typeof active === 'number' && Number.isInteger(active) && active >= 0 && active < state.tabs.length) {
      state.activeTab = active;
    }
    state.paneLayout = sanitizeStoredPaneLayout(parsed.paneLayout, state.tabs.length);
  } catch {
    // A corrupt workspace store must never prevent the terminal from starting.
  }
  return state;
}

export function storePaneLayout(layout: PaneLayout | null, sessionKeys: readonly string[]): StoredPaneLayout | null {
  if (!layout) return null;
  if (layout.type === 'leaf') {
    const tab = sessionKeys.indexOf(layout.sessionKey);
    return tab >= 0 ? { type: 'leaf', tab } : null;
  }
  const first = storePaneLayout(layout.first, sessionKeys);
  const second = storePaneLayout(layout.second, sessionKeys);
  if (!first) return second;
  if (!second) return first;
  return { type: 'split', axis: layout.axis, ratio: layout.ratio, first, second };
}

export function restorePaneLayout(layout: StoredPaneLayout | null, sessionKeys: readonly string[]): PaneLayout | null {
  if (!layout) return null;
  if (layout.type === 'leaf') {
    const sessionKey = sessionKeys[layout.tab];
    return sessionKey ? { type: 'leaf', sessionKey } : null;
  }
  const first = restorePaneLayout(layout.first, sessionKeys);
  const second = restorePaneLayout(layout.second, sessionKeys);
  if (!first) return second;
  if (!second) return first;
  return { type: 'split', axis: layout.axis, ratio: layout.ratio, first, second };
}

function sanitizeStoredPaneLayout(value: unknown, tabCount: number): StoredPaneLayout | null {
  const seen = new Set<number>();
  function visit(node: unknown, depth: number): StoredPaneLayout | null {
    if (depth > MAX_RESTORED_TABS || typeof node !== 'object' || node === null) return null;
    const record = node as Record<string, unknown>;
    if (record.type === 'leaf') {
      const tab = record.tab;
      if (typeof tab !== 'number' || !Number.isInteger(tab) || tab < 0 || tab >= tabCount || seen.has(tab)) {
        return null;
      }
      seen.add(tab);
      return { type: 'leaf', tab };
    }
    if (record.type !== 'split' || (record.axis !== 'horizontal' && record.axis !== 'vertical')) return null;
    const first = visit(record.first, depth + 1);
    const second = visit(record.second, depth + 1);
    if (!first) return second;
    if (!second) return first;
    const rawRatio = typeof record.ratio === 'number' && Number.isFinite(record.ratio) ? record.ratio : 0.5;
    const ratio = Math.min(0.85, Math.max(0.15, rawRatio));
    return { type: 'split', axis: record.axis, ratio, first, second };
  }
  return visit(value, 0);
}

export function loadWorkspaces(storage: Pick<Storage, 'getItem'> = localStorage): WorkspaceState {
  try {
    return parseWorkspaces(storage.getItem(STORAGE_KEY));
  } catch {
    return emptyWorkspaces();
  }
}

export function saveWorkspaces(state: WorkspaceState, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function createId(): string {
  return crypto.randomUUID();
}

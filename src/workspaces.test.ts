import { describe, expect, it } from 'vitest';
import { paneLeaf, splitPane } from './pane-layout';
import {
  MAX_RESTORED_TABS,
  MAX_ROUTE_HOPS,
  MAX_SAVED_ROUTES,
  loadWorkspaces,
  missingAliases,
  parseWorkspaces,
  removeSavedRoute,
  restorePaneLayout,
  sanitizeName,
  sanitizeRoute,
  suggestRouteName,
  storePaneLayout,
  upsertSavedRoute,
} from './workspaces';

describe('workspace routes', () => {
  it('keeps alias references only and drops junk entries', () => {
    expect(sanitizeRoute(['bastion', ' prod ', 'bastion', 42, '', null])).toEqual(['bastion', 'prod']);
    expect(sanitizeRoute('bastion')).toEqual([]);
  });

  it('caps a route at the parser hop limit', () => {
    const long = Array.from({ length: MAX_ROUTE_HOPS + 5 }, (_, index) => `hop-${index}`);
    expect(sanitizeRoute(long)).toHaveLength(MAX_ROUTE_HOPS);
  });

  it('collapses whitespace and truncates workspace names', () => {
    expect(sanitizeName('  prod \n 保守  ')).toBe('prod 保守');
    expect(sanitizeName('x'.repeat(200))).toHaveLength(60);
    expect(sanitizeName(42)).toBe('');
  });

  it('suggests the target alias as the workspace name', () => {
    expect(suggestRouteName(['bastion', 'prod-db'])).toBe('prod-db');
    expect(suggestRouteName([])).toBe('');
  });
});

describe('saved route list', () => {
  it('adds newest first and replaces an entry with the same name', () => {
    const first = upsertSavedRoute([], 'prod', ['bastion', 'prod']);
    const second = upsertSavedRoute(first, 'stage', ['stage']);
    const replaced = upsertSavedRoute(second, 'prod', ['bastion', 'dmz', 'prod']);
    expect(replaced.map((entry) => entry.name)).toEqual(['prod', 'stage']);
    expect(replaced[0]?.route).toEqual(['bastion', 'dmz', 'prod']);
    expect(replaced[0]?.id).toBe(first[0]?.id);
  });

  it('rejects an unnamed or empty route', () => {
    expect(upsertSavedRoute([], '   ', ['prod'])).toEqual([]);
    expect(upsertSavedRoute([], 'prod', [])).toEqual([]);
  });

  it('bounds the stored list and removes by id', () => {
    let saved = upsertSavedRoute([], 'keep', ['keep']);
    for (let index = 0; index < MAX_SAVED_ROUTES + 10; index += 1) {
      saved = upsertSavedRoute(saved, `route-${index}`, [`host-${index}`]);
    }
    expect(saved).toHaveLength(MAX_SAVED_ROUTES);
    const target = saved[0];
    expect(target).toBeDefined();
    expect(removeSavedRoute(saved, target!.id)).toHaveLength(MAX_SAVED_ROUTES - 1);
  });

  it('reports aliases that disappeared from the SSH config', () => {
    expect(missingAliases(['bastion', 'prod'], ['bastion'])).toEqual(['prod']);
    expect(missingAliases(['bastion'], ['bastion', 'prod'])).toEqual([]);
  });
});

describe('workspace persistence', () => {
  it('restores saved routes, tabs and the active tab', () => {
    const state = parseWorkspaces(
      JSON.stringify({
        saved: [{ id: 'a', name: 'prod', route: ['bastion', 'prod'] }],
        tabs: [['bastion'], ['bastion', 'prod']],
        activeTab: 1,
        paneLayout: {
          type: 'split', axis: 'horizontal', ratio: 0.6,
          first: { type: 'leaf', tab: 0 }, second: { type: 'leaf', tab: 1 },
        },
      }),
    );
    expect(state.saved).toEqual([{ id: 'a', name: 'prod', route: ['bastion', 'prod'] }]);
    expect(state.tabs).toEqual([['bastion'], ['bastion', 'prod']]);
    expect(state.activeTab).toBe(1);
    expect(state.paneLayout).toMatchObject({ type: 'split', ratio: 0.6 });
  });

  it('maps runtime session keys to tab indexes and back', () => {
    const runtime = splitPane(paneLeaf('session-a'), 'session-a', 'session-b', 'vertical');
    const stored = storePaneLayout(runtime, ['session-a', 'session-b']);
    expect(stored).toEqual({
      type: 'split', axis: 'vertical', ratio: 0.5,
      first: { type: 'leaf', tab: 0 }, second: { type: 'leaf', tab: 1 },
    });
    expect(restorePaneLayout(stored, ['new-a', 'new-b'])).toEqual({
      type: 'split', axis: 'vertical', ratio: 0.5,
      first: { type: 'leaf', sessionKey: 'new-a' }, second: { type: 'leaf', sessionKey: 'new-b' },
    });
  });

  it('drops malformed entries instead of failing to start', () => {
    const state = parseWorkspaces(
      JSON.stringify({
        saved: [{ name: 'prod', route: ['prod'] }, { name: 'prod', route: ['dup'] }, { name: '', route: ['x'] }, 7],
        tabs: [[], ['prod'], 'nope'],
        activeTab: 9,
      }),
    );
    expect(state.saved.map((entry) => entry.name)).toEqual(['prod']);
    expect(state.saved[0]?.id).toMatch(/[0-9a-f-]{36}/u);
    expect(state.tabs).toEqual([['prod']]);
    expect(state.activeTab).toBe(-1);
  });

  it('bounds the restored tab count', () => {
    const tabs = Array.from({ length: MAX_RESTORED_TABS + 5 }, (_, index) => [`host-${index}`]);
    expect(parseWorkspaces(JSON.stringify({ tabs })).tabs).toHaveLength(MAX_RESTORED_TABS);
  });

  it('falls back to an empty workspace for corrupt or unreadable storage', () => {
    expect(parseWorkspaces('not json')).toEqual({ saved: [], tabs: [], activeTab: -1, paneLayout: null });
    expect(parseWorkspaces(null)).toEqual({ saved: [], tabs: [], activeTab: -1, paneLayout: null });
    const storage = {
      getItem: () => {
        throw new Error('storage disabled');
      },
    };
    expect(loadWorkspaces(storage)).toEqual({ saved: [], tabs: [], activeTab: -1, paneLayout: null });
  });
});

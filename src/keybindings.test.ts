import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYBINDINGS,
  defaultKeybindings,
  evaluateWhen,
  eventToChord,
  exportKeybindings,
  findKeybindingConflicts,
  formatKeySequence,
  importKeybindings,
  loadKeybindings,
  normalizeKeySequence,
  resolveKeybinding,
  saveKeybindings,
  type CommandContext,
  type CommandContextRule,
} from './keybindings';

const routeContext: CommandContext = {
  terminalFocus: false,
  routeFocus: true,
  paletteOpen: false,
  shortcutEditorOpen: false,
};

describe('keybindings', () => {
  it('normalizes modifiers in a stable order', () => {
    const event = { key: 'p', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
    expect(eventToChord(event as KeyboardEvent)).toBe('Ctrl+Shift+P');
    expect(normalizeKeySequence('shift+ctrl+k   command+s')).toBe('Ctrl+Shift+K Meta+S');
  });

  it('uses the operating system primary modifier and formats macOS labels', () => {
    expect(defaultKeybindings('linux')['route.connect']).toBe('Ctrl+Enter');
    expect(defaultKeybindings('macos')['route.connect']).toBe('Meta+Enter');
    expect(formatKeySequence('Meta+K Meta+S', 'macos')).toBe('Cmd+K Cmd+S');
  });

  it('merges valid legacy overrides over defaults', () => {
    const storage = {
      getItem: (key: string) =>
        key.endsWith('.v1') ? JSON.stringify({ 'route.connect': 'Alt+Enter', bad: 42 }) : null,
    };
    expect(loadKeybindings(storage, 'linux')['route.connect']).toBe('Alt+Enter');
    expect(loadKeybindings(storage, 'linux')['workbench.action.showCommands']).toBe(
      DEFAULT_KEYBINDINGS['workbench.action.showCommands'],
    );
    expect(loadKeybindings(storage, 'macos')['workbench.action.showCommands']).toBe('Meta+Shift+P');
    expect(loadKeybindings(storage, 'macos')['route.connect']).toBe('Alt+Enter');
  });

  it('saves and reloads the versioned format', () => {
    let saved = '';
    saveKeybindings(
      { ...DEFAULT_KEYBINDINGS, 'route.connect': 'Ctrl+K Ctrl+C' },
      { setItem: (_key, value) => { saved = value; } },
      'linux',
    );
    expect(JSON.parse(saved)).toMatchObject({ version: 2, platform: 'linux' });
    expect(loadKeybindings({ getItem: (key) => (key.endsWith('.v2') ? saved : null) }, 'linux')['route.connect'])
      .toBe('Ctrl+K Ctrl+C');
  });

  it('evaluates route, terminal, palette, and editor context keys', () => {
    expect(evaluateWhen('routeFocus && !paletteOpen', routeContext)).toBe(true);
    expect(evaluateWhen('terminalFocus || paletteOpen', routeContext)).toBe(false);
    expect(evaluateWhen('unknownContext', routeContext)).toBe(false);
  });

  it('resolves a multi-chord prefix and then the complete command', () => {
    const rules: CommandContextRule[] = [{ id: 'route.save', when: 'routeFocus' }];
    expect(resolveKeybinding(['Ctrl+K'], DEFAULT_KEYBINDINGS, rules, routeContext)).toEqual({
      status: 'pending',
    });
    expect(resolveKeybinding(['Ctrl+K', 'Ctrl+S'], DEFAULT_KEYBINDINGS, rules, routeContext)).toEqual({
      status: 'match',
      commandId: 'route.save',
    });
    expect(resolveKeybinding(['Ctrl+K', 'Ctrl+S'], DEFAULT_KEYBINDINGS, rules, {
      ...routeContext,
      routeFocus: false,
    })).toEqual({ status: 'none' });
  });

  it('reports only conflicts whose contexts can overlap', () => {
    const bindings = {
      ...DEFAULT_KEYBINDINGS,
      'route.connect': 'Ctrl+Enter',
      'session.reconnect': 'Ctrl+Enter',
      'route.clear': 'Ctrl+Enter',
    };
    const separated: CommandContextRule[] = [
      { id: 'route.connect', when: 'routeFocus' },
      { id: 'session.reconnect', when: 'terminalFocus && !routeFocus' },
    ];
    expect(findKeybindingConflicts(bindings, separated)).toEqual([]);

    const overlapping: CommandContextRule[] = [
      ...separated,
      { id: 'route.clear', when: 'routeFocus' },
    ];
    expect(findKeybindingConflicts(bindings, overlapping)).toEqual([
      { sequence: 'Ctrl+Enter', commands: ['route.connect', 'route.clear'] },
    ]);
  });

  it('exports JSON and migrates Ctrl/Cmd across operating systems', () => {
    const exported = exportKeybindings(DEFAULT_KEYBINDINGS, 'linux');
    const imported = importKeybindings(exported, 'macos');
    expect(imported.migratedFrom).toBe('linux');
    expect(imported.bindings['route.connect']).toBe('Meta+Enter');
    expect(imported.bindings['route.save']).toBe('Meta+K Meta+S');
  });

  it('rejects unsupported or oversized imports', () => {
    expect(() => importKeybindings('{"version":1}', 'linux')).toThrow(/version 2/u);
    expect(() => importKeybindings('x'.repeat(65 * 1024), 'linux')).toThrow(/64 KiB/u);
  });
});

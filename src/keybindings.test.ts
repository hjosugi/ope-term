import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYBINDINGS,
  defaultKeybindings,
  evaluateWhen,
  eventToChord,
  exportKeybindings,
  findKeybindingConflicts,
  findKeybindingWarnings,
  formatKeySequence,
  importKeybindings,
  isBareChord,
  isTerminalReservedChord,
  loadKeybindings,
  migratePrimaryModifier,
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
    expect(saveKeybindings(
      { ...DEFAULT_KEYBINDINGS, 'route.connect': 'Ctrl+K Ctrl+C' },
      { setItem: (_key, value) => { saved = value; } },
      'linux',
    )).toBe(true);
    expect(JSON.parse(saved)).toMatchObject({ version: 2, platform: 'linux' });
    expect(loadKeybindings({ getItem: (key) => (key.endsWith('.v2') ? saved : null) }, 'linux')['route.connect'])
      .toBe('Ctrl+K Ctrl+C');
  });

  it('keeps storage failures non-fatal', () => {
    expect(saveKeybindings(
      DEFAULT_KEYBINDINGS,
      { setItem: () => { throw new Error('quota'); } },
      'linux',
    )).toBe(false);
    expect(loadKeybindings({ getItem: () => { throw new Error('disabled'); } }, 'linux'))
      .toEqual(DEFAULT_KEYBINDINGS);
    expect(loadKeybindings({ getItem: () => 'x'.repeat(64 * 1024 + 1) }, 'linux'))
      .toEqual(DEFAULT_KEYBINDINGS);
  });

  it('evaluates route, terminal, palette, and editor context keys', () => {
    expect(evaluateWhen('routeFocus && !paletteOpen', routeContext)).toBe(true);
    expect(evaluateWhen('terminalFocus || paletteOpen', routeContext)).toBe(false);
    expect(evaluateWhen('unknownContext', routeContext)).toBe(false);
  });

  it('resolves a multi-chord prefix and then the complete command', () => {
    const rules: CommandContextRule[] = [{ id: 'route.save', when: 'routeFocus' }];
    expect(resolveKeybinding(['Ctrl+Shift+K'], DEFAULT_KEYBINDINGS, rules, routeContext)).toEqual({
      status: 'pending',
    });
    expect(resolveKeybinding(['Ctrl+Shift+K', 'Ctrl+S'], DEFAULT_KEYBINDINGS, rules, routeContext)).toEqual({
      status: 'match',
      commandId: 'route.save',
    });
    expect(resolveKeybinding(['Ctrl+Shift+K', 'Ctrl+S'], DEFAULT_KEYBINDINGS, rules, {
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
    expect(imported.bindings['session.close']).toBe('Meta+W');
    expect(imported.invalid).toBe(0);
  });

  it('keeps shell-owned Ctrl keys out of the Linux and Windows defaults', () => {
    for (const platform of ['linux', 'windows'] as const) {
      const defaults = defaultKeybindings(platform);
      const terminalCommands = [
        'session.close', 'session.next', 'session.reconnect', 'session.toggleSftp',
        'pane.splitRight', 'pane.splitDown', 'pane.close', 'pane.resizeWider',
        'terminal.previousCommand', 'terminal.nextCommand',
      ] as const;
      for (const id of terminalCommands) {
        const first = defaults[id].split(' ')[0] ?? '';
        expect(isTerminalReservedChord(first, platform), `${platform} ${id} ${defaults[id]}`).toBe(false);
      }
      expect(defaults['session.close']).toBe('Ctrl+Shift+W');
    }
    expect(defaultKeybindings('macos')['session.next']).toBe('Ctrl+Tab');
  });

  it('passes plain Ctrl keys to the shell only on Linux and Windows', () => {
    expect(isTerminalReservedChord('Ctrl+W', 'linux')).toBe(true);
    expect(isTerminalReservedChord('Ctrl+K', 'windows')).toBe(true);
    expect(isTerminalReservedChord('Ctrl+[', 'linux')).toBe(true);
    expect(isTerminalReservedChord('Ctrl+Shift+W', 'linux')).toBe(false);
    expect(isTerminalReservedChord('Ctrl+Tab', 'linux')).toBe(false);
    expect(isTerminalReservedChord('Ctrl+ArrowUp', 'linux')).toBe(false);
    expect(isTerminalReservedChord('Ctrl+W', 'macos')).toBe(false);
  });

  it('resolves an exact shortcut at once when no longer chord shares its prefix', () => {
    const rules: CommandContextRule[] = [
      { id: 'workbench.action.quickOpenHost', when: '!paletteOpen' },
      { id: 'route.save', when: 'routeFocus' },
    ];
    expect(resolveKeybinding(['Ctrl+K'], DEFAULT_KEYBINDINGS, rules, routeContext)).toEqual({
      status: 'match',
      commandId: 'workbench.action.quickOpenHost',
    });
  });

  it('upgrades stored bindings that still equal the previous defaults', () => {
    const stored = exportKeybindings(
      {
        ...DEFAULT_KEYBINDINGS,
        'session.close': 'Ctrl+W',
        'pane.splitRight': 'Ctrl+K Ctrl+ArrowRight',
        'route.connect': 'Alt+Enter',
      },
      'linux',
    );
    const loaded = loadKeybindings({ getItem: (key) => (key.endsWith('.v2') ? stored : null) }, 'linux');
    expect(loaded['session.close']).toBe('Ctrl+Shift+W');
    expect(loaded['pane.splitRight']).toBe('Ctrl+Shift+K Ctrl+ArrowRight');
    expect(loaded['route.connect']).toBe('Alt+Enter');
  });

  it('swaps Ctrl and Cmd in both directions and re-normalizes', () => {
    expect(migratePrimaryModifier('Ctrl+Alt+X Ctrl+Y', 'linux', 'macos')).toBe('Alt+Meta+X Meta+Y');
    expect(migratePrimaryModifier('Meta+Shift+J', 'macos', 'windows')).toBe('Ctrl+Shift+J');
    expect(migratePrimaryModifier('Ctrl+Meta+X', 'macos', 'linux')).toBe('Ctrl+Meta+X');
    expect(migratePrimaryModifier('Ctrl+Tab', 'linux', 'macos')).toBe('Ctrl+Tab');
    expect(migratePrimaryModifier('Ctrl+X', 'linux', 'windows')).toBe('Ctrl+X');
    const fromMac = importKeybindings(
      exportKeybindings({ ...defaultKeybindings('macos'), 'route.connect': 'Meta+Alt+C' }, 'macos'),
      'linux',
    );
    expect(fromMac.migratedFrom).toBe('macos');
    expect(fromMac.bindings['route.connect']).toBe('Ctrl+Alt+C');
    expect(fromMac.bindings['pane.close']).toBe(DEFAULT_KEYBINDINGS['pane.close']);
  });

  it('shows Cmd / Option on macOS and Win on Windows', () => {
    expect(formatKeySequence('Meta+Alt+K', 'macos')).toBe('Option+Cmd+K');
    expect(formatKeySequence('Meta+L', 'windows')).toBe('Win+L');
    expect(formatKeySequence('Ctrl+Meta+K', 'linux')).toBe('Ctrl+Meta+K');
  });

  it('counts invalid imported sequences instead of dropping them silently', () => {
    const imported = importKeybindings(
      JSON.stringify({ version: 2, platform: 'linux', bindings: { 'route.connect': 'Ctrl+', 'route.new': 42, unknown: 'Ctrl+U' } }),
      'linux',
    );
    expect(imported.invalid).toBe(2);
    expect(imported.bindings['route.connect']).toBe(DEFAULT_KEYBINDINGS['route.connect']);
  });

  it('warns about prefixes, bare keys, and keys the OS or shell takes first', () => {
    const bindings = {
      ...DEFAULT_KEYBINDINGS,
      'route.clear': 'Ctrl+Shift+K',
      'hosts.reload': 'A',
      'session.reconnect': 'Ctrl+R',
      'workbench.openLogs': 'F5',
    };
    const rules: CommandContextRule[] = [
      { id: 'route.clear', when: 'routeFocus' },
      { id: 'route.save', when: 'routeFocus' },
      { id: 'hosts.reload', when: 'routeFocus' },
      { id: 'session.reconnect', when: 'terminalFocus' },
      { id: 'workbench.openLogs' },
    ];
    const warnings = findKeybindingWarnings(bindings, rules, 'linux');
    const kinds = (id: string) => warnings.filter((warning) => warning.commandId === id).map((warning) => warning.kind);
    expect(kinds('route.clear')).toEqual(['prefix']);
    expect(kinds('hosts.reload')).toEqual(['bare']);
    expect(kinds('session.reconnect')).toEqual(['reserved']);
    expect(kinds('workbench.openLogs')).toEqual([]);
    expect(kinds('route.save')).toEqual([]);
    expect(isBareChord('Shift+A')).toBe(true);
    expect(isBareChord('F12')).toBe(false);

    const mac = findKeybindingWarnings({ ...defaultKeybindings('macos'), 'route.new': 'Meta+Q' }, [{ id: 'route.new' }], 'macos');
    expect(mac.map((warning) => warning.kind)).toEqual(['reserved']);
  });

  it('keeps the shipped defaults free of warnings on every platform', () => {
    for (const platform of ['linux', 'windows', 'macos'] as const) {
      const rules: CommandContextRule[] = [
        { id: 'workbench.action.showCommands', when: '!shortcutEditorOpen' },
        { id: 'workbench.action.quickOpenHost', when: '!paletteOpen && !shortcutEditorOpen' },
        { id: 'route.save', when: 'routeFocus && !paletteOpen && !shortcutEditorOpen' },
        { id: 'session.close', when: 'terminalFocus && !paletteOpen && !shortcutEditorOpen' },
        { id: 'pane.close', when: 'terminalFocus && !paletteOpen && !shortcutEditorOpen' },
        { id: 'preferences.openKeyboardShortcuts', when: '!paletteOpen && !shortcutEditorOpen' },
      ];
      expect(findKeybindingWarnings(defaultKeybindings(platform), rules, platform), platform).toEqual(
        platform === 'macos'
          ? [expect.objectContaining({ kind: 'prefix', commandId: 'workbench.action.quickOpenHost' })]
          : [],
      );
    }
  });

  it('rejects unsupported or oversized imports', () => {
    expect(() => importKeybindings('{"version":1}', 'linux')).toThrow(/version 2/u);
    expect(() => importKeybindings('x'.repeat(65 * 1024), 'linux')).toThrow(/64 KiB/u);
  });
});

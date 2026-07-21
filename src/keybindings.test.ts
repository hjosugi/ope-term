import { describe, expect, it } from 'vitest';
import { DEFAULT_KEYBINDINGS, eventToChord, loadKeybindings } from './keybindings';

describe('keybindings', () => {
  it('normalizes modifiers in a stable order', () => {
    const event = { key: 'p', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
    expect(eventToChord(event as KeyboardEvent)).toBe('Ctrl+Shift+P');
  });

  it('merges valid saved overrides over defaults', () => {
    const storage = { getItem: () => JSON.stringify({ 'route.connect': 'Alt+Enter', bad: 42 }) };
    expect(loadKeybindings(storage)['route.connect']).toBe('Alt+Enter');
    expect(loadKeybindings(storage)['workbench.action.showCommands']).toBe(
      DEFAULT_KEYBINDINGS['workbench.action.showCommands'],
    );
  });
});

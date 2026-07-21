export type CommandId =
  | 'workbench.action.showCommands'
  | 'workbench.action.quickOpenHost'
  | 'route.connect'
  | 'route.clear'
  | 'route.new'
  | 'session.close'
  | 'session.next'
  | 'preferences.openKeyboardShortcuts';

export const DEFAULT_KEYBINDINGS: Record<CommandId, string> = {
  'workbench.action.showCommands': 'Ctrl+Shift+P',
  'workbench.action.quickOpenHost': 'Ctrl+K',
  'route.connect': 'Ctrl+Enter',
  'route.clear': 'Ctrl+Backspace',
  'route.new': 'Ctrl+N',
  'session.close': 'Ctrl+W',
  'session.next': 'Ctrl+Tab',
  'preferences.openKeyboardShortcuts': 'Ctrl+Shift+K',
};

const STORAGE_KEY = 'ope-term.keybindings.v1';

export function eventToChord(event: KeyboardEvent): string | null {
  const key = normalizeKey(event.key);
  if (!key || ['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  if (event.metaKey) parts.push('Meta');
  parts.push(key);
  return parts.join('+');
}

export function normalizeKey(key: string): string {
  if (key === ' ') return 'Space';
  if (key.length === 1) return key.toUpperCase();
  return key;
}

export function loadKeybindings(storage: Pick<Storage, 'getItem'> = localStorage): Record<CommandId, string> {
  const output = { ...DEFAULT_KEYBINDINGS };
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    for (const id of Object.keys(output) as CommandId[]) {
      if (typeof parsed[id] === 'string' && parsed[id]) output[id] = parsed[id];
    }
  } catch {
    // A corrupt preference must never prevent the terminal from starting.
  }
  return output;
}

export function saveKeybindings(
  bindings: Record<CommandId, string>,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(bindings));
}

export const COMMAND_IDS = [
  'workbench.action.showCommands',
  'workbench.action.quickOpenHost',
  'route.connect',
  'route.clear',
  'route.new',
  'route.save',
  'hosts.reload',
  'session.close',
  'session.next',
  'session.reconnect',
  'session.newLocal',
  'session.toggleSftp',
  'session.configureLogs',
  'workbench.openLogs',
  'pane.splitRight',
  'pane.splitDown',
  'pane.focusLeft',
  'pane.focusRight',
  'pane.focusUp',
  'pane.focusDown',
  'pane.close',
  'pane.resizeWider',
  'pane.resizeNarrower',
  'pane.resizeTaller',
  'pane.resizeShorter',
  'preferences.openKeyboardShortcuts',
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];
export type OperatingSystem = 'linux' | 'macos' | 'windows';
export type ContextKey = 'terminalFocus' | 'routeFocus' | 'paletteOpen' | 'shortcutEditorOpen';
export type CommandContext = Record<ContextKey, boolean>;

export interface CommandContextRule {
  id: CommandId;
  when?: string;
}

export interface KeybindingConflict {
  sequence: string;
  commands: CommandId[];
}

export type KeybindingResolution =
  | { status: 'none' }
  | { status: 'pending'; exactCommandId?: CommandId }
  | { status: 'match'; commandId: CommandId };

export interface ImportedKeybindings {
  bindings: Record<CommandId, string>;
  migratedFrom?: OperatingSystem;
}

export const KEY_SEQUENCE_TIMEOUT_MS = 1_200;

const STORAGE_KEY = 'ope-term.keybindings.v2';
const LEGACY_STORAGE_KEY = 'ope-term.keybindings.v1';
const EXPORT_VERSION = 2;
const MAX_IMPORT_BYTES = 64 * 1024;
const MAX_SEQUENCE_CHORDS = 4;
const CONTEXT_KEYS: readonly ContextKey[] = [
  'terminalFocus',
  'routeFocus',
  'paletteOpen',
  'shortcutEditorOpen',
];

export function defaultKeybindings(platform: OperatingSystem): Record<CommandId, string> {
  const primary = platform === 'macos' ? 'Meta' : 'Ctrl';
  return {
    'workbench.action.showCommands': `${primary}+Shift+P`,
    'workbench.action.quickOpenHost': `${primary}+K`,
    'route.connect': `${primary}+Enter`,
    'route.clear': `${primary}+Backspace`,
    'route.new': `${primary}+N`,
    'route.save': `${primary}+K ${primary}+S`,
    'hosts.reload': `${primary}+Shift+R`,
    'session.close': `${primary}+W`,
    'session.next': `${primary}+Tab`,
    'session.reconnect': `${primary}+Shift+Enter`,
    'session.newLocal': `${primary}+Shift+L`,
    'session.toggleSftp': `${primary}+Shift+F`,
    'session.configureLogs': `${primary}+Shift+G`,
    'workbench.openLogs': `${primary}+Alt+G`,
    'pane.splitRight': `${primary}+K ${primary}+ArrowRight`,
    'pane.splitDown': `${primary}+K ${primary}+ArrowDown`,
    'pane.focusLeft': `${primary}+Alt+ArrowLeft`,
    'pane.focusRight': `${primary}+Alt+ArrowRight`,
    'pane.focusUp': `${primary}+Alt+ArrowUp`,
    'pane.focusDown': `${primary}+Alt+ArrowDown`,
    'pane.close': `${primary}+K ${primary}+X`,
    'pane.resizeWider': `${primary}+K ${primary}+Shift+ArrowRight`,
    'pane.resizeNarrower': `${primary}+K ${primary}+Shift+ArrowLeft`,
    'pane.resizeTaller': `${primary}+K ${primary}+Shift+ArrowDown`,
    'pane.resizeShorter': `${primary}+K ${primary}+Shift+ArrowUp`,
    'preferences.openKeyboardShortcuts': `${primary}+K ${primary}+K`,
  };
}

export const DEFAULT_KEYBINDINGS = defaultKeybindings('linux');

export function detectOperatingSystem(userAgent = globalThis.navigator?.userAgent ?? ''): OperatingSystem {
  const normalized = userAgent.toLowerCase();
  if (normalized.includes('macintosh') || normalized.includes('mac os')) return 'macos';
  if (normalized.includes('windows')) return 'windows';
  return 'linux';
}

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

export function normalizeKeySequence(value: string): string | null {
  const rawChords = value.trim().split(/\s+/u).filter(Boolean);
  if (rawChords.length === 0 || rawChords.length > MAX_SEQUENCE_CHORDS) return null;
  const chords = rawChords.map(normalizeChord);
  return chords.every((chord): chord is string => chord !== null) ? chords.join(' ') : null;
}

export function formatKeySequence(sequence: string, platform: OperatingSystem): string {
  const normalized = normalizeKeySequence(sequence) ?? sequence;
  if (platform !== 'macos') return normalized;
  return normalized
    .split(' ')
    .map((chord) => chord.replaceAll('Meta', 'Cmd').replaceAll('Alt', 'Option'))
    .join(' ');
}

export function evaluateWhen(expression: string | undefined, context: CommandContext): boolean {
  if (!expression?.trim()) return true;
  return expression.split('||').some((disjunction) =>
    disjunction.split('&&').every((rawTerm) => {
      const term = rawTerm.trim();
      const negated = term.startsWith('!');
      const key = (negated ? term.slice(1) : term) as ContextKey;
      if (!CONTEXT_KEYS.includes(key)) return false;
      return negated ? !context[key] : context[key];
    }),
  );
}

export function resolveKeybinding(
  chords: readonly string[],
  bindings: Record<CommandId, string>,
  rules: readonly CommandContextRule[],
  context: CommandContext,
): KeybindingResolution {
  const sequence = normalizeKeySequence(chords.join(' '));
  if (!sequence) return { status: 'none' };

  const candidates = rules.filter((rule) => {
    if (!evaluateWhen(rule.when, context)) return false;
    const binding = normalizeKeySequence(bindings[rule.id]);
    return binding === sequence || binding?.startsWith(`${sequence} `);
  });
  if (candidates.length === 0) return { status: 'none' };

  const exact = candidates.find((rule) => normalizeKeySequence(bindings[rule.id]) === sequence);
  const hasLongerSequence = candidates.some((rule) => normalizeKeySequence(bindings[rule.id]) !== sequence);
  if (exact && !hasLongerSequence) return { status: 'match', commandId: exact.id };
  return exact ? { status: 'pending', exactCommandId: exact.id } : { status: 'pending' };
}

export function findKeybindingConflicts(
  bindings: Record<CommandId, string>,
  rules: readonly CommandContextRule[],
): KeybindingConflict[] {
  const bySequence = new Map<string, CommandContextRule[]>();
  for (const rule of rules) {
    const sequence = normalizeKeySequence(bindings[rule.id]);
    if (!sequence) continue;
    const existing = bySequence.get(sequence) ?? [];
    existing.push(rule);
    bySequence.set(sequence, existing);
  }

  const conflicts: KeybindingConflict[] = [];
  for (const [sequence, candidates] of bySequence) {
    const commands = candidates
      .filter((candidate, index) =>
        candidates.some(
          (other, otherIndex) =>
            otherIndex !== index && contextsOverlap(candidate.when, other.when),
        ),
      )
      .map((candidate) => candidate.id);
    if (commands.length > 1) conflicts.push({ sequence, commands });
  }
  return conflicts;
}

export function loadKeybindings(
  storage: Pick<Storage, 'getItem'> = localStorage,
  platform: OperatingSystem = detectOperatingSystem(),
): Record<CommandId, string> {
  const defaults = defaultKeybindings(platform);
  try {
    const current = storage.getItem(STORAGE_KEY);
    if (current) return parseExport(current, platform).bindings;

    const legacy = storage.getItem(LEGACY_STORAGE_KEY);
    if (!legacy) return defaults;
    const parsed = JSON.parse(legacy) as unknown;
    const legacyBindings = mergeBindings(DEFAULT_KEYBINDINGS, parsed);
    if (platform !== 'macos') return legacyBindings;
    return Object.fromEntries(
      COMMAND_IDS.map((id) => [
        id,
        legacyBindings[id] === DEFAULT_KEYBINDINGS[id] ? defaults[id] : legacyBindings[id],
      ]),
    ) as Record<CommandId, string>;
  } catch {
    // A corrupt preference must never prevent the terminal from starting.
    return defaults;
  }
}

export function saveKeybindings(
  bindings: Record<CommandId, string>,
  storage: Pick<Storage, 'setItem'> = localStorage,
  platform: OperatingSystem = detectOperatingSystem(),
): void {
  storage.setItem(STORAGE_KEY, exportKeybindings(bindings, platform));
}

export function exportKeybindings(
  bindings: Record<CommandId, string>,
  platform: OperatingSystem,
): string {
  return JSON.stringify(
    {
      version: EXPORT_VERSION,
      platform,
      bindings: Object.fromEntries(COMMAND_IDS.map((id) => [id, bindings[id]])),
    },
    null,
    2,
  );
}

export function importKeybindings(json: string, platform: OperatingSystem): ImportedKeybindings {
  if (new TextEncoder().encode(json).byteLength > MAX_IMPORT_BYTES) {
    throw new Error('shortcut 設定は 64 KiB 以下にしてください');
  }
  try {
    return parseExport(json, platform);
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error('shortcut 設定を読み込めませんでした');
  }
}

function normalizeChord(value: string): string | null {
  const rawParts = value.split('+').map((part) => part.trim()).filter(Boolean);
  if (rawParts.length === 0) return null;
  const modifiers = new Set<string>();
  let key: string | null = null;
  for (const rawPart of rawParts) {
    const lower = rawPart.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') modifiers.add('Ctrl');
    else if (lower === 'shift') modifiers.add('Shift');
    else if (lower === 'alt' || lower === 'option') modifiers.add('Alt');
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command') modifiers.add('Meta');
    else if (key === null) key = normalizeKey(rawPart);
    else return null;
  }
  if (!key || ['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return null;
  const ordered = ['Ctrl', 'Shift', 'Alt', 'Meta'].filter((modifier) => modifiers.has(modifier));
  return [...ordered, key].join('+');
}

function contextsOverlap(first: string | undefined, second: string | undefined): boolean {
  const variants = 2 ** CONTEXT_KEYS.length;
  for (let mask = 0; mask < variants; mask += 1) {
    const context = Object.fromEntries(
      CONTEXT_KEYS.map((key, index) => [key, Boolean(mask & (1 << index))]),
    ) as CommandContext;
    if (evaluateWhen(first, context) && evaluateWhen(second, context)) return true;
  }
  return false;
}

function parseExport(json: string, platform: OperatingSystem): ImportedKeybindings {
  const parsed = JSON.parse(json) as unknown;
  if (!isRecord(parsed) || parsed.version !== EXPORT_VERSION || !isOperatingSystem(parsed.platform)) {
    throw new Error('対応している shortcut JSON（version 2）ではありません');
  }
  const sourcePlatform = parsed.platform;
  const defaults = defaultKeybindings(platform);
  const merged = mergeBindings(defaults, parsed.bindings);
  if (sourcePlatform === platform) return { bindings: merged };
  return {
    bindings: Object.fromEntries(
      COMMAND_IDS.map((id) => [id, migratePrimaryModifier(merged[id], sourcePlatform, platform)]),
    ) as Record<CommandId, string>,
    migratedFrom: sourcePlatform,
  };
}

function mergeBindings(defaults: Record<CommandId, string>, value: unknown): Record<CommandId, string> {
  if (!isRecord(value)) return defaults;
  const output = { ...defaults };
  for (const id of COMMAND_IDS) {
    const candidate = value[id];
    if (typeof candidate !== 'string') continue;
    const normalized = normalizeKeySequence(candidate);
    if (normalized) output[id] = normalized;
  }
  return output;
}

function migratePrimaryModifier(
  sequence: string,
  source: OperatingSystem,
  target: OperatingSystem,
): string {
  if (source === target || (source !== 'macos' && target !== 'macos')) return sequence;
  const from = source === 'macos' ? 'Meta' : 'Ctrl';
  const to = target === 'macos' ? 'Meta' : 'Ctrl';
  return sequence
    .split(' ')
    .map((chord) => chord.split('+').map((part) => (part === from ? to : part)).join('+'))
    .join(' ');
}

function isOperatingSystem(value: unknown): value is OperatingSystem {
  return value === 'linux' || value === 'macos' || value === 'windows';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

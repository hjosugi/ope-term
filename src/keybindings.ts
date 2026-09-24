import { readBoundedStorage, writeBoundedStorage } from './storage';

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
  'terminal.previousCommand',
  'terminal.nextCommand',
  'pane.moveLeft',
  'pane.moveRight',
  'pane.moveUp',
  'pane.moveDown',
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

export type KeybindingWarningKind = 'conflict' | 'prefix' | 'bare' | 'reserved';

export interface KeybindingWarning {
  kind: KeybindingWarningKind;
  commandId: CommandId;
  message: string;
}

export type KeybindingResolution =
  | { status: 'none' }
  | { status: 'pending'; exactCommandId?: CommandId }
  | { status: 'match'; commandId: CommandId };

export interface ImportedKeybindings {
  bindings: Record<CommandId, string>;
  migratedFrom?: OperatingSystem;
  /** Known commands whose imported key sequence was invalid and kept its default. */
  invalid: number;
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

/**
 * Default shortcuts. On Linux / Windows the shell owns plain `Ctrl+<key>`
 * (`Ctrl+W` deletes a word, `Ctrl+K` kills to end of line), so commands that
 * must work while typing in a terminal use `Ctrl+Shift` there, and multi-chord
 * commands start with `Ctrl+Shift+K`. macOS uses Cmd, which shells never see;
 * session switching stays on `Ctrl+Tab` because `Cmd+Tab` is the app switcher.
 */
export function defaultKeybindings(platform: OperatingSystem): Record<CommandId, string> {
  const primary = platform === 'macos' ? 'Meta' : 'Ctrl';
  const chord = platform === 'macos' ? 'Meta+K' : 'Ctrl+Shift+K';
  return {
    'workbench.action.showCommands': `${primary}+Shift+P`,
    'workbench.action.quickOpenHost': `${primary}+K`,
    'route.connect': `${primary}+Enter`,
    'route.clear': `${primary}+Backspace`,
    'route.new': `${primary}+N`,
    'route.save': `${chord} ${primary}+S`,
    'hosts.reload': `${primary}+Shift+R`,
    'session.close': platform === 'macos' ? 'Meta+W' : 'Ctrl+Shift+W',
    'session.next': 'Ctrl+Tab',
    'session.reconnect': `${primary}+Shift+Enter`,
    'session.newLocal': `${primary}+Shift+L`,
    'session.toggleSftp': `${primary}+Shift+F`,
    'session.configureLogs': `${primary}+Shift+G`,
    'workbench.openLogs': `${primary}+Alt+G`,
    'pane.splitRight': `${chord} ${primary}+ArrowRight`,
    'pane.splitDown': `${chord} ${primary}+ArrowDown`,
    'pane.focusLeft': `${primary}+Alt+ArrowLeft`,
    'pane.focusRight': `${primary}+Alt+ArrowRight`,
    'pane.focusUp': `${primary}+Alt+ArrowUp`,
    'pane.focusDown': `${primary}+Alt+ArrowDown`,
    'pane.close': `${chord} ${primary}+X`,
    'pane.resizeWider': `${chord} ${primary}+Shift+ArrowRight`,
    'pane.resizeNarrower': `${chord} ${primary}+Shift+ArrowLeft`,
    'pane.resizeTaller': `${chord} ${primary}+Shift+ArrowDown`,
    'pane.resizeShorter': `${chord} ${primary}+Shift+ArrowUp`,
    'terminal.previousCommand': `${primary}+ArrowUp`,
    'terminal.nextCommand': `${primary}+ArrowDown`,
    'pane.moveLeft': `${primary}+Shift+Alt+ArrowLeft`,
    'pane.moveRight': `${primary}+Shift+Alt+ArrowRight`,
    'pane.moveUp': `${primary}+Shift+Alt+ArrowUp`,
    'pane.moveDown': `${primary}+Shift+Alt+ArrowDown`,
    'preferences.openKeyboardShortcuts': `${chord} ${primary}+K`,
  };
}

/**
 * Defaults shipped before shell-owned chords were avoided. A stored binding
 * that still equals one of these was never customized, so it is upgraded.
 */
function previousDefaultKeybindings(platform: OperatingSystem): Partial<Record<CommandId, string>> {
  const primary = platform === 'macos' ? 'Meta' : 'Ctrl';
  const chordCommands: Partial<Record<CommandId, string>> = {
    'route.save': 'S',
    'pane.splitRight': 'ArrowRight',
    'pane.splitDown': 'ArrowDown',
    'pane.close': 'X',
    'pane.resizeWider': 'Shift+ArrowRight',
    'pane.resizeNarrower': 'Shift+ArrowLeft',
    'pane.resizeTaller': 'Shift+ArrowDown',
    'pane.resizeShorter': 'Shift+ArrowUp',
    'preferences.openKeyboardShortcuts': 'K',
  };
  return {
    ...Object.fromEntries(
      Object.entries(chordCommands).map(([id, key]) => [id, `${primary}+K ${primary}+${key}`]),
    ),
    'session.close': `${primary}+W`,
    'session.next': `${primary}+Tab`,
  };
}

function upgradePreviousDefaults(
  bindings: Record<CommandId, string>,
  platform: OperatingSystem,
): Record<CommandId, string> {
  const previous = previousDefaultKeybindings(platform);
  const current = defaultKeybindings(platform);
  const upgraded = { ...bindings };
  for (const id of COMMAND_IDS) {
    if (previous[id] !== undefined && upgraded[id] === previous[id]) upgraded[id] = current[id];
  }
  return upgraded;
}

const FUNCTION_OR_ESCAPE = /^(?:F(?:[1-9]|1\d|2[0-4])|Escape)$/u;

function chordParts(chord: string): { modifiers: Set<string>; key: string } {
  const parts = chord.split('+');
  return { modifiers: new Set(parts.slice(0, -1)), key: parts.at(-1) ?? '' };
}

/** A first chord without Ctrl / Alt / Cmd would steal plain typing. */
export function isBareChord(chord: string): boolean {
  const { modifiers, key } = chordParts(chord);
  return !modifiers.has('Ctrl') && !modifiers.has('Alt') && !modifiers.has('Meta') && !FUNCTION_OR_ESCAPE.test(key);
}

/**
 * Plain `Ctrl+<key>` on Linux / Windows belongs to the shell and terminal
 * programs (readline, vim, less...). While keyboard focus is in a terminal these
 * are passed through instead of starting a shortcut.
 */
export function isTerminalReservedChord(chord: string, platform: OperatingSystem): boolean {
  if (platform === 'macos') return false;
  const { modifiers, key } = chordParts(chord);
  return modifiers.size === 1 && modifiers.has('Ctrl') && /^(?:[A-Z0-9]|Space|Backspace|[[\]\\/@^_-])$/u.test(key);
}

const OS_RESERVED: Record<OperatingSystem, readonly string[]> = {
  macos: ['Meta+Q', 'Meta+Tab', 'Meta+H', 'Meta+M', 'Meta+Space'],
  linux: ['Alt+Tab', 'Alt+F4'],
  windows: ['Alt+Tab', 'Alt+F4', 'Meta+L', 'Meta+D'],
};

/**
 * Everything the shortcut editor should warn about, per command: identical
 * sequences that can fire in the same context, a sequence that is a prefix of
 * another (it waits for the chord timeout), bare keys, and keys the OS or the
 * terminal takes first.
 */
export function findKeybindingWarnings(
  bindings: Record<CommandId, string>,
  rules: readonly CommandContextRule[],
  platform: OperatingSystem,
): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = [];
  for (const conflict of findKeybindingConflicts(bindings, rules)) {
    for (const commandId of conflict.commands) {
      const others = conflict.commands.filter((candidate) => candidate !== commandId);
      warnings.push({ kind: 'conflict', commandId, message: `競合: ${others.join(', ')}` });
    }
  }
  for (const rule of rules) {
    const sequence = normalizeKeySequence(bindings[rule.id]);
    if (!sequence) continue;
    const first = sequence.split(' ')[0] ?? '';
    for (const other of rules) {
      if (other.id === rule.id) continue;
      const longer = normalizeKeySequence(bindings[other.id]);
      if (longer?.startsWith(`${sequence} `) && contextsOverlap(rule.when, other.when)) {
        warnings.push({
          kind: 'prefix',
          commandId: rule.id,
          message: `${formatKeySequence(sequence, platform)} は ${other.id} の先頭 chord でもあるため、${KEY_SEQUENCE_TIMEOUT_MS / 1000} 秒待ってから実行されます`,
        });
        break;
      }
    }
    if (isBareChord(first)) {
      warnings.push({ kind: 'bare', commandId: rule.id, message: '修飾キーが無いため、入力欄や terminal の文字入力を奪います' });
    }
    if (OS_RESERVED[platform].includes(first)) {
      warnings.push({ kind: 'reserved', commandId: rule.id, message: `${formatKeySequence(first, platform)} は OS が先に使用します` });
    } else if (isTerminalReservedChord(first, platform) && contextImplies(rule.when, 'terminalFocus')) {
      // Only commands that exist solely for the terminal lose their key there;
      // a global command bound to plain Ctrl still works everywhere else.
      warnings.push({
        kind: 'reserved',
        commandId: rule.id,
        message: `${formatKeySequence(first, platform)} は terminal 入力中は shell へ渡されるため、terminal では動作しません`,
      });
    }
  }
  return warnings;
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
  if (platform === 'linux') return normalized;
  return normalized
    .split(' ')
    .map((chord) =>
      chord
        .split('+')
        .map((part) => {
          if (part === 'Meta') return platform === 'macos' ? 'Cmd' : 'Win';
          if (part === 'Alt' && platform === 'macos') return 'Option';
          return part;
        })
        .join('+'),
    )
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
    const current = readBoundedStorage(storage, STORAGE_KEY, MAX_IMPORT_BYTES);
    if (current) return upgradePreviousDefaults(parseExport(current, platform).bindings, platform);

    const legacy = readBoundedStorage(storage, LEGACY_STORAGE_KEY, MAX_IMPORT_BYTES);
    if (!legacy) return defaults;
    const parsed = JSON.parse(legacy) as unknown;
    const legacyBindings = mergeBindings(DEFAULT_KEYBINDINGS, parsed).bindings;
    if (platform !== 'macos') return upgradePreviousDefaults(legacyBindings, platform);
    return upgradePreviousDefaults(
      Object.fromEntries(
        COMMAND_IDS.map((id) => [
          id,
          legacyBindings[id] === DEFAULT_KEYBINDINGS[id] ? defaults[id] : legacyBindings[id],
        ]),
      ) as Record<CommandId, string>,
      platform,
    );
  } catch {
    // A corrupt preference must never prevent the terminal from starting.
    return defaults;
  }
}

export function saveKeybindings(
  bindings: Record<CommandId, string>,
  storage: Pick<Storage, 'setItem'> = localStorage,
  platform: OperatingSystem = detectOperatingSystem(),
): boolean {
  return writeBoundedStorage(
    storage,
    STORAGE_KEY,
    exportKeybindings(bindings, platform),
    MAX_IMPORT_BYTES,
  );
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

/** True when every context in which `when` holds also has `key` set. */
function contextImplies(when: string | undefined, key: ContextKey): boolean {
  const variants = 2 ** CONTEXT_KEYS.length;
  let satisfiable = false;
  for (let mask = 0; mask < variants; mask += 1) {
    const context = Object.fromEntries(
      CONTEXT_KEYS.map((name, index) => [name, Boolean(mask & (1 << index))]),
    ) as CommandContext;
    if (!evaluateWhen(when, context)) continue;
    satisfiable = true;
    if (!context[key]) return false;
  }
  return satisfiable;
}

export function contextsOverlap(first: string | undefined, second: string | undefined): boolean {
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
  const sourceDefaults = defaultKeybindings(sourcePlatform);
  const targetDefaults = defaultKeybindings(platform);
  const { bindings: merged, invalid } = mergeBindings(sourceDefaults, parsed.bindings);
  if (sourcePlatform === platform) return { bindings: merged, invalid };
  return {
    // A binding still at the source platform's default takes the target's
    // default (which may differ by more than Ctrl/Cmd); customizations migrate.
    bindings: Object.fromEntries(
      COMMAND_IDS.map((id) => [
        id,
        merged[id] === sourceDefaults[id]
          ? targetDefaults[id]
          : migratePrimaryModifier(merged[id], sourcePlatform, platform),
      ]),
    ) as Record<CommandId, string>,
    migratedFrom: sourcePlatform,
    invalid,
  };
}

function mergeBindings(
  defaults: Record<CommandId, string>,
  value: unknown,
): { bindings: Record<CommandId, string>; invalid: number } {
  if (!isRecord(value)) return { bindings: defaults, invalid: 0 };
  const output = { ...defaults };
  let invalid = 0;
  for (const id of COMMAND_IDS) {
    const candidate = value[id];
    if (candidate === undefined) continue;
    const normalized = typeof candidate === 'string' ? normalizeKeySequence(candidate) : null;
    if (normalized) output[id] = normalized;
    else invalid += 1;
  }
  return { bindings: output, invalid };
}

/**
 * Swaps the primary modifier between macOS (Cmd) and Linux / Windows (Ctrl) in
 * both directions, re-normalizing each chord. `Ctrl+Tab` stays, because
 * `Cmd+Tab` belongs to the macOS app switcher.
 */
export function migratePrimaryModifier(
  sequence: string,
  source: OperatingSystem,
  target: OperatingSystem,
): string {
  if (source === target || (source !== 'macos' && target !== 'macos')) return sequence;
  const migrated = sequence.split(' ').map((chord) => {
    const { modifiers, key } = chordParts(chord);
    if (key === 'Tab') return chord;
    const swapped = [...modifiers].map((modifier) =>
      modifier === 'Ctrl' ? 'Meta' : modifier === 'Meta' ? 'Ctrl' : modifier,
    );
    return [...swapped, key].join('+');
  });
  return normalizeKeySequence(migrated.join(' ')) ?? sequence;
}

function isOperatingSystem(value: unknown): value is OperatingSystem {
  return value === 'linux' || value === 'macos' || value === 'windows';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import { fuzzyFilter } from './fuzzy';
import {
  KEY_SEQUENCE_TIMEOUT_MS,
  defaultKeybindings,
  eventToChord,
  exportKeybindings,
  findKeybindingConflicts,
  findKeybindingWarnings,
  formatKeySequence,
  importKeybindings,
  isBareChord,
  isTerminalReservedChord,
  loadKeybindings,
  resolveKeybinding,
  saveKeybindings,
  type CommandContext,
  type CommandId,
  type OperatingSystem,
} from './keybindings';

export interface CommandDefinition {
  id: CommandId;
  category: string;
  label: string;
  when?: string;
  run: () => void;
}

export interface PaletteItem {
  id: string;
  category: string;
  label: string;
  detail?: string;
  keybinding?: string;
  run: () => void;
}

export interface CommandUiElements {
  palette: HTMLElement;
  commandQuery: HTMLInputElement;
  commandResults: HTMLElement;
  shortcutEditor: HTMLElement;
  shortcutPlatform: HTMLElement;
  shortcutQuery: HTMLInputElement;
  shortcutList: HTMLElement;
  shortcutImport: HTMLInputElement;
  shortcutClose: HTMLButtonElement;
  shortcutReset: HTMLButtonElement;
  shortcutExport: HTMLButtonElement;
  shortcutImportButton: HTMLButtonElement;
}

interface CommandUiOptions {
  elements: CommandUiElements;
  commands: readonly CommandDefinition[];
  operatingSystem: OperatingSystem;
  additionalItems: () => PaletteItem[];
  baseContext: () => Pick<CommandContext, 'terminalFocus' | 'routeFocus'>;
  /** True while keyboard focus is inside an xterm, where the shell owns plain Ctrl keys. */
  terminalInputFocused: () => boolean;
  /** Saves an export through the native save dialog; resolves false when cancelled. */
  saveExport?: (contents: string) => Promise<boolean>;
  toast: (message: string) => void;
}

export class CommandUi {
  readonly #elements: CommandUiElements;
  readonly #commands: readonly CommandDefinition[];
  readonly #operatingSystem: OperatingSystem;
  readonly #additionalItems: () => PaletteItem[];
  readonly #baseContext: () => Pick<CommandContext, 'terminalFocus' | 'routeFocus'>;
  readonly #terminalInputFocused: () => boolean;
  readonly #saveExport: ((contents: string) => Promise<boolean>) | undefined;
  readonly #toast: (message: string) => void;
  readonly #defaultBindings: Record<CommandId, string>;
  #bindings: Record<CommandId, string>;
  #selectedCommand = 0;
  #paletteItems: PaletteItem[] = [];
  #recordingCommand: CommandId | null = null;
  #recordingChords: string[] = [];
  #recordingTimer: number | undefined;
  #pendingKeyChords: string[] = [];
  #pendingKeyTimer: number | undefined;

  constructor(options: CommandUiOptions) {
    this.#elements = options.elements;
    this.#commands = options.commands;
    this.#operatingSystem = options.operatingSystem;
    this.#additionalItems = options.additionalItems;
    this.#baseContext = options.baseContext;
    this.#terminalInputFocused = options.terminalInputFocused;
    this.#saveExport = options.saveExport;
    this.#toast = options.toast;
    this.#defaultBindings = defaultKeybindings(options.operatingSystem);
    this.#bindings = loadKeybindings(localStorage, options.operatingSystem);
    this.#bindEvents();
  }

  openPalette(): void {
    this.clearPendingSequence();
    this.#elements.shortcutEditor.classList.add('hidden');
    this.#elements.palette.classList.remove('hidden');
    this.#elements.commandQuery.value = '';
    this.#selectedCommand = 0;
    this.#renderCommandResults();
    window.requestAnimationFrame(() => this.#elements.commandQuery.focus());
  }

  closePalette(): void {
    this.#elements.palette.classList.add('hidden');
  }

  togglePalette(): void {
    if (this.#elements.palette.classList.contains('hidden')) this.openPalette();
    else this.closePalette();
  }

  openShortcutEditor(): void {
    this.clearPendingSequence();
    this.closePalette();
    this.#elements.shortcutEditor.classList.remove('hidden');
    this.#elements.shortcutQuery.value = '';
    this.#cancelShortcutRecording();
    this.#elements.shortcutPlatform.textContent = this.#operatingSystem === 'macos'
      ? 'macOS · Cmd'
      : `${this.#operatingSystem === 'windows' ? 'Windows' : 'Linux'} · Ctrl`;
    this.#renderShortcuts();
    window.requestAnimationFrame(() => this.#elements.shortcutQuery.focus());
  }

  closeShortcutEditor(): void {
    this.#cancelShortcutRecording();
    this.#elements.shortcutEditor.classList.add('hidden');
  }

  clearPendingSequence(): void {
    if (this.#pendingKeyTimer !== undefined) window.clearTimeout(this.#pendingKeyTimer);
    this.#pendingKeyTimer = undefined;
    this.#pendingKeyChords = [];
  }

  syncKeybindingLabels(): void {
    for (const node of document.querySelectorAll<HTMLElement>('[data-keybinding]')) {
      const id = node.dataset.keybinding as CommandId | undefined;
      if (id && id in this.#bindings) {
        node.textContent = formatKeySequence(this.#bindings[id], this.#operatingSystem);
      }
    }
  }

  handleGlobalKeydown(event: KeyboardEvent): boolean {
    if (this.#recordingCommand) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        this.#cancelShortcutRecording();
      } else {
        const chord = eventToChord(event);
        if (chord) this.#recordShortcutChord(chord);
      }
      this.#renderShortcuts();
      return true;
    }
    if (!this.#elements.shortcutEditor.classList.contains('hidden') && event.key === 'Escape') {
      event.preventDefault();
      this.closeShortcutEditor();
      return true;
    }
    const chord = eventToChord(event);
    if (!chord) return false;
    const paletteOpen = !this.#elements.palette.classList.contains('hidden');
    // The palette input owns plain typing and navigation keys; only modified
    // chords are evaluated there, with `paletteOpen` true in the context.
    if (paletteOpen && isBareChord(chord)) return false;
    // The shell owns plain Ctrl keys while a terminal has focus (Linux/Windows).
    if (
      this.#pendingKeyChords.length === 0 &&
      !paletteOpen &&
      this.#terminalInputFocused() &&
      isTerminalReservedChord(chord, this.#operatingSystem)
    ) {
      return false;
    }
    if (!this.#runKeybinding(chord)) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  #commandItems(): PaletteItem[] {
    const base = this.#commands.map((command) => ({
      id: command.id,
      category: command.category,
      label: command.label,
      keybinding: formatKeySequence(this.#bindings[command.id], this.#operatingSystem),
      run: command.run,
    }));
    return [...base, ...this.#additionalItems()];
  }

  #renderCommandResults(): void {
    this.#paletteItems = fuzzyFilter(
      this.#elements.commandQuery.value,
      this.#commandItems(),
      (item) => `${item.category} ${item.label} ${item.detail ?? ''} ${item.keybinding ?? ''}`,
    );
    this.#selectedCommand = Math.min(this.#selectedCommand, Math.max(0, this.#paletteItems.length - 1));
    this.#elements.commandResults.replaceChildren();
    if (this.#paletteItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'command-empty';
      empty.textContent = '一致するコマンドはありません';
      this.#elements.commandResults.append(empty);
      return;
    }
    this.#paletteItems.forEach((item, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `command-item${index === this.#selectedCommand ? ' selected' : ''}`;
      const label = document.createElement('span');
      label.className = 'command-label';
      const category = document.createElement('small');
      category.textContent = item.category.toUpperCase();
      label.append(category, document.createTextNode(item.label));
      if (item.detail) {
        const detail = document.createElement('small');
        detail.textContent = `  ${item.detail}`;
        label.append(detail);
      }
      const key = document.createElement('span');
      key.className = 'command-key';
      key.textContent = item.keybinding ?? '';
      row.append(label, key);
      row.addEventListener('mouseenter', () => {
        if (this.#selectedCommand === index) return;
        this.#selectedCommand = index;
        for (const [rowIndex, candidate] of [...this.#elements.commandResults.children].entries()) {
          candidate.classList.toggle('selected', rowIndex === this.#selectedCommand);
        }
      });
      row.addEventListener('click', () => this.#executePaletteItem(item));
      this.#elements.commandResults.append(row);
    });
  }

  #executePaletteItem(item: PaletteItem | undefined): void {
    if (!item) return;
    this.closePalette();
    item.run();
  }

  #renderShortcuts(): void {
    this.syncKeybindingLabels();
    const warningsByCommand = new Map<CommandId, { kind: string; message: string }[]>();
    for (const warning of findKeybindingWarnings(this.#bindings, this.#commands, this.#operatingSystem)) {
      const existing = warningsByCommand.get(warning.commandId) ?? [];
      existing.push(warning);
      warningsByCommand.set(warning.commandId, existing);
    }
    const visible = fuzzyFilter(this.#elements.shortcutQuery.value, [...this.#commands], (command) =>
      `${command.category} ${command.label} ${command.id} ${this.#bindings[command.id]} ${command.when ?? ''}`,
    );
    this.#elements.shortcutList.replaceChildren();
    for (const command of visible) {
      const row = document.createElement('div');
      const commandWarnings = warningsByCommand.get(command.id) ?? [];
      const hasConflict = commandWarnings.some((warning) => warning.kind === 'conflict');
      row.className = `shortcut-row${hasConflict ? ' conflict' : commandWarnings.length > 0 ? ' warning' : ''}`;
      const copy = document.createElement('span');
      copy.className = 'shortcut-command';
      const label = document.createElement('strong');
      label.textContent = command.label;
      const id = document.createElement('small');
      id.textContent = `${command.id}${command.when ? ` · when ${command.when}` : ''}`;
      copy.append(label, id);
      for (const commandWarning of commandWarnings) {
        const warning = document.createElement('small');
        warning.className = commandWarning.kind === 'conflict' ? 'shortcut-conflict' : 'shortcut-warning';
        warning.textContent = commandWarning.message;
        copy.append(warning);
      }
      const capture = document.createElement('button');
      capture.type = 'button';
      capture.className = `shortcut-capture${this.#recordingCommand === command.id ? ' recording' : ''}`;
      capture.textContent = this.#recordingCommand === command.id
        ? this.#recordingChords.length > 0
          ? `${formatKeySequence(this.#recordingChords.join(' '), this.#operatingSystem)} …`
          : 'キーを入力…'
        : formatKeySequence(this.#bindings[command.id], this.#operatingSystem);
      capture.addEventListener('click', () => {
        this.#cancelShortcutRecording();
        this.#recordingCommand = command.id;
        this.#recordingChords = [];
        this.#renderShortcuts();
        capture.focus();
      });
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'shortcut-reset-one';
      reset.textContent = '↺';
      reset.title = '既定値に戻す';
      reset.disabled = this.#bindings[command.id] === this.#defaultBindings[command.id];
      reset.addEventListener('click', () => {
        this.#bindings[command.id] = this.#defaultBindings[command.id];
        this.#persistBindings();
        this.#renderShortcuts();
      });
      row.append(copy, capture, reset);
      this.#elements.shortcutList.append(row);
    }
  }

  #context(): CommandContext {
    return {
      ...this.#baseContext(),
      paletteOpen: !this.#elements.palette.classList.contains('hidden'),
      shortcutEditorOpen: !this.#elements.shortcutEditor.classList.contains('hidden'),
    };
  }

  #runKeybinding(chord: string): boolean {
    const hadPrefix = this.#pendingKeyChords.length > 0;
    this.#pendingKeyChords.push(chord);
    let resolution = resolveKeybinding(
      this.#pendingKeyChords,
      this.#bindings,
      this.#commands,
      this.#context(),
    );
    if (resolution.status === 'none' && hadPrefix) {
      this.clearPendingSequence();
      this.#pendingKeyChords = [chord];
      resolution = resolveKeybinding(
        this.#pendingKeyChords,
        this.#bindings,
        this.#commands,
        this.#context(),
      );
    }
    if (resolution.status === 'none') {
      this.clearPendingSequence();
      return false;
    }
    if (resolution.status === 'match') {
      this.clearPendingSequence();
      this.#commands.find((command) => command.id === resolution.commandId)?.run();
      return true;
    }

    if (this.#pendingKeyTimer !== undefined) window.clearTimeout(this.#pendingKeyTimer);
    const exactCommandId = resolution.exactCommandId;
    this.#pendingKeyTimer = window.setTimeout(() => {
      this.clearPendingSequence();
      if (exactCommandId) this.#commands.find((command) => command.id === exactCommandId)?.run();
    }, KEY_SEQUENCE_TIMEOUT_MS);
    return true;
  }

  #recordShortcutChord(chord: string): void {
    if (!this.#recordingCommand) return;
    if (this.#recordingChords.length === 0 && isBareChord(chord)) {
      this.#toast('最初のキーには Ctrl / Alt / Cmd を含めてください（F1–F24 は単独で使えます）。');
      return;
    }
    this.#recordingChords.push(chord);
    if (this.#recordingChords.length >= 4) {
      this.#finishShortcutRecording();
      return;
    }
    if (this.#recordingTimer !== undefined) window.clearTimeout(this.#recordingTimer);
    this.#recordingTimer = window.setTimeout(
      () => this.#finishShortcutRecording(),
      KEY_SEQUENCE_TIMEOUT_MS,
    );
    this.#renderShortcuts();
  }

  #finishShortcutRecording(): void {
    if (!this.#recordingCommand || this.#recordingChords.length === 0) {
      this.#cancelShortcutRecording();
      this.#renderShortcuts();
      return;
    }
    this.#bindings[this.#recordingCommand] = this.#recordingChords.join(' ');
    this.#persistBindings();
    this.#cancelShortcutRecording();
    this.#renderShortcuts();
  }

  #cancelShortcutRecording(): void {
    if (this.#recordingTimer !== undefined) window.clearTimeout(this.#recordingTimer);
    this.#recordingTimer = undefined;
    this.#recordingCommand = null;
    this.#recordingChords = [];
  }

  #persistBindings(): boolean {
    const saved = saveKeybindings(this.#bindings, localStorage, this.#operatingSystem);
    if (!saved) {
      this.#toast('Keyboard Shortcuts を端末内に保存できません。現在の起動中だけ反映します。');
    }
    return saved;
  }

  async #exportShortcuts(): Promise<void> {
    const contents = exportKeybindings(this.#bindings, this.#operatingSystem);
    if (this.#saveExport) {
      // WebKitGTK / WKWebView ignore <a download>, so the desktop app saves
      // through the native dialog and Rust writes the file.
      if (await this.#saveExport(contents)) this.#toast('Keyboard Shortcuts を書き出しました。');
      return;
    }
    const blob = new Blob([contents], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ope-term-keybindings-${this.#operatingSystem}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url));
  }

  async #importShortcuts(file: File): Promise<void> {
    const imported = importKeybindings(await file.text(), this.#operatingSystem);
    this.#bindings = imported.bindings;
    const saved = this.#persistBindings();
    this.#renderShortcuts();
    const migration = imported.migratedFrom
      ? ` ${imported.migratedFrom} の Ctrl/Cmd を ${this.#operatingSystem} 向けに移行しました。`
      : '';
    const invalid = imported.invalid > 0 ? ` 不正なキー ${imported.invalid} 件は既定値のままです。` : '';
    const conflicts = findKeybindingConflicts(this.#bindings, this.#commands).length;
    const conflictNote = conflicts > 0 ? ` 競合が ${conflicts} 件あります。赤い行を確認してください。` : '';
    if (saved) this.#toast(`Keyboard Shortcuts を読み込みました。${migration}${invalid}${conflictNote}`);
  }

  #bindEvents(): void {
    this.#elements.commandQuery.addEventListener('input', () => {
      this.#selectedCommand = 0;
      this.#renderCommandResults();
    });
    this.#elements.commandQuery.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.#selectedCommand = Math.min(
          this.#selectedCommand + 1,
          this.#paletteItems.length - 1,
        );
        this.#renderCommandResults();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.#selectedCommand = Math.max(0, this.#selectedCommand - 1);
        this.#renderCommandResults();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        this.#executePaletteItem(this.#paletteItems[this.#selectedCommand]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.closePalette();
      }
    });
    this.#elements.palette.addEventListener('mousedown', (event) => {
      if (event.target === this.#elements.palette) this.closePalette();
    });
    this.#elements.shortcutQuery.addEventListener('input', () => this.#renderShortcuts());
    this.#elements.shortcutClose.addEventListener('click', () => this.closeShortcutEditor());
    this.#elements.shortcutReset.addEventListener('click', () => {
      this.#cancelShortcutRecording();
      this.#bindings = { ...this.#defaultBindings };
      this.#persistBindings();
      this.#renderShortcuts();
    });
    this.#elements.shortcutExport.addEventListener('click', () => {
      void this.#exportShortcuts().catch((error: unknown) => {
        this.#toast(`Keyboard Shortcuts を書き出せません: ${String(error)}`);
      });
    });
    this.#elements.shortcutImportButton.addEventListener('click', () => {
      this.#cancelShortcutRecording();
      this.#elements.shortcutImport.value = '';
      this.#elements.shortcutImport.click();
    });
    this.#elements.shortcutImport.addEventListener('change', () => {
      const file = this.#elements.shortcutImport.files?.[0];
      if (!file) return;
      void this.#importShortcuts(file).catch((error: unknown) => {
        this.#toast(`Keyboard Shortcuts の読み込みに失敗しました: ${String(error)}`);
      });
    });
    this.#elements.shortcutEditor.addEventListener('mousedown', (event) => {
      if (event.target === this.#elements.shortcutEditor) this.closeShortcutEditor();
    });
  }
}

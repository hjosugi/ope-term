import { Channel, invoke } from '@tauri-apps/api/core';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import './style.css';

import { fuzzyFilter } from './fuzzy';
import {
  DEFAULT_KEYBINDINGS,
  eventToChord,
  loadKeybindings,
  saveKeybindings,
  type CommandId,
} from './keybindings';
import { appendUnique, moveRouteItem, routePreview } from './route';
import type { ConnectRequest, HopStatus, HostProfile, SessionEvent } from './types';

interface SessionUi {
  id: string;
  title: string;
  route: string[];
  hops: HopStatus[];
  terminal: Terminal;
  fit: FitAddon;
  view: HTMLElement;
  hopbar: HTMLElement;
  inputBuffer: string;
  inputTimer?: number;
  resizeTimer?: number;
  state: 'connecting' | 'connected' | 'closed';
}

interface CommandDefinition {
  id: CommandId;
  category: string;
  label: string;
  run: () => void;
}

interface PaletteItem {
  id: string;
  category: string;
  label: string;
  detail?: string;
  keybinding?: string;
  run: () => void;
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}

const ui = {
  builder: element<HTMLElement>('builder'),
  terminalStage: element<HTMLElement>('terminal-stage'),
  hostList: element<HTMLElement>('host-list'),
  hostCount: element<HTMLElement>('host-count'),
  hostSearch: element<HTMLInputElement>('host-search'),
  routeTrack: element<HTMLElement>('route-track'),
  routeEmpty: element<HTMLElement>('route-empty'),
  routeHint: element<HTMLElement>('route-hint'),
  connect: element<HTMLButtonElement>('connect'),
  tabs: element<HTMLElement>('session-tabs'),
  newRoute: element<HTMLButtonElement>('new-route'),
  connectionState: element<HTMLElement>('connection-state'),
  statusMode: element<HTMLElement>('status-mode'),
  statusRoute: element<HTMLElement>('status-route'),
  toastStack: element<HTMLElement>('toast-stack'),
  palette: element<HTMLElement>('command-palette'),
  commandQuery: element<HTMLInputElement>('command-query'),
  commandResults: element<HTMLElement>('command-results'),
  shortcutEditor: element<HTMLElement>('shortcut-editor'),
  shortcutQuery: element<HTMLInputElement>('shortcut-query'),
  shortcutList: element<HTMLElement>('shortcut-list'),
};

let hosts: HostProfile[] = [];
let route: string[] = [];
let routeDragIndex: number | null = null;
let activeSessionId: string | null = null;
let selectedCommand = 0;
let paletteItems: PaletteItem[] = [];
let recordingCommand: CommandId | null = null;
let keybindings = loadKeybindings();
const sessions = new Map<string, SessionUi>();

const commands: CommandDefinition[] = [
  {
    id: 'workbench.action.showCommands',
    category: 'View',
    label: 'Command Palette を表示',
    run: openCommandPalette,
  },
  {
    id: 'workbench.action.quickOpenHost',
    category: 'SSH',
    label: 'Host を検索',
    run: focusHostSearch,
  },
  { id: 'route.connect', category: 'Route', label: '現在のルートへ接続', run: () => void connectRoute() },
  { id: 'route.clear', category: 'Route', label: 'ルートをクリア', run: clearRoute },
  { id: 'route.new', category: 'Route', label: '新しいルート', run: showBuilder },
  { id: 'session.close', category: 'Session', label: '現在のセッションを閉じる', run: closeActiveSession },
  { id: 'session.next', category: 'Session', label: '次のセッションへ移動', run: activateNextSession },
  {
    id: 'preferences.openKeyboardShortcuts',
    category: 'Preferences',
    label: 'Keyboard Shortcuts を開く',
    run: openShortcutEditor,
  },
];

function toast(message: string): void {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  ui.toastStack.append(node);
  window.setTimeout(() => node.remove(), 6500);
}

async function loadHosts(): Promise<void> {
  try {
    hosts = await invoke<HostProfile[]>('list_hosts');
    renderHosts();
    renderRoute();
  } catch (error) {
    toast(`SSH config の読み込みに失敗しました: ${String(error)}`);
    renderHosts();
  }
}

function renderHosts(): void {
  const filtered = fuzzyFilter(ui.hostSearch.value, hosts, (host) =>
    [host.alias, host.hostname, host.user ?? '', host.chain.join(' ')].join(' '),
  );
  ui.hostCount.textContent = `${hosts.length} hosts`;
  ui.hostList.replaceChildren();

  if (hosts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-hosts';
    empty.innerHTML = 'Host がありません。<br><code>~/.ssh/config</code> に Host を追加すると、ここに表示されます。';
    ui.hostList.append(empty);
    return;
  }

  for (const host of filtered) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'host-card';
    card.draggable = true;
    card.setAttribute('role', 'listitem');
    card.title = `${host.alias} をルートへ追加`;

    const glyph = document.createElement('span');
    glyph.className = 'host-glyph';
    glyph.textContent = 'SSH';
    const main = document.createElement('span');
    main.className = 'host-main';
    const alias = document.createElement('span');
    alias.className = 'host-alias';
    alias.textContent = host.alias;
    const address = document.createElement('span');
    address.className = 'host-address';
    address.textContent = `${host.user ? `${host.user}@` : ''}${host.hostname}:${host.port}`;
    main.append(alias, address);
    const hops = document.createElement('span');
    hops.className = 'host-hops';
    hops.textContent = host.chain.length > 1 ? `${host.chain.length} HOP` : 'DIRECT';
    card.append(glyph, main, hops);
    card.addEventListener('click', () => addToRoute(host.alias));
    card.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('text/ope-host', host.alias);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
    });
    ui.hostList.append(card);
  }
}

function addToRoute(alias: string): void {
  route = appendUnique(route, alias);
  renderRoute();
}

function clearRoute(): void {
  route = [];
  renderRoute();
}

function renderRoute(): void {
  ui.routeTrack.replaceChildren();
  ui.connect.disabled = route.length === 0;

  if (route.length === 0) {
    ui.routeTrack.append(ui.routeEmpty);
    ui.routeHint.textContent = '';
    ui.statusRoute.textContent = 'NO ROUTE';
    return;
  }

  route.forEach((alias, index) => {
    const piece = document.createElement('div');
    piece.className = 'route-piece';
    piece.draggable = true;
    piece.dataset.index = String(index);
    const copy = document.createElement('span');
    const number = document.createElement('span');
    number.className = 'piece-index';
    number.textContent = `HOP ${String(index + 1).padStart(2, '0')}`;
    const label = document.createElement('span');
    label.className = 'piece-alias';
    label.textContent = alias;
    copy.append(number, label);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'piece-remove';
    remove.textContent = '×';
    remove.title = `${alias} を削除`;
    remove.addEventListener('click', () => {
      route = route.filter((_, itemIndex) => itemIndex !== index);
      renderRoute();
    });
    piece.append(copy, remove);
    piece.addEventListener('dragstart', (event) => {
      routeDragIndex = index;
      event.dataTransfer?.setData('text/ope-route-index', String(index));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    piece.addEventListener('dragover', (event) => {
      if (routeDragIndex === null) return;
      event.preventDefault();
      piece.classList.add('drag-target');
    });
    piece.addEventListener('dragleave', () => piece.classList.remove('drag-target'));
    piece.addEventListener('drop', (event) => {
      event.preventDefault();
      piece.classList.remove('drag-target');
      if (routeDragIndex === null) return;
      route = moveRouteItem(route, routeDragIndex, index);
      routeDragIndex = null;
      renderRoute();
    });
    piece.addEventListener('dragend', () => {
      routeDragIndex = null;
      piece.classList.remove('drag-target');
    });
    ui.routeTrack.append(piece);
  });

  const preview = routePreview(route, hosts);
  ui.statusRoute.textContent = preview.join(' → ');
  if (route.length === 1 && preview.length > 1) {
    ui.routeHint.replaceChildren();
    const lead = document.createTextNode('OpenSSH ProxyJump: ');
    const path = document.createElement('b');
    path.textContent = preview.join(' → ');
    ui.routeHint.append(lead, path);
  } else {
    ui.routeHint.textContent = route.length > 1 ? '明示ルート: 配置した順番で direct-tcpip を接続します。' : '直接接続';
  }
}

function showBuilder(): void {
  activeSessionId = null;
  ui.builder.classList.remove('hidden');
  ui.terminalStage.classList.add('hidden');
  ui.statusMode.textContent = 'ROUTE';
  ui.connectionState.textContent = 'ROUTE READY';
  ui.connectionState.style.color = 'var(--green)';
  renderTabs();
}

async function connectRoute(): Promise<void> {
  if (route.length === 0) return;
  const id = crypto.randomUUID();
  const title = route.at(-1) ?? 'ssh';
  const session = createSession(id, title, [...route]);
  sessions.set(id, session);
  activateSession(id);
  renderTabs();

  const onEvent = new Channel<SessionEvent>();
  onEvent.onmessage = (event) => handleSessionEvent(session, event);
  const onData = new Channel<ArrayBuffer>();
  onData.onmessage = (data) => session.terminal.write(new Uint8Array(data));
  const request: ConnectRequest = {
    sessionId: id,
    route: [...route],
    cols: session.terminal.cols,
    rows: session.terminal.rows,
  };
  session.terminal.writeln(`\x1b[38;2;255;180;84m[ope-term]\x1b[0m ${routePreview(route, hosts).join(' → ')} へ接続中…`);
  try {
    await invoke('connect_session', { request, onEvent, onData });
  } catch (error) {
    handleSessionEvent(session, { type: 'error', message: String(error) });
  }
}

function createSession(id: string, title: string, sessionRoute: string[]): SessionUi {
  const view = document.createElement('section');
  view.className = 'terminal-view inactive';
  view.dataset.sessionId = id;
  const hopbar = document.createElement('header');
  hopbar.className = 'hopbar';
  const terminalContainer = document.createElement('div');
  terminalContainer.className = 'terminal-container';
  view.append(hopbar, terminalContainer);
  ui.terminalStage.append(view);

  const terminal = new Terminal({
    allowTransparency: false,
    cursorBlink: true,
    cursorStyle: 'bar',
    fontFamily: 'JetBrains Mono, HackGen Console NF, Cascadia Code, monospace',
    fontSize: 13,
    lineHeight: 1.16,
    scrollback: 20_000,
    theme: {
      background: '#070a0e',
      foreground: '#dce2ea',
      cursor: '#ffb454',
      selectionBackground: '#39424e',
      black: '#10141a',
      red: '#f27d88',
      green: '#78d6a3',
      yellow: '#ffb454',
      blue: '#80a8f8',
      magenta: '#d69cf6',
      cyan: '#75d8d5',
      white: '#e9edf3',
    },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(terminalContainer);
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    terminal.loadAddon(webgl);
  } catch {
    // WebGL is optional on WebKitGTK; xterm's renderer is the stable fallback.
  }
  fit.fit();

  const session: SessionUi = {
    id,
    title,
    route: sessionRoute,
    hops: [],
    terminal,
    fit,
    view,
    hopbar,
    inputBuffer: '',
    state: 'connecting',
  };
  terminal.onData((data) => queueInput(session, data));
  terminal.onResize(({ cols, rows }) => queueResize(session, cols, rows));
  return session;
}

function queueInput(session: SessionUi, data: string): void {
  if (session.state === 'closed') return;
  session.inputBuffer += data;
  if (session.inputTimer !== undefined) return;
  session.inputTimer = window.setTimeout(() => {
    const input = session.inputBuffer;
    session.inputBuffer = '';
    session.inputTimer = undefined;
    if (input) void invoke('session_input', { sessionId: session.id, data: input }).catch(() => undefined);
  }, 4);
}

function queueResize(session: SessionUi, cols: number, rows: number): void {
  if (session.resizeTimer !== undefined) window.clearTimeout(session.resizeTimer);
  session.resizeTimer = window.setTimeout(() => {
    session.resizeTimer = undefined;
    if (session.state !== 'closed') {
      void invoke('session_resize', { sessionId: session.id, cols, rows }).catch(() => undefined);
    }
  }, 80);
}

function handleSessionEvent(session: SessionUi, event: SessionEvent): void {
  switch (event.type) {
    case 'chain':
      session.hops = event.hops;
      renderHopbar(session);
      break;
    case 'hop': {
      const current = session.hops[event.hop.index];
      if (current) session.hops[event.hop.index] = event.hop;
      else session.hops.push(event.hop);
      renderHopbar(session);
      break;
    }
    case 'ready':
      session.state = 'connected';
      if (session.id === activeSessionId) updateConnectionState(session);
      session.terminal.focus();
      break;
    case 'error':
      session.terminal.writeln(`\r\n\x1b[38;2;242;125;136m[ope-term] ${event.message}\x1b[0m`);
      toast(event.message);
      break;
    case 'closed':
      session.state = 'closed';
      session.terminal.writeln('\r\n\x1b[38;2;127;137;150m[ope-term] session closed\x1b[0m');
      if (session.id === activeSessionId) updateConnectionState(session);
      renderTabs();
      break;
  }
}

function renderHopbar(session: SessionUi): void {
  session.hopbar.replaceChildren();
  session.hops.forEach((hop, index) => {
    const node = document.createElement('span');
    node.className = `hop ${hop.state}`;
    node.textContent = hop.alias;
    session.hopbar.append(node);
    if (index < session.hops.length - 1) {
      const separator = document.createElement('span');
      separator.className = 'hop-separator';
      separator.textContent = '→';
      session.hopbar.append(separator);
    }
  });
  const target = document.createElement('span');
  target.className = 'terminal-host';
  target.textContent = session.title;
  session.hopbar.append(target);
}

function activateSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  activeSessionId = id;
  ui.builder.classList.add('hidden');
  ui.terminalStage.classList.remove('hidden');
  ui.statusMode.textContent = 'TERMINAL';
  ui.statusRoute.textContent = session.route.join(' → ');
  for (const candidate of sessions.values()) {
    candidate.view.classList.toggle('inactive', candidate.id !== id);
  }
  renderTabs();
  updateConnectionState(session);
  window.requestAnimationFrame(() => {
    session.fit.fit();
    session.terminal.focus();
  });
}

function updateConnectionState(session: SessionUi): void {
  const labels = { connecting: 'CONNECTING', connected: 'SSH CONNECTED', closed: 'DISCONNECTED' } as const;
  const colors = { connecting: 'var(--amber)', connected: 'var(--green)', closed: 'var(--red)' } as const;
  ui.connectionState.textContent = labels[session.state];
  ui.connectionState.style.color = colors[session.state];
}

function renderTabs(): void {
  ui.tabs.replaceChildren();
  for (const session of sessions.values()) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `session-tab${session.id === activeSessionId ? ' active' : ''}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(session.id === activeSessionId));
    const dot = document.createElement('span');
    dot.className = `secure-dot ${session.state}`;
    const label = document.createElement('span');
    label.className = 'session-tab-label';
    label.textContent = session.title;
    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '×';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      closeSession(session.id);
    });
    tab.append(dot, label, close);
    tab.addEventListener('click', () => activateSession(session.id));
    ui.tabs.append(tab);
  }
}

function closeSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  if (session.state !== 'closed') void invoke('close_session', { sessionId: id }).catch(() => undefined);
  if (session.inputTimer !== undefined) window.clearTimeout(session.inputTimer);
  if (session.resizeTimer !== undefined) window.clearTimeout(session.resizeTimer);
  session.terminal.dispose();
  session.view.remove();
  sessions.delete(id);
  if (activeSessionId === id) {
    const next = [...sessions.keys()].at(-1);
    if (next) activateSession(next);
    else showBuilder();
  }
  renderTabs();
}

function closeActiveSession(): void {
  if (activeSessionId) closeSession(activeSessionId);
}

function activateNextSession(): void {
  const ids = [...sessions.keys()];
  if (ids.length === 0) return;
  const index = activeSessionId ? ids.indexOf(activeSessionId) : -1;
  activateSession(ids[(index + 1) % ids.length] ?? ids[0]!);
}

function focusHostSearch(): void {
  closeCommandPalette();
  showBuilder();
  ui.hostSearch.focus();
  ui.hostSearch.select();
}

function commandItems(): PaletteItem[] {
  const base = commands.map((command) => ({
    id: command.id,
    category: command.category,
    label: command.label,
    keybinding: keybindings[command.id],
    run: command.run,
  }));
  const hostItems = hosts.map((host) => ({
    id: `host.${host.alias}`,
    category: 'Host',
    label: host.alias,
    detail: host.chain.join(' → '),
    run: () => {
      showBuilder();
      route = [host.alias];
      renderRoute();
    },
  }));
  return [...base, ...hostItems];
}

function openCommandPalette(): void {
  ui.shortcutEditor.classList.add('hidden');
  ui.palette.classList.remove('hidden');
  ui.commandQuery.value = '';
  selectedCommand = 0;
  renderCommandResults();
  window.requestAnimationFrame(() => ui.commandQuery.focus());
}

function closeCommandPalette(): void {
  ui.palette.classList.add('hidden');
}

function renderCommandResults(): void {
  paletteItems = fuzzyFilter(ui.commandQuery.value, commandItems(), (item) =>
    `${item.category} ${item.label} ${item.detail ?? ''} ${item.keybinding ?? ''}`,
  );
  selectedCommand = Math.min(selectedCommand, Math.max(0, paletteItems.length - 1));
  ui.commandResults.replaceChildren();
  if (paletteItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'command-empty';
    empty.textContent = '一致するコマンドはありません';
    ui.commandResults.append(empty);
    return;
  }
  paletteItems.forEach((item, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `command-item${index === selectedCommand ? ' selected' : ''}`;
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
      if (selectedCommand === index) return;
      selectedCommand = index;
      for (const [rowIndex, candidate] of [...ui.commandResults.children].entries()) {
        candidate.classList.toggle('selected', rowIndex === selectedCommand);
      }
    });
    row.addEventListener('click', () => executePaletteItem(item));
    ui.commandResults.append(row);
  });
}

function executePaletteItem(item: PaletteItem | undefined): void {
  if (!item) return;
  closeCommandPalette();
  item.run();
}

function openShortcutEditor(): void {
  closeCommandPalette();
  ui.shortcutEditor.classList.remove('hidden');
  ui.shortcutQuery.value = '';
  recordingCommand = null;
  renderShortcuts();
  window.requestAnimationFrame(() => ui.shortcutQuery.focus());
}

function closeShortcutEditor(): void {
  recordingCommand = null;
  ui.shortcutEditor.classList.add('hidden');
}

function renderShortcuts(): void {
  const query = ui.shortcutQuery.value;
  const visible = fuzzyFilter(query, commands, (command) =>
    `${command.category} ${command.label} ${command.id} ${keybindings[command.id]}`,
  );
  ui.shortcutList.replaceChildren();
  for (const command of visible) {
    const row = document.createElement('div');
    row.className = 'shortcut-row';
    const copy = document.createElement('span');
    copy.className = 'shortcut-command';
    const label = document.createElement('strong');
    label.textContent = command.label;
    const id = document.createElement('small');
    id.textContent = command.id;
    copy.append(label, id);
    const capture = document.createElement('button');
    capture.type = 'button';
    capture.className = `shortcut-capture${recordingCommand === command.id ? ' recording' : ''}`;
    capture.textContent = recordingCommand === command.id ? 'キーを入力…' : keybindings[command.id];
    capture.addEventListener('click', () => {
      recordingCommand = command.id;
      renderShortcuts();
      capture.focus();
    });
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'shortcut-reset-one';
    reset.textContent = '↺';
    reset.title = '既定値に戻す';
    reset.disabled = keybindings[command.id] === DEFAULT_KEYBINDINGS[command.id];
    reset.addEventListener('click', () => {
      keybindings[command.id] = DEFAULT_KEYBINDINGS[command.id];
      saveKeybindings(keybindings);
      renderShortcuts();
    });
    row.append(copy, capture, reset);
    ui.shortcutList.append(row);
  }
}

function runKeybinding(chord: string): boolean {
  const match = commands.find((command) => keybindings[command.id] === chord);
  if (!match) return false;
  match.run();
  return true;
}

ui.hostSearch.addEventListener('input', renderHosts);
ui.connect.addEventListener('click', () => void connectRoute());
ui.newRoute.addEventListener('click', showBuilder);
ui.routeTrack.addEventListener('dragover', (event) => {
  event.preventDefault();
  ui.routeTrack.classList.add('drag-over');
});
ui.routeTrack.addEventListener('dragleave', (event) => {
  if (!ui.routeTrack.contains(event.relatedTarget as Node | null)) ui.routeTrack.classList.remove('drag-over');
});
ui.routeTrack.addEventListener('drop', (event) => {
  event.preventDefault();
  ui.routeTrack.classList.remove('drag-over');
  const alias = event.dataTransfer?.getData('text/ope-host');
  if (alias) addToRoute(alias);
});
ui.commandQuery.addEventListener('input', () => {
  selectedCommand = 0;
  renderCommandResults();
});
ui.commandQuery.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    selectedCommand = Math.min(selectedCommand + 1, paletteItems.length - 1);
    renderCommandResults();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    selectedCommand = Math.max(0, selectedCommand - 1);
    renderCommandResults();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    executePaletteItem(paletteItems[selectedCommand]);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeCommandPalette();
  }
});
ui.palette.addEventListener('mousedown', (event) => {
  if (event.target === ui.palette) closeCommandPalette();
});
ui.shortcutQuery.addEventListener('input', renderShortcuts);
element<HTMLButtonElement>('close-shortcuts').addEventListener('click', closeShortcutEditor);
element<HTMLButtonElement>('reset-shortcuts').addEventListener('click', () => {
  keybindings = { ...DEFAULT_KEYBINDINGS };
  saveKeybindings(keybindings);
  renderShortcuts();
});
ui.shortcutEditor.addEventListener('mousedown', (event) => {
  if (event.target === ui.shortcutEditor) closeShortcutEditor();
});

window.addEventListener(
  'keydown',
  (event) => {
    if (recordingCommand) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        recordingCommand = null;
      } else {
        const chord = eventToChord(event);
        if (chord) {
          keybindings[recordingCommand] = chord;
          saveKeybindings(keybindings);
          recordingCommand = null;
        }
      }
      renderShortcuts();
      return;
    }
    if (!ui.shortcutEditor.classList.contains('hidden') && event.key === 'Escape') {
      event.preventDefault();
      closeShortcutEditor();
      return;
    }
    if (!ui.palette.classList.contains('hidden')) return;
    const chord = eventToChord(event);
    if (chord && runKeybinding(chord)) {
      event.preventDefault();
      event.stopPropagation();
    }
  },
  true,
);

window.addEventListener('resize', () => {
  if (!activeSessionId) return;
  const session = sessions.get(activeSessionId);
  if (session) window.requestAnimationFrame(() => session.fit.fit());
});

void loadHosts();

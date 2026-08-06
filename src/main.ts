import { Channel, invoke } from '@tauri-apps/api/core';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import './style.css';

import { clearAuthResponses, takeAndClearAuthResponses } from './auth-secrets';
import { fuzzyFilter } from './fuzzy';
import {
  DEFAULT_KEYBINDINGS,
  eventToChord,
  loadKeybindings,
  saveKeybindings,
  type CommandId,
} from './keybindings';
import { appendUnique, moveRouteItem, routePreview } from './route';
import type { AuthPrompt, ConnectRequest, HopStatus, HostKeyPrompt, HostProfile, SessionEvent } from './types';
import {
  loadWorkspaces,
  missingAliases,
  removeSavedRoute,
  sanitizeName,
  saveWorkspaces,
  suggestRouteName,
  upsertSavedRoute,
  type SavedRoute,
  type WorkspaceState,
} from './workspaces';

type SessionState = 'idle' | 'connecting' | 'connected' | 'closed';

interface SessionUi {
  /** Stable UI identity that survives reconnects. */
  key: string;
  /** Backend session id of the current connection, or null while idle. */
  connectionId: string | null;
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
  state: SessionState;
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

interface HostKeyDialogItem {
  sessionKey: string;
  connectionId: string;
  prompt: HostKeyPrompt;
}

interface AuthDialogItem {
  sessionKey: string;
  connectionId: string;
  prompt: AuthPrompt;
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
  reloadHosts: element<HTMLButtonElement>('reload-hosts'),
  configPath: element<HTMLElement>('config-path'),
  workspaceList: element<HTMLElement>('workspace-list'),
  workspaceCount: element<HTMLElement>('workspace-count'),
  routeName: element<HTMLInputElement>('route-name'),
  saveRoute: element<HTMLButtonElement>('save-route'),
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
  hostKeyDialog: element<HTMLElement>('host-key-dialog'),
  hostKeyTitle: element<HTMLElement>('host-key-title'),
  hostKeyStatus: element<HTMLElement>('host-key-status'),
  hostKeyMessage: element<HTMLElement>('host-key-message'),
  hostKeyHop: element<HTMLElement>('host-key-hop'),
  hostKeyEndpoint: element<HTMLElement>('host-key-endpoint'),
  hostKeyAlgorithm: element<HTMLElement>('host-key-algorithm'),
  hostKeyFingerprint: element<HTMLElement>('host-key-fingerprint'),
  hostKeyGuidance: element<HTMLElement>('host-key-guidance'),
  hostKeyReject: element<HTMLButtonElement>('host-key-reject'),
  hostKeyOnce: element<HTMLButtonElement>('host-key-once'),
  hostKeySave: element<HTMLButtonElement>('host-key-save'),
  authDialog: element<HTMLElement>('auth-dialog'),
  authTitle: element<HTMLElement>('auth-title'),
  authKind: element<HTMLElement>('auth-kind'),
  authHop: element<HTMLElement>('auth-hop'),
  authUsername: element<HTMLElement>('auth-username'),
  authInstructions: element<HTMLElement>('auth-instructions'),
  authFields: element<HTMLElement>('auth-fields'),
  authCancel: element<HTMLButtonElement>('auth-cancel'),
  authSubmit: element<HTMLButtonElement>('auth-submit'),
};

let hosts: HostProfile[] = [];
let route: string[] = [];
let routeDragIndex: number | null = null;
let activeSessionKey: string | null = null;
let workspaces: WorkspaceState = loadWorkspaces();
let selectedCommand = 0;
let paletteItems: PaletteItem[] = [];
let recordingCommand: CommandId | null = null;
let keybindings = loadKeybindings();
let activeHostKeyPrompt: HostKeyDialogItem | null = null;
const pendingHostKeyPrompts: HostKeyDialogItem[] = [];
let activeAuthPrompt: AuthDialogItem | null = null;
const pendingAuthPrompts: AuthDialogItem[] = [];
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
  { id: 'route.connect', category: 'Route', label: '現在のルートへ接続', run: () => void connectCurrent() },
  { id: 'route.clear', category: 'Route', label: 'ルートをクリア', run: clearRoute },
  { id: 'route.new', category: 'Route', label: '新しいルート', run: showBuilder },
  { id: 'route.save', category: 'Route', label: '現在のルートを保存', run: saveCurrentRoute },
  { id: 'hosts.reload', category: 'SSH', label: 'SSH config を再読み込み', run: () => void reloadHosts() },
  { id: 'session.close', category: 'Session', label: '現在のセッションを閉じる', run: closeActiveSession },
  { id: 'session.next', category: 'Session', label: '次のセッションへ移動', run: activateNextSession },
  {
    id: 'session.reconnect',
    category: 'Session',
    label: '現在のセッションへ接続 / 再接続',
    run: () => void startActiveSession(),
  },
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
  } catch (error) {
    toast(`SSH config の読み込みに失敗しました: ${String(error)}`);
  }
  renderHosts();
  renderRoute();
  renderWorkspaces();
  for (const session of sessions.values()) renderHopbar(session);
}

async function loadConfigPath(): Promise<void> {
  try {
    const path = await invoke<string>('ssh_config_path');
    // The rail is narrow, so show the trailing segments and keep the full path
    // in the tooltip instead of truncating the informative end away.
    const segments = path.split(/[\\/]/u).filter(Boolean);
    ui.configPath.textContent = segments.slice(-2).join('/') || path;
    ui.configPath.title = path;
  } catch {
    // The path is a convenience label; the host list already reports read failures.
  }
}

/**
 * Reloads `~/.ssh/config` in place so an edited Host shows up without a restart.
 * Open sessions keep their connection; only the host list and route state refresh.
 */
async function reloadHosts(): Promise<void> {
  ui.reloadHosts.disabled = true;
  try {
    await loadHosts();
    toast(`SSH config を再読み込みしました（${hosts.length} hosts）`);
  } finally {
    ui.reloadHosts.disabled = false;
  }
}

function hostAliases(): string[] {
  return hosts.map((host) => host.alias);
}

function persistWorkspaces(): void {
  workspaces = {
    saved: workspaces.saved,
    tabs: [...sessions.values()].map((session) => [...session.route]),
    activeTab: activeSessionKey ? [...sessions.keys()].indexOf(activeSessionKey) : -1,
  };
  try {
    saveWorkspaces(workspaces);
  } catch {
    // A full or disabled WebView storage must not interrupt an open session.
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
    const configPath = document.createElement('code');
    configPath.textContent = '~/.ssh/config';
    empty.append(
      document.createTextNode('Host がありません。'),
      document.createElement('br'),
      configPath,
      document.createTextNode(' に Host を追加すると、ここに表示されます。'),
    );
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
  const missing = missingAliases(route, hostAliases());
  ui.connect.disabled = route.length === 0 || missing.length > 0;
  ui.saveRoute.disabled = route.length === 0;

  if (route.length === 0) {
    ui.routeTrack.append(ui.routeEmpty);
    ui.routeHint.textContent = '';
    ui.statusRoute.textContent = 'NO ROUTE';
    return;
  }

  route.forEach((alias, index) => {
    const piece = document.createElement('div');
    piece.className = missing.includes(alias) ? 'route-piece missing' : 'route-piece';
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
  if (missing.length > 0) {
    ui.routeHint.replaceChildren();
    const lead = document.createTextNode('SSH config にない Host: ');
    const names = document.createElement('b');
    names.className = 'missing-alias';
    names.textContent = missing.join(', ');
    const tail = document.createTextNode('。config を更新して再読み込みするか、ピースを外してください。');
    ui.routeHint.append(lead, names, tail);
  } else if (route.length === 1 && preview.length > 1) {
    ui.routeHint.replaceChildren();
    const lead = document.createTextNode('OpenSSH ProxyJump: ');
    const path = document.createElement('b');
    path.textContent = preview.join(' → ');
    ui.routeHint.append(lead, path);
  } else {
    ui.routeHint.textContent = route.length > 1 ? '明示ルート: 配置した順番で direct-tcpip を接続します。' : '直接接続';
  }
}

function renderWorkspaces(): void {
  const aliases = hostAliases();
  ui.workspaceCount.textContent = `${workspaces.saved.length} saved`;
  ui.workspaceList.replaceChildren();

  if (workspaces.saved.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'workspace-empty';
    empty.textContent = 'よく使うルートに名前を付けて保存すると、次回から 1 クリックで組み立てられます。';
    ui.workspaceList.append(empty);
    return;
  }

  for (const entry of workspaces.saved) {
    const missing = missingAliases(entry.route, aliases);
    const card = document.createElement('article');
    card.className = missing.length > 0 ? 'workspace-card degraded' : 'workspace-card';
    card.setAttribute('role', 'listitem');

    const head = document.createElement('div');
    head.className = 'workspace-card-head';
    const name = document.createElement('strong');
    name.textContent = entry.name;
    const hops = document.createElement('span');
    hops.className = 'workspace-hops';
    hops.textContent = entry.route.length > 1 ? `${entry.route.length} HOP` : 'DIRECT';
    head.append(name, hops);

    const path = document.createElement('span');
    path.className = 'workspace-path';
    path.textContent = routePreview(entry.route, hosts).join(' → ');
    card.append(head, path);

    if (missing.length > 0) {
      const warning = document.createElement('p');
      warning.className = 'workspace-missing';
      warning.textContent = `SSH config にない Host: ${missing.join(', ')}`;
      card.append(warning);
    }

    const actions = document.createElement('div');
    actions.className = 'workspace-actions';
    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'workspace-action';
    load.textContent = '読み込む';
    load.addEventListener('click', () => loadSavedRoute(entry));
    const connect = document.createElement('button');
    connect.type = 'button';
    connect.className = 'workspace-action primary';
    connect.textContent = '接続';
    connect.disabled = missing.length > 0;
    connect.title = missing.length > 0 ? 'SSH config に無い Host を含むため接続できません' : `${entry.name} へ接続`;
    connect.addEventListener('click', () => void connectSavedRoute(entry));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'workspace-action remove';
    remove.textContent = '削除';
    remove.title = `${entry.name} を削除`;
    remove.addEventListener('click', () => deleteSavedRoute(entry));
    actions.append(load, connect, remove);
    card.append(actions);
    ui.workspaceList.append(card);
  }
}

function saveCurrentRoute(): void {
  showBuilder();
  if (route.length === 0) {
    toast('保存するルートがありません。Host をルートへ追加してください。');
    ui.hostSearch.focus();
    return;
  }
  const name = sanitizeName(ui.routeName.value) || suggestRouteName(route);
  if (!name) {
    toast('ルート名を入力してください。');
    ui.routeName.focus();
    return;
  }
  workspaces.saved = upsertSavedRoute(workspaces.saved, name, route);
  persistWorkspaces();
  renderWorkspaces();
  ui.routeName.value = '';
  toast(`ルートを保存しました: ${name}`);
}

function loadSavedRoute(entry: SavedRoute): void {
  showBuilder();
  route = [...entry.route];
  ui.routeName.value = entry.name;
  renderRoute();
}

async function connectSavedRoute(entry: SavedRoute): Promise<void> {
  route = [...entry.route];
  renderRoute();
  await connectRoute();
}

function deleteSavedRoute(entry: SavedRoute): void {
  workspaces.saved = removeSavedRoute(workspaces.saved, entry.id);
  persistWorkspaces();
  renderWorkspaces();
  toast(`保存したルートを削除しました: ${entry.name}`);
}

function showBuilder(): void {
  activeSessionKey = null;
  ui.builder.classList.remove('hidden');
  ui.terminalStage.classList.add('hidden');
  ui.statusMode.textContent = 'ROUTE';
  ui.connectionState.textContent = 'ROUTE READY';
  ui.connectionState.style.color = 'var(--green)';
  renderTabs();
  persistWorkspaces();
}

async function connectRoute(): Promise<void> {
  if (route.length === 0) return;
  const session = createSession([...route]);
  sessions.set(session.key, session);
  activateSession(session.key);
  await startSession(session);
}

/**
 * Opens the connection for a session that already owns a tab.
 *
 * Restored tabs and closed sessions both start here, so a reconnect reuses the
 * scrollback and tab position instead of creating a second tab.
 */
async function startSession(session: SessionUi): Promise<void> {
  if (session.state === 'connecting' || session.state === 'connected') return;
  const missing = missingAliases(session.route, hostAliases());
  if (missing.length > 0) {
    toast(`SSH config に無い Host のため接続できません: ${missing.join(', ')}`);
    return;
  }

  const connectionId = crypto.randomUUID();
  session.connectionId = connectionId;
  session.state = 'connecting';
  session.hops = [];
  renderHopbar(session);
  renderTabs();
  if (session.key === activeSessionKey) {
    session.fit.fit();
    updateConnectionState(session);
  }

  const onEvent = new Channel<SessionEvent>();
  onEvent.onmessage = (event) => handleSessionEvent(session, connectionId, event);
  const onData = new Channel<ArrayBuffer>();
  onData.onmessage = (data) => session.terminal.write(new Uint8Array(data));
  const request: ConnectRequest = {
    sessionId: connectionId,
    route: [...session.route],
    cols: session.terminal.cols,
    rows: session.terminal.rows,
  };
  session.terminal.writeln(
    `\x1b[38;2;255;180;84m[ope-term]\x1b[0m ${routePreview(session.route, hosts).join(' → ')} へ接続中…`,
  );
  try {
    await invoke('connect_session', { request, onEvent, onData });
  } catch (error) {
    handleSessionEvent(session, connectionId, { type: 'error', message: String(error) });
    handleSessionEvent(session, connectionId, { type: 'closed' });
  }
}

function startActiveSession(): Promise<void> {
  const session = activeSessionKey ? sessions.get(activeSessionKey) : undefined;
  return session ? startSession(session) : Promise.resolve();
}

/** Connects the active idle or closed tab, otherwise the route on the workbench. */
function connectCurrent(): Promise<void> {
  const session = activeSessionKey ? sessions.get(activeSessionKey) : undefined;
  if (session && (session.state === 'idle' || session.state === 'closed')) return startSession(session);
  if (session) return Promise.resolve();
  return connectRoute();
}

function createSession(sessionRoute: string[]): SessionUi {
  const key = crypto.randomUUID();
  const view = document.createElement('section');
  view.className = 'terminal-view inactive';
  view.dataset.sessionKey = key;
  const hopbar = document.createElement('header');
  hopbar.className = 'hopbar';
  const terminalContainer = document.createElement('div');
  terminalContainer.className = 'terminal-container';
  view.append(hopbar, terminalContainer);
  ui.terminalStage.append(view);

  const terminal = new Terminal({
    allowProposedApi: false,
    allowTransparency: false,
    cursorBlink: true,
    cursorStyle: 'bar',
    fontFamily: 'JetBrains Mono, HackGen Console NF, Cascadia Code, monospace',
    fontSize: 13,
    lineHeight: 1.16,
    linkHandler: {
      // Remote OSC 8 hyperlinks are rendered as text but never activated.
      activate: () => undefined,
      allowNonHttpProtocols: false,
    },
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
    // Escape-sequence window manipulation and reports stay explicitly disabled.
    windowOptions: {},
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
    key,
    connectionId: null,
    title: sessionRoute.at(-1) ?? 'ssh',
    route: sessionRoute,
    hops: [],
    terminal,
    fit,
    view,
    hopbar,
    inputBuffer: '',
    state: 'idle',
  };
  terminal.onData((data) => queueInput(session, data));
  terminal.onResize(({ cols, rows }) => queueResize(session, cols, rows));
  renderHopbar(session);
  return session;
}

function queueInput(session: SessionUi, data: string): void {
  const connectionId = session.connectionId;
  if (!connectionId || session.state === 'closed' || session.state === 'idle') return;
  session.inputBuffer += data;
  if (session.inputTimer !== undefined) return;
  session.inputTimer = window.setTimeout(() => {
    const input = session.inputBuffer;
    session.inputBuffer = '';
    session.inputTimer = undefined;
    if (input) void invoke('session_input', { sessionId: connectionId, data: input }).catch(() => undefined);
  }, 4);
}

function queueResize(session: SessionUi, cols: number, rows: number): void {
  if (session.resizeTimer !== undefined) window.clearTimeout(session.resizeTimer);
  session.resizeTimer = window.setTimeout(() => {
    session.resizeTimer = undefined;
    const connectionId = session.connectionId;
    if (connectionId && (session.state === 'connecting' || session.state === 'connected')) {
      void invoke('session_resize', { sessionId: connectionId, cols, rows }).catch(() => undefined);
    }
  }, 80);
}

function handleSessionEvent(session: SessionUi, connectionId: string, event: SessionEvent): void {
  // Events from a connection the tab already replaced by reconnecting are stale.
  if (session.connectionId !== connectionId) return;
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
    case 'host_key_prompt':
      enqueueHostKeyPrompt(session.key, connectionId, event.prompt);
      break;
    case 'auth_prompt':
      enqueueAuthPrompt(session.key, connectionId, event.prompt);
      break;
    case 'ready':
      session.state = 'connected';
      renderHopbar(session);
      renderTabs();
      if (session.key === activeSessionKey) updateConnectionState(session);
      session.terminal.focus();
      break;
    case 'error':
      session.terminal.writeln(`\r\n\x1b[38;2;242;125;136m[ope-term] ${event.message}\x1b[0m`);
      toast(event.message);
      break;
    case 'closed':
      session.state = 'closed';
      session.terminal.writeln(
        '\r\n\x1b[38;2;127;137;150m[ope-term] session closed · 再接続は Ctrl+Shift+Enter\x1b[0m',
      );
      renderHopbar(session);
      if (session.key === activeSessionKey) updateConnectionState(session);
      renderTabs();
      break;
  }
}

function enqueueHostKeyPrompt(sessionKey: string, connectionId: string, prompt: HostKeyPrompt): void {
  pendingHostKeyPrompts.push({ sessionKey, connectionId, prompt });
  showNextSecurePrompt();
}

function showNextSecurePrompt(): void {
  if (activeHostKeyPrompt || activeAuthPrompt) return;
  const hostKey = pendingHostKeyPrompts.shift();
  if (hostKey) {
    showHostKeyPrompt(hostKey);
    return;
  }
  const auth = pendingAuthPrompts.shift();
  if (auth) showAuthPrompt(auth);
}

function showHostKeyPrompt(item: HostKeyDialogItem): void {
  activeHostKeyPrompt = item;
  const { prompt } = item;
  const changed = prompt.status === 'changed';
  const box = ui.hostKeyDialog.querySelector<HTMLElement>('.host-key-box');
  box?.classList.toggle('changed', changed);
  ui.hostKeyTitle.textContent = changed ? 'ホスト鍵が変更されています' : '未知のホスト鍵';
  ui.hostKeyStatus.textContent = changed ? 'CHANGED · BLOCKED' : 'UNKNOWN';
  ui.hostKeyMessage.textContent = changed
    ? '以前に保存した鍵と、接続先が提示した鍵が一致しません。中間者攻撃またはサーバー再構築の可能性があるため、接続を拒否しました。'
    : 'この接続先の鍵は known_hosts にありません。管理者や別の安全な経路で SHA256 fingerprint を照合してから選択してください。';
  ui.hostKeyHop.textContent = prompt.hop;
  ui.hostKeyEndpoint.textContent = `${prompt.hostname}:${prompt.port}`;
  ui.hostKeyAlgorithm.textContent = prompt.algorithm;
  ui.hostKeyFingerprint.textContent = prompt.fingerprint;
  ui.hostKeyGuidance.textContent = changed
    ? `known_hosts ${prompt.existingLine ?? '?'} 行目を自動更新しません。変更が正当だと確認できた場合のみ、OpenSSH の ssh-keygen -R などで既存鍵を手動削除して再接続してください。`
    : '「今回のみ」はファイルを変更しません。「信頼して保存」は ~/.ssh/known_hosts に追記し、次回から同じ鍵だけを許可します。';
  ui.hostKeyReject.textContent = changed ? '閉じる' : '接続しない';
  ui.hostKeyOnce.classList.toggle('hidden', changed);
  ui.hostKeySave.classList.toggle('hidden', changed);
  setHostKeyButtonsDisabled(false);
  ui.hostKeyDialog.classList.remove('hidden');
  window.requestAnimationFrame(() => ui.hostKeyReject.focus());
}

function setHostKeyButtonsDisabled(disabled: boolean): void {
  ui.hostKeyReject.disabled = disabled;
  ui.hostKeyOnce.disabled = disabled;
  ui.hostKeySave.disabled = disabled;
}

function finishHostKeyPrompt(): void {
  activeHostKeyPrompt = null;
  ui.hostKeyDialog.classList.add('hidden');
  showNextSecurePrompt();
}

async function answerHostKey(decision: 'reject' | 'trust_once' | 'trust_and_save'): Promise<void> {
  const active = activeHostKeyPrompt;
  if (!active) return;
  if (active.prompt.status === 'changed') {
    finishHostKeyPrompt();
    return;
  }
  setHostKeyButtonsDisabled(true);
  try {
    await invoke('answer_host_key', {
      sessionId: active.connectionId,
      requestId: active.prompt.requestId,
      decision,
    });
  } catch (error) {
    toast(`ホスト鍵の応答に失敗しました: ${String(error)}`);
  } finally {
    finishHostKeyPrompt();
  }
}

function discardHostKeyPrompts(sessionKey: string): void {
  for (let index = pendingHostKeyPrompts.length - 1; index >= 0; index -= 1) {
    if (pendingHostKeyPrompts[index]?.sessionKey === sessionKey) pendingHostKeyPrompts.splice(index, 1);
  }
  if (activeHostKeyPrompt?.sessionKey === sessionKey) finishHostKeyPrompt();
}

function enqueueAuthPrompt(sessionKey: string, connectionId: string, prompt: AuthPrompt): void {
  pendingAuthPrompts.push({ sessionKey, connectionId, prompt });
  showNextSecurePrompt();
}

function showAuthPrompt(item: AuthDialogItem): void {
  activeAuthPrompt = item;
  const { prompt } = item;
  const defaults = {
    password: { title: 'SSH パスワード', kind: 'PASSWORD' },
    keyboard_interactive: { title: '追加認証', kind: 'KEYBOARD INTERACTIVE' },
    key_passphrase: { title: '秘密鍵のパスフレーズ', kind: 'KEY PASSPHRASE' },
  } as const;
  const fallback = defaults[prompt.kind];
  ui.authTitle.textContent = prompt.title.trim() || fallback.title;
  ui.authKind.textContent = fallback.kind;
  ui.authHop.textContent = prompt.hop;
  ui.authUsername.textContent = prompt.username;
  ui.authInstructions.textContent = prompt.instructions;
  ui.authFields.replaceChildren();
  prompt.fields.forEach((field, index) => {
    const label = document.createElement('label');
    label.className = 'auth-field';
    const copy = document.createElement('span');
    copy.textContent = field.label || `Prompt ${index + 1}`;
    const input = document.createElement('input');
    input.type = field.echo ? 'text' : 'password';
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    input.dataset.authField = String(index);
    input.setAttribute('aria-label', copy.textContent);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void submitAuthPrompt(false);
      }
    });
    label.append(copy, input);
    ui.authFields.append(label);
  });
  setAuthButtonsDisabled(false);
  ui.authDialog.classList.remove('hidden');
  window.requestAnimationFrame(() => {
    const first = ui.authFields.querySelector<HTMLInputElement>('input');
    (first ?? ui.authSubmit).focus();
  });
}

function setAuthButtonsDisabled(disabled: boolean): void {
  ui.authCancel.disabled = disabled;
  ui.authSubmit.disabled = disabled;
  for (const input of ui.authFields.querySelectorAll<HTMLInputElement>('input')) input.disabled = disabled;
}

function finishAuthPrompt(): void {
  for (const input of ui.authFields.querySelectorAll<HTMLInputElement>('input')) input.value = '';
  ui.authFields.replaceChildren();
  activeAuthPrompt = null;
  ui.authDialog.classList.add('hidden');
  showNextSecurePrompt();
}

async function submitAuthPrompt(cancelled: boolean): Promise<void> {
  const active = activeAuthPrompt;
  if (!active) return;
  const inputs = [...ui.authFields.querySelectorAll<HTMLInputElement>('input')];
  const responses = cancelled ? [] : takeAndClearAuthResponses(inputs);
  setAuthButtonsDisabled(true);
  try {
    await invoke('answer_auth', {
      sessionId: active.connectionId,
      requestId: active.prompt.requestId,
      responses,
      cancelled,
    });
    finishAuthPrompt();
  } catch (error) {
    toast(`認証応答の送信に失敗しました: ${String(error)}`);
    setAuthButtonsDisabled(false);
    window.requestAnimationFrame(() => {
      const first = ui.authFields.querySelector<HTMLInputElement>('input');
      (first ?? ui.authCancel).focus();
    });
  } finally {
    clearAuthResponses(responses);
  }
}

function discardAuthPrompts(sessionKey: string): void {
  for (let index = pendingAuthPrompts.length - 1; index >= 0; index -= 1) {
    if (pendingAuthPrompts[index]?.sessionKey === sessionKey) pendingAuthPrompts.splice(index, 1);
  }
  if (activeAuthPrompt?.sessionKey === sessionKey) finishAuthPrompt();
}

function renderHopbar(session: SessionUi): void {
  session.hopbar.replaceChildren();
  const live = session.state === 'connecting' || session.state === 'connected';
  // Before the backend reports a chain, show the planned hops so an idle or
  // restored tab still explains where it would connect.
  const hops: HopStatus[] =
    session.hops.length > 0
      ? session.hops
      : routePreview(session.route, hosts).map((alias, index) => ({ index, alias, state: 'pending' as const }));
  hops.forEach((hop, index) => {
    const node = document.createElement('span');
    node.className = `hop ${hop.state}`;
    node.textContent = hop.alias;
    session.hopbar.append(node);
    if (index < hops.length - 1) {
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

  if (live) return;
  const missing = missingAliases(session.route, hostAliases());
  if (missing.length > 0) {
    const warning = document.createElement('span');
    warning.className = 'hop-missing';
    warning.textContent = `SSH config にない Host: ${missing.join(', ')}`;
    session.hopbar.append(warning);
  }
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'hop-action';
  action.textContent = session.state === 'closed' ? '再接続' : '接続';
  action.disabled = missing.length > 0;
  action.title = missing.length > 0 ? 'SSH config に無い Host を含むため接続できません' : 'Ctrl+Shift+Enter';
  action.addEventListener('click', () => void startSession(session));
  session.hopbar.append(action);
}

function activateSession(key: string): void {
  const session = sessions.get(key);
  if (!session) return;
  activeSessionKey = key;
  ui.builder.classList.add('hidden');
  ui.terminalStage.classList.remove('hidden');
  ui.statusMode.textContent = 'TERMINAL';
  ui.statusRoute.textContent = session.route.join(' → ');
  for (const candidate of sessions.values()) {
    candidate.view.classList.toggle('inactive', candidate.key !== key);
  }
  renderTabs();
  updateConnectionState(session);
  persistWorkspaces();
  window.requestAnimationFrame(() => {
    session.fit.fit();
    session.terminal.focus();
  });
}

function updateConnectionState(session: SessionUi): void {
  const labels = {
    idle: 'NOT CONNECTED',
    connecting: 'CONNECTING',
    connected: 'SSH CONNECTED',
    closed: 'DISCONNECTED',
  } as const;
  const colors = {
    idle: 'var(--muted)',
    connecting: 'var(--amber)',
    connected: 'var(--green)',
    closed: 'var(--red)',
  } as const;
  ui.connectionState.textContent = labels[session.state];
  ui.connectionState.style.color = colors[session.state];
}

function renderTabs(): void {
  ui.tabs.replaceChildren();
  for (const session of sessions.values()) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `session-tab${session.key === activeSessionKey ? ' active' : ''}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(session.key === activeSessionKey));
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
      closeSession(session.key);
    });
    tab.append(dot, label, close);
    tab.addEventListener('click', () => activateSession(session.key));
    ui.tabs.append(tab);
  }
}

function closeSession(key: string): void {
  const session = sessions.get(key);
  if (!session) return;
  const connectionId = session.connectionId;
  if (connectionId && (session.state === 'connecting' || session.state === 'connected')) {
    void invoke('close_session', { sessionId: connectionId }).catch(() => undefined);
  }
  discardHostKeyPrompts(key);
  discardAuthPrompts(key);
  if (session.inputTimer !== undefined) window.clearTimeout(session.inputTimer);
  if (session.resizeTimer !== undefined) window.clearTimeout(session.resizeTimer);
  session.terminal.dispose();
  session.view.remove();
  sessions.delete(key);
  if (activeSessionKey === key) {
    const next = [...sessions.keys()].at(-1);
    if (next) activateSession(next);
    else showBuilder();
  }
  renderTabs();
  persistWorkspaces();
}

function closeActiveSession(): void {
  if (activeSessionKey) closeSession(activeSessionKey);
}

function activateNextSession(): void {
  const keys = [...sessions.keys()];
  if (keys.length === 0) return;
  const index = activeSessionKey ? keys.indexOf(activeSessionKey) : -1;
  activateSession(keys[(index + 1) % keys.length] ?? keys[0]!);
}

/**
 * Recreates last session's tabs as idle terminals. Restoring a tab never opens a
 * connection: the operator decides when a bastion sees traffic again.
 */
function restoreTabs(): void {
  const { tabs, activeTab } = workspaces;
  if (tabs.length === 0) return;
  const keys: string[] = [];
  for (const savedRoute of tabs) {
    const session = createSession([...savedRoute]);
    sessions.set(session.key, session);
    keys.push(session.key);
    const preview = routePreview(session.route, hosts).join(' → ');
    session.terminal.writeln(`\x1b[38;2;127;137;150m[ope-term] 前回のタブを復元しました: ${preview}\x1b[0m`);
    session.terminal.writeln(
      '\x1b[38;2;127;137;150m[ope-term] 接続はまだ開始していません。接続するには CONNECT または Ctrl+Shift+Enter。\x1b[0m',
    );
  }
  renderTabs();
  const restoredKey = activeTab >= 0 ? keys[activeTab] : undefined;
  if (restoredKey) activateSession(restoredKey);
  toast(`前回のタブを ${keys.length} 件復元しました。接続は自動では開始しません。`);
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
  const workspaceItems = workspaces.saved.map((entry) => ({
    id: `workspace.${entry.id}`,
    category: 'Workspace',
    label: entry.name,
    detail: routePreview(entry.route, hosts).join(' → '),
    run: () => void connectSavedRoute(entry),
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
  return [...base, ...workspaceItems, ...hostItems];
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
ui.reloadHosts.addEventListener('click', () => void reloadHosts());
ui.saveRoute.addEventListener('click', saveCurrentRoute);
ui.routeName.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  saveCurrentRoute();
});
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
ui.hostKeyReject.addEventListener('click', () => {
  if (activeHostKeyPrompt?.prompt.status === 'changed') finishHostKeyPrompt();
  else void answerHostKey('reject');
});
ui.hostKeyOnce.addEventListener('click', () => void answerHostKey('trust_once'));
ui.hostKeySave.addEventListener('click', () => void answerHostKey('trust_and_save'));
ui.authCancel.addEventListener('click', () => void submitAuthPrompt(true));
ui.authSubmit.addEventListener('click', () => void submitAuthPrompt(false));
ui.shortcutEditor.addEventListener('mousedown', (event) => {
  if (event.target === ui.shortcutEditor) closeShortcutEditor();
});

window.addEventListener(
  'keydown',
  (event) => {
    if (!ui.authDialog.classList.contains('hidden')) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        void submitAuthPrompt(true);
      }
      return;
    }
    if (!ui.hostKeyDialog.classList.contains('hidden')) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (activeHostKeyPrompt?.prompt.status === 'changed') finishHostKeyPrompt();
        else void answerHostKey('reject');
      }
      return;
    }
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
  if (!activeSessionKey) return;
  const session = sessions.get(activeSessionKey);
  if (session) window.requestAnimationFrame(() => session.fit.fit());
});

async function boot(): Promise<void> {
  await loadHosts();
  void loadConfigPath();
  restoreTabs();
}

void boot();

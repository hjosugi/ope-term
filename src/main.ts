import { Channel, invoke } from '@tauri-apps/api/core';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import './style.css';

import { clearAuthResponses, takeAndClearAuthResponses } from './auth-secrets';
import { fuzzyFilter } from './fuzzy';
import {
  KEY_SEQUENCE_TIMEOUT_MS,
  defaultKeybindings,
  detectOperatingSystem,
  eventToChord,
  exportKeybindings,
  findKeybindingConflicts,
  formatKeySequence,
  importKeybindings,
  loadKeybindings,
  resolveKeybinding,
  saveKeybindings,
  type CommandContext,
  type CommandId,
} from './keybindings';
import { MAX_AUTO_RETRIES, closeMessage, retryDelayMs, shouldAutoRetry } from './reconnect';
import type { BrowserPerformanceHarness } from './performance';
import {
  containsPaneSession,
  focusPane,
  paneLeaf,
  paneSessions,
  removePaneSession,
  replacePaneSession,
  resizePane,
  setSplitRatio,
  splitPane,
  type PaneAxis,
  type PaneDirection,
  type PaneLayout,
  type PaneSplit,
} from './pane-layout';
import { appendUnique, moveRouteItem, routePreview } from './route';
import { createSftpPanel, type SftpPanel } from './sftp-ui';
import type {
  AuthPrompt,
  CloseReason,
  ConnectRequest,
  HopStatus,
  HostKeyPrompt,
  HostProfile,
  SessionEvent,
} from './types';
import {
  loadWorkspaces,
  missingAliases,
  removeSavedRoute,
  restorePaneLayout,
  sanitizeName,
  saveWorkspaces,
  storePaneLayout,
  suggestRouteName,
  upsertSavedRoute,
  type SavedRoute,
  type WorkspaceState,
} from './workspaces';

type SessionState = 'idle' | 'connecting' | 'connected' | 'closed';
type SessionKind = 'ssh' | 'local';

interface ShellProfile {
  id: string;
  label: string;
  program: string;
  isDefault: boolean;
}

interface LocalDirectory {
  token: string;
  displayPath: string;
}

interface LocalSessionConfig {
  profileId: string;
  profileLabel: string;
  workingDirectory: LocalDirectory | null;
  shellIntegration: boolean;
  commandBoundaries: number;
}

interface SessionUi {
  /** Stable UI identity that survives reconnects. */
  key: string;
  /** Backend session id of the current connection, or null while idle. */
  connectionId: string | null;
  title: string;
  kind: SessionKind;
  local?: LocalSessionConfig;
  route: string[];
  hops: HopStatus[];
  terminal: Terminal;
  fit: FitAddon;
  view: HTMLElement;
  hopbar: HTMLElement;
  sftp: SftpPanel;
  inputBuffer: string;
  inputTimer?: number;
  resizeTimer?: number;
  state: SessionState;
  closeReason?: CloseReason;
  /** Consecutive automatic reconnect attempts, reset by a ready session. */
  retryAttempt: number;
  retryTimer?: number;
  retryTick?: number;
  retryAt?: number;
}

interface CommandDefinition {
  id: CommandId;
  category: string;
  label: string;
  when?: string;
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

interface PendingPaneSplit {
  anchorSessionKey: string;
  axis: PaneAxis;
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
  shortcutPlatform: element<HTMLElement>('shortcut-platform'),
  shortcutQuery: element<HTMLInputElement>('shortcut-query'),
  shortcutList: element<HTMLElement>('shortcut-list'),
  shortcutImport: element<HTMLInputElement>('shortcut-import'),
  panePicker: element<HTMLElement>('pane-picker'),
  panePickerTitle: element<HTMLElement>('pane-picker-title'),
  panePickerList: element<HTMLElement>('pane-picker-list'),
  paneNewRoute: element<HTMLButtonElement>('pane-new-route'),
  paneNewLocal: element<HTMLButtonElement>('pane-new-local'),
  panePickerCancel: element<HTMLButtonElement>('pane-picker-cancel'),
  localTerminalDialog: element<HTMLElement>('local-terminal-dialog'),
  localTerminalClose: element<HTMLButtonElement>('local-terminal-close'),
  localTerminalCancel: element<HTMLButtonElement>('local-terminal-cancel'),
  localTerminalOpen: element<HTMLButtonElement>('local-terminal-open'),
  localShellProfile: element<HTMLSelectElement>('local-shell-profile'),
  localDirectoryLabel: element<HTMLElement>('local-directory-label'),
  localDirectoryPick: element<HTMLButtonElement>('local-directory-pick'),
  localDirectoryClear: element<HTMLButtonElement>('local-directory-clear'),
  localShellIntegration: element<HTMLInputElement>('local-shell-integration'),
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
let paneLayout: PaneLayout | null = null;
let pendingPaneSplit: PendingPaneSplit | null = null;
let localProfiles: ShellProfile[] = [];
let selectedLocalDirectory: LocalDirectory | null = null;
let workspaces: WorkspaceState = loadWorkspaces();
let selectedCommand = 0;
let paletteItems: PaletteItem[] = [];
let recordingCommand: CommandId | null = null;
let recordingChords: string[] = [];
let recordingTimer: number | undefined;
let pendingKeyChords: string[] = [];
let pendingKeyTimer: number | undefined;
const operatingSystem = detectOperatingSystem();
const defaultBindings = defaultKeybindings(operatingSystem);
let keybindings = loadKeybindings(localStorage, operatingSystem);
let activeHostKeyPrompt: HostKeyDialogItem | null = null;
const pendingHostKeyPrompts: HostKeyDialogItem[] = [];
let activeAuthPrompt: AuthDialogItem | null = null;
const pendingAuthPrompts: AuthDialogItem[] = [];
const sessions = new Map<string, SessionUi>();
let performanceHarness: BrowserPerformanceHarness | undefined;
const performanceHarnessReady = localStorage.getItem('ope-term.performance.enabled') === 'true'
  ? import('./performance').then(({ BrowserPerformanceHarness: Harness }) => {
      performanceHarness = new Harness();
      performanceHarness.start();
      window.__opeTermPerformance = performanceHarness;
    })
  : Promise.resolve();

const commands: CommandDefinition[] = [
  {
    id: 'workbench.action.showCommands',
    category: 'View',
    label: 'Command Palette を表示',
    when: '!paletteOpen && !shortcutEditorOpen',
    run: openCommandPalette,
  },
  {
    id: 'workbench.action.quickOpenHost',
    category: 'SSH',
    label: 'Host を検索',
    when: '!paletteOpen && !shortcutEditorOpen',
    run: focusHostSearch,
  },
  { id: 'route.connect', category: 'Route', label: '現在のルートへ接続', when: 'routeFocus && !paletteOpen && !shortcutEditorOpen', run: () => void connectCurrent() },
  { id: 'route.clear', category: 'Route', label: 'ルートをクリア', when: 'routeFocus && !paletteOpen && !shortcutEditorOpen', run: clearRoute },
  { id: 'route.new', category: 'Route', label: '新しいルート', when: '!paletteOpen && !shortcutEditorOpen', run: showBuilder },
  { id: 'route.save', category: 'Route', label: '現在のルートを保存', when: 'routeFocus && !paletteOpen && !shortcutEditorOpen', run: saveCurrentRoute },
  { id: 'hosts.reload', category: 'SSH', label: 'SSH config を再読み込み', when: 'routeFocus && !paletteOpen && !shortcutEditorOpen', run: () => void reloadHosts() },
  { id: 'session.close', category: 'Session', label: '現在のセッションを閉じる', when: 'terminalFocus && !paletteOpen && !shortcutEditorOpen', run: closeActiveSession },
  { id: 'session.next', category: 'Session', label: '次のセッションへ移動', when: 'terminalFocus && !paletteOpen && !shortcutEditorOpen', run: activateNextSession },
  {
    id: 'session.reconnect',
    category: 'Session',
    label: '現在のセッションへ接続 / 再接続',
    when: 'terminalFocus && !paletteOpen && !shortcutEditorOpen',
    run: () => void startActiveSession(),
  },
  {
    id: 'session.toggleSftp',
    category: 'Files',
    label: 'SFTP file manager を開く / 閉じる',
    when: 'terminalFocus && !paletteOpen && !shortcutEditorOpen',
    run: toggleActiveSftp,
  },
  {
    id: 'session.newLocal',
    category: 'Terminal',
    label: '新しい local terminal を開く',
    when: '!paletteOpen && !shortcutEditorOpen',
    run: () => void openLocalTerminalDialog(),
  },
  { id: 'pane.splitRight', category: 'Pane', label: '右に分割', when: 'terminalFocus && !paletteOpen && !shortcutEditorOpen', run: () => openPanePicker('horizontal') },
  { id: 'pane.splitDown', category: 'Pane', label: '下に分割', when: 'terminalFocus && !paletteOpen && !shortcutEditorOpen', run: () => openPanePicker('vertical') },
  { id: 'pane.focusLeft', category: 'Pane', label: '左の pane へ focus', when: 'terminalFocus && !paletteOpen && !shortcutEditorOpen', run: () => movePaneFocus('left') },
  { id: 'pane.focusRight', category: 'Pane', label: '右の pane へ focus', when: 'terminalFocus && !paletteOpen && !shortcutEditorOpen', run: () => movePaneFocus('right') },
  { id: 'pane.focusUp', category: 'Pane', label: '上の pane へ focus', when: 'terminalFocus && !paletteOpen && !shortcutEditorOpen', run: () => movePaneFocus('up') },
  { id: 'pane.focusDown', category: 'Pane', label: '下の pane へ focus', when: 'terminalFocus && !paletteOpen && !shortcutEditorOpen', run: () => movePaneFocus('down') },
  { id: 'pane.close', category: 'Pane', label: '現在の pane を閉じる', when: 'terminalFocus && !paletteOpen && !shortcutEditorOpen', run: closeActivePane },
  { id: 'pane.resizeWider', category: 'Pane', label: 'pane を横に広げる', when: 'terminalFocus && !paletteOpen && !shortcutEditorOpen', run: () => resizeActivePane('horizontal', 0.05) },
  { id: 'pane.resizeNarrower', category: 'Pane', label: 'pane を横に狭める', when: 'terminalFocus && !paletteOpen && !shortcutEditorOpen', run: () => resizeActivePane('horizontal', -0.05) },
  { id: 'pane.resizeTaller', category: 'Pane', label: 'pane を縦に広げる', when: 'terminalFocus && !paletteOpen && !shortcutEditorOpen', run: () => resizeActivePane('vertical', 0.05) },
  { id: 'pane.resizeShorter', category: 'Pane', label: 'pane を縦に狭める', when: 'terminalFocus && !paletteOpen && !shortcutEditorOpen', run: () => resizeActivePane('vertical', -0.05) },
  {
    id: 'preferences.openKeyboardShortcuts',
    category: 'Preferences',
    label: 'Keyboard Shortcuts を開く',
    when: '!paletteOpen && !shortcutEditorOpen',
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
  const sessionKeys = [...sessions.keys()];
  workspaces = {
    saved: workspaces.saved,
    tabs: [...sessions.values()].map((session) => [...session.route]),
    activeTab: activeSessionKey ? sessionKeys.indexOf(activeSessionKey) : -1,
    paneLayout: storePaneLayout(paneLayout, sessionKeys),
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

function showBuilder(cancelPendingSplit = true): void {
  if (cancelPendingSplit) pendingPaneSplit = null;
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
  const split = pendingPaneSplit;
  pendingPaneSplit = null;
  let splitAdded = false;
  if (split && containsPaneSession(paneLayout, split.anchorSessionKey)) {
    paneLayout = splitPane(paneLayout, split.anchorSessionKey, session.key, split.axis);
    splitAdded = true;
  }
  activateSession(session.key);
  if (splitAdded) renderPaneLayout();
  await startSession(session);
}

/**
 * Opens the connection for a session that already owns a tab.
 *
 * Restored tabs and closed sessions both start here, so a reconnect reuses the
 * scrollback and tab position instead of creating a second tab.
 */
async function startSession(session: SessionUi, resetRetries = true): Promise<void> {
  if (session.state === 'connecting' || session.state === 'connected') return;
  clearRetryTimers(session);
  if (resetRetries) session.retryAttempt = 0;
  const missing = session.kind === 'ssh' ? missingAliases(session.route, hostAliases()) : [];
  if (missing.length > 0) {
    toast(`SSH config に無い Host のため接続できません: ${missing.join(', ')}`);
    renderHopbar(session);
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
  onData.onmessage = (data) => {
    performanceHarness?.recordOutput(data.byteLength);
    session.terminal.write(new Uint8Array(data));
  };
  try {
    if (session.kind === 'local' && session.local) {
      session.terminal.writeln(
        `\x1b[38;2;255;180;84m[ope-term]\x1b[0m ${session.local.profileLabel} を local PTY で起動中…`,
      );
      await invoke('connect_local_session', {
        request: {
          sessionId: connectionId,
          profileId: session.local.profileId,
          workingDirectoryToken: session.local.workingDirectory?.token,
          shellIntegration: session.local.shellIntegration,
          cols: session.terminal.cols,
          rows: session.terminal.rows,
        },
        onEvent,
        onData,
      });
    } else {
      const request: ConnectRequest = {
        sessionId: connectionId,
        route: [...session.route],
        cols: session.terminal.cols,
        rows: session.terminal.rows,
      };
      session.terminal.writeln(
        `\x1b[38;2;255;180;84m[ope-term]\x1b[0m ${routePreview(session.route, hosts).join(' → ')} へ接続中…`,
      );
      await invoke('connect_session', { request, onEvent, onData });
    }
  } catch (error) {
    handleSessionEvent(session, connectionId, { type: 'error', message: String(error) });
    handleSessionEvent(session, connectionId, { type: 'closed', reason: 'failed' });
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

function createSession(sessionRoute: string[], local?: LocalSessionConfig): SessionUi {
  const key = crypto.randomUUID();
  const view = document.createElement('section');
  view.className = 'terminal-view inactive';
  view.dataset.sessionKey = key;
  const hopbar = document.createElement('header');
  hopbar.className = 'hopbar';
  const terminalContainer = document.createElement('div');
  terminalContainer.className = 'terminal-container';
  const sessionBody = document.createElement('div');
  sessionBody.className = 'session-body';
  sessionBody.append(terminalContainer);
  view.append(hopbar, sessionBody);
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
    webgl.onContextLoss(() => {
      webgl.dispose();
      performanceHarness?.setRenderer('fallback');
    });
    terminal.loadAddon(webgl);
    performanceHarness?.setRenderer('webgl');
  } catch {
    // WebGL is optional on WebKitGTK; xterm's renderer is the stable fallback.
    performanceHarness?.setRenderer('fallback');
  }
  fit.fit();

  let session: SessionUi;
  const sftp = createSftpPanel({
    getConnectionId: () => session.kind === 'ssh' ? session.connectionId : null,
    onLayoutChange: () => window.requestAnimationFrame(() => session.fit.fit()),
    notify: toast,
  });
  sessionBody.append(sftp.element);

  session = {
    key,
    connectionId: null,
    title: local?.profileLabel ?? sessionRoute.at(-1) ?? 'ssh',
    kind: local ? 'local' : 'ssh',
    local,
    route: sessionRoute,
    hops: [],
    terminal,
    fit,
    view,
    hopbar,
    sftp,
    inputBuffer: '',
    state: 'idle',
    retryAttempt: 0,
  };
  terminal.onData((data) => queueInput(session, data));
  terminal.onResize(({ cols, rows }) => queueResize(session, cols, rows));
  if (local?.shellIntegration) {
    terminal.parser.registerOscHandler(133, () => {
      local.commandBoundaries += 1;
      renderHopbar(session);
      return true;
    });
  }
  renderHopbar(session);
  return session;
}

function toggleActiveSftp(): void {
  const session = activeSessionKey ? sessions.get(activeSessionKey) : undefined;
  if (session?.kind === 'local') {
    toast('SFTP は SSH session でのみ使用できます。');
    return;
  }
  session?.sftp.toggle();
}

/**
 * Drops input that was typed but not yet flushed.
 *
 * A reconnect opens a new shell, so anything buffered for the old one must never
 * reach it: a half-typed command replayed into a fresh prompt is a live incident.
 */
function discardPendingInput(session: SessionUi): void {
  if (session.inputTimer !== undefined) window.clearTimeout(session.inputTimer);
  session.inputTimer = undefined;
  session.inputBuffer = '';
}

function clearRetryTimers(session: SessionUi): void {
  if (session.retryTimer !== undefined) window.clearTimeout(session.retryTimer);
  if (session.retryTick !== undefined) window.clearInterval(session.retryTick);
  session.retryTimer = undefined;
  session.retryTick = undefined;
  session.retryAt = undefined;
}

/** Schedules the next automatic reconnect and shows the countdown in the hopbar. */
function scheduleRetry(session: SessionUi): void {
  clearRetryTimers(session);
  session.retryAttempt += 1;
  const delay = retryDelayMs(session.retryAttempt);
  session.retryAt = Date.now() + delay;
  session.terminal.writeln(
    `\x1b[38;2;255;180;84m[ope-term]\x1b[0m ${Math.round(delay / 1000)} 秒後に再接続します（${session.retryAttempt}/${MAX_AUTO_RETRIES}）`,
  );
  session.retryTimer = window.setTimeout(() => {
    session.retryTimer = undefined;
    void startSession(session, false);
  }, delay);
  session.retryTick = window.setInterval(() => renderHopbar(session), 1000);
  renderHopbar(session);
  renderTabs();
  if (session.key === activeSessionKey) updateConnectionState(session);
}

function cancelRetry(session: SessionUi): void {
  clearRetryTimers(session);
  session.retryAttempt = 0;
  session.terminal.writeln('\x1b[38;2;127;137;150m[ope-term] 自動再接続を停止しました\x1b[0m');
  renderHopbar(session);
  renderTabs();
  if (session.key === activeSessionKey) updateConnectionState(session);
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
      session.closeReason = undefined;
      session.retryAttempt = 0;
      renderHopbar(session);
      renderTabs();
      if (session.key === activeSessionKey) updateConnectionState(session);
      session.terminal.focus();
      break;
    case 'error':
      session.terminal.writeln(`\r\n\x1b[38;2;242;125;136m[ope-term] ${event.message}\x1b[0m`);
      toast(event.message);
      break;
    case 'closed': {
      session.state = 'closed';
      session.closeReason = event.reason;
      session.connectionId = null;
      discardPendingInput(session);
      const message = session.kind === 'local' && event.reason === 'remote'
        ? 'local shell が終了しました'
        : closeMessage(event.reason);
      session.terminal.writeln(
        `\r\n\x1b[38;2;127;137;150m[ope-term] ${message} · 再起動は Ctrl+Shift+Enter\x1b[0m`,
      );
      if (session.kind === 'ssh' && shouldAutoRetry(event.reason, session.retryAttempt + 1)) {
        scheduleRetry(session);
      } else {
        clearRetryTimers(session);
        renderHopbar(session);
        renderTabs();
        if (session.key === activeSessionKey) updateConnectionState(session);
      }
      break;
    }
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
  clearPendingKeySequence();
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
  clearPendingKeySequence();
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
  const hops: HopStatus[] = session.kind === 'local'
    ? [{ index: 0, alias: 'LOCAL PTY', state: session.state === 'connected' ? 'connected' : 'pending' }]
    : session.hops.length > 0
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
  if (session.local?.shellIntegration) {
    const integration = document.createElement('span');
    integration.className = 'hop-retry';
    integration.textContent = `OSC 133 · ${session.local.commandBoundaries} boundaries`;
    session.hopbar.append(integration);
  }
  const closePaneButton = document.createElement('button');
  closePaneButton.type = 'button';
  closePaneButton.className = 'pane-close';
  closePaneButton.textContent = '×';
  closePaneButton.title = 'pane を閉じる（session は tab に残ります）';
  closePaneButton.setAttribute('aria-label', `${session.title} の pane を閉じる`);
  closePaneButton.addEventListener('click', () => closePane(session.key));
  session.hopbar.append(closePaneButton);

  if (live) return;
  const missing = session.kind === 'ssh' ? missingAliases(session.route, hostAliases()) : [];
  if (missing.length > 0) {
    const warning = document.createElement('span');
    warning.className = 'hop-missing';
    warning.textContent = `SSH config にない Host: ${missing.join(', ')}`;
    session.hopbar.append(warning);
  }

  if (session.retryAt !== undefined) {
    const seconds = Math.max(0, Math.ceil((session.retryAt - Date.now()) / 1000));
    const countdown = document.createElement('span');
    countdown.className = 'hop-retry';
    countdown.textContent = `再接続まで ${seconds} 秒（${session.retryAttempt}/${MAX_AUTO_RETRIES}）`;
    const now = document.createElement('button');
    now.type = 'button';
    now.className = 'hop-action';
    now.textContent = '今すぐ';
    now.addEventListener('click', () => void startSession(session));
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'hop-action ghost';
    stop.textContent = '自動再接続を停止';
    stop.addEventListener('click', () => cancelRetry(session));
    session.hopbar.append(countdown, now, stop);
    return;
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
  let layoutChanged = false;
  if (!paneLayout) {
    paneLayout = paneLeaf(key);
    layoutChanged = true;
  } else if (!containsPaneSession(paneLayout, key)) {
    const target = activeSessionKey && containsPaneSession(paneLayout, activeSessionKey)
      ? activeSessionKey
      : paneSessions(paneLayout)[0];
    paneLayout = target ? replacePaneSession(paneLayout, target, key) : paneLeaf(key);
    layoutChanged = true;
  }
  activeSessionKey = key;
  ui.builder.classList.add('hidden');
  ui.terminalStage.classList.remove('hidden');
  ui.statusMode.textContent = 'TERMINAL';
  ui.statusRoute.textContent = session.kind === 'local'
    ? `LOCAL · ${session.local?.workingDirectory?.displayPath ?? 'default directory'}`
    : session.route.join(' → ');
  if (layoutChanged) renderPaneLayout();
  for (const pane of ui.terminalStage.querySelectorAll<HTMLElement>('.pane-leaf')) {
    pane.classList.toggle('active', pane.dataset.sessionKey === key);
  }
  renderTabs();
  updateConnectionState(session);
  persistWorkspaces();
  window.requestAnimationFrame(() => {
    session.fit.fit();
    session.terminal.focus();
  });
}

function renderPaneLayout(): void {
  ui.terminalStage.replaceChildren();
  if (!paneLayout) return;
  ui.terminalStage.append(buildPaneNode(paneLayout));
  window.requestAnimationFrame(() => {
    for (const key of paneSessions(paneLayout)) sessions.get(key)?.fit.fit();
  });
}

function buildPaneNode(node: PaneLayout): HTMLElement {
  if (node.type === 'leaf') {
    const frame = document.createElement('section');
    frame.className = `pane-leaf${node.sessionKey === activeSessionKey ? ' active' : ''}`;
    frame.dataset.sessionKey = node.sessionKey;
    const session = sessions.get(node.sessionKey);
    if (!session) return frame;
    session.view.classList.remove('inactive');
    frame.append(session.view);
    frame.addEventListener('pointerdown', () => {
      if (activeSessionKey !== session.key) activateSession(session.key);
    });
    return frame;
  }

  const split = document.createElement('div');
  split.className = `pane-split ${node.axis}`;
  applySplitTemplate(split, node.axis, node.ratio);
  split.append(buildPaneNode(node.first));
  const divider = document.createElement('button');
  divider.type = 'button';
  divider.className = 'pane-divider';
  divider.setAttribute('aria-label', node.axis === 'horizontal' ? '左右 pane のサイズを変更' : '上下 pane のサイズを変更');
  divider.addEventListener('pointerdown', (event) => startDividerDrag(event, split, node));
  split.append(divider, buildPaneNode(node.second));
  return split;
}

function applySplitTemplate(element: HTMLElement, axis: PaneAxis, ratio: number): void {
  const first = `${ratio}fr`;
  const second = `${1 - ratio}fr`;
  if (axis === 'horizontal') element.style.gridTemplateColumns = `${first} var(--pane-divider-size) ${second}`;
  else element.style.gridTemplateRows = `${first} var(--pane-divider-size) ${second}`;
}

function startDividerDrag(event: PointerEvent, element: HTMLElement, split: PaneSplit): void {
  event.preventDefault();
  event.stopPropagation();
  const rect = element.getBoundingClientRect();
  let ratio = split.ratio;
  element.classList.add('resizing');

  const move = (moveEvent: PointerEvent): void => {
    ratio = split.axis === 'horizontal'
      ? (moveEvent.clientX - rect.left) / rect.width
      : (moveEvent.clientY - rect.top) / rect.height;
    ratio = Math.min(0.85, Math.max(0.15, ratio));
    applySplitTemplate(element, split.axis, ratio);
    for (const key of paneSessions(split)) sessions.get(key)?.fit.fit();
  };
  const finish = (): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    paneLayout = setSplitRatio(paneLayout, split, ratio);
    renderPaneLayout();
    persistWorkspaces();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', finish, { once: true });
  window.addEventListener('pointercancel', finish, { once: true });
}

function openPanePicker(axis: PaneAxis): void {
  if (!activeSessionKey || !containsPaneSession(paneLayout, activeSessionKey)) return;
  pendingPaneSplit = { anchorSessionKey: activeSessionKey, axis };
  ui.panePickerTitle.textContent = axis === 'horizontal' ? '右に表示する session' : '下に表示する session';
  ui.panePickerList.replaceChildren();
  const visible = new Set(paneSessions(paneLayout));
  const candidates = [...sessions.values()].filter((session) => !visible.has(session.key));
  if (candidates.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'pane-picker-empty';
    empty.textContent = '非表示の既存 session はありません。新しい route を組み立てられます。';
    ui.panePickerList.append(empty);
  }
  for (const session of candidates) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pane-picker-item';
    const title = document.createElement('strong');
    title.textContent = session.title;
    const detail = document.createElement('small');
    detail.textContent = session.route.join(' → ');
    button.append(title, detail);
    button.addEventListener('click', () => completePaneSplit(session.key));
    ui.panePickerList.append(button);
  }
  ui.panePicker.classList.remove('hidden');
  window.requestAnimationFrame(() => (ui.panePickerList.querySelector('button') ?? ui.paneNewRoute).focus());
}

function closePanePicker(cancel = true): void {
  ui.panePicker.classList.add('hidden');
  if (cancel) pendingPaneSplit = null;
}

function completePaneSplit(sessionKey: string): void {
  const request = pendingPaneSplit;
  if (!request || !sessions.has(sessionKey)) return;
  paneLayout = splitPane(paneLayout, request.anchorSessionKey, sessionKey, request.axis);
  closePanePicker(false);
  pendingPaneSplit = null;
  activateSession(sessionKey);
  renderPaneLayout();
}

function beginNewRouteForPane(): void {
  if (!pendingPaneSplit) return;
  closePanePicker(false);
  route = [];
  renderRoute();
  showBuilder(false);
  toast('分割する新しい route を組み立て、CONNECT を押してください。');
}

function beginLocalTerminalForPane(): void {
  if (!pendingPaneSplit) return;
  closePanePicker(false);
  void openLocalTerminalDialog();
}

function movePaneFocus(direction: PaneDirection): void {
  if (!activeSessionKey) return;
  const next = focusPane(paneLayout, activeSessionKey, direction);
  if (next) activateSession(next);
}

function resizeActivePane(axis: PaneAxis, delta: number): void {
  if (!activeSessionKey) return;
  const resized = resizePane(paneLayout, activeSessionKey, axis, delta);
  if (resized === paneLayout) return;
  paneLayout = resized;
  renderPaneLayout();
  persistWorkspaces();
}

function closePane(sessionKey: string): void {
  if (!containsPaneSession(paneLayout, sessionKey)) return;
  paneLayout = removePaneSession(paneLayout, sessionKey);
  const next = paneSessions(paneLayout)[0];
  if (activeSessionKey === sessionKey) {
    if (next) activateSession(next);
    else showBuilder();
  }
  renderPaneLayout();
  renderTabs();
  persistWorkspaces();
}

function closeActivePane(): void {
  if (activeSessionKey) closePane(activeSessionKey);
}

function updateConnectionState(session: SessionUi): void {
  const labels = {
    idle: 'NOT CONNECTED',
    connecting: 'CONNECTING',
    connected: 'SSH CONNECTED',
    closed: 'DISCONNECTED',
  } as const;
  if (session.kind === 'local' && session.state === 'connected') {
    ui.connectionState.textContent = 'LOCAL PTY';
    ui.connectionState.style.color = 'var(--green)';
    return;
  }
  const colors = {
    idle: 'var(--muted)',
    connecting: 'var(--amber)',
    connected: 'var(--green)',
    closed: 'var(--red)',
  } as const;
  if (session.retryAt !== undefined) {
    ui.connectionState.textContent = 'RECONNECTING';
    ui.connectionState.style.color = 'var(--amber)';
    return;
  }
  ui.connectionState.textContent = labels[session.state];
  ui.connectionState.style.color = colors[session.state];
}

function renderTabs(): void {
  ui.tabs.replaceChildren();
  for (const session of sessions.values()) {
    const visible = containsPaneSession(paneLayout, session.key);
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `session-tab${session.key === activeSessionKey ? ' active' : ''}${visible ? ' visible' : ''}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(session.key === activeSessionKey));
    const dot = document.createElement('span');
    dot.className = `secure-dot ${session.retryAt !== undefined ? 'connecting' : session.state}`;
    const label = document.createElement('span');
    label.className = 'session-tab-label';
    label.textContent = session.title;
    tab.title = visible ? '表示中の pane へ focus' : '現在の pane にこの session を表示';
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
  clearRetryTimers(session);
  discardPendingInput(session);
  if (session.resizeTimer !== undefined) window.clearTimeout(session.resizeTimer);
  paneLayout = removePaneSession(paneLayout, key);
  session.terminal.dispose();
  session.view.remove();
  sessions.delete(key);
  if (activeSessionKey === key) {
    const next = paneSessions(paneLayout)[0] ?? [...sessions.keys()].at(-1);
    if (next) activateSession(next);
    else showBuilder();
  }
  renderPaneLayout();
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
  paneLayout = restorePaneLayout(workspaces.paneLayout, keys);
  if (paneLayout) renderPaneLayout();
  renderTabs();
  const restoredKey = activeTab >= 0 ? keys[activeTab] : paneSessions(paneLayout)[0];
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
    keybinding: formatKeySequence(keybindings[command.id], operatingSystem),
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
  clearPendingKeySequence();
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
  clearPendingKeySequence();
  closeCommandPalette();
  ui.shortcutEditor.classList.remove('hidden');
  ui.shortcutQuery.value = '';
  cancelShortcutRecording();
  ui.shortcutPlatform.textContent = operatingSystem === 'macos'
    ? 'macOS · Cmd'
    : `${operatingSystem === 'windows' ? 'Windows' : 'Linux'} · Ctrl`;
  renderShortcuts();
  window.requestAnimationFrame(() => ui.shortcutQuery.focus());
}

function closeShortcutEditor(): void {
  cancelShortcutRecording();
  ui.shortcutEditor.classList.add('hidden');
}

function renderShortcuts(): void {
  syncKeybindingLabels();
  const query = ui.shortcutQuery.value;
  const conflicts = findKeybindingConflicts(keybindings, commands);
  const conflictsByCommand = new Map<CommandId, CommandId[]>();
  for (const conflict of conflicts) {
    for (const commandId of conflict.commands) {
      conflictsByCommand.set(commandId, conflict.commands.filter((candidate) => candidate !== commandId));
    }
  }
  const visible = fuzzyFilter(query, commands, (command) =>
    `${command.category} ${command.label} ${command.id} ${keybindings[command.id]} ${command.when ?? ''}`,
  );
  ui.shortcutList.replaceChildren();
  for (const command of visible) {
    const row = document.createElement('div');
    const commandConflicts = conflictsByCommand.get(command.id) ?? [];
    row.className = `shortcut-row${commandConflicts.length > 0 ? ' conflict' : ''}`;
    const copy = document.createElement('span');
    copy.className = 'shortcut-command';
    const label = document.createElement('strong');
    label.textContent = command.label;
    const id = document.createElement('small');
    id.textContent = `${command.id}${command.when ? ` · when ${command.when}` : ''}`;
    copy.append(label, id);
    if (commandConflicts.length > 0) {
      const warning = document.createElement('small');
      warning.className = 'shortcut-conflict';
      warning.textContent = `競合: ${commandConflicts.join(', ')}`;
      copy.append(warning);
    }
    const capture = document.createElement('button');
    capture.type = 'button';
    capture.className = `shortcut-capture${recordingCommand === command.id ? ' recording' : ''}`;
    capture.textContent = recordingCommand === command.id
      ? recordingChords.length > 0
        ? `${formatKeySequence(recordingChords.join(' '), operatingSystem)} …`
        : 'キーを入力…'
      : formatKeySequence(keybindings[command.id], operatingSystem);
    capture.addEventListener('click', () => {
      cancelShortcutRecording();
      recordingCommand = command.id;
      recordingChords = [];
      renderShortcuts();
      capture.focus();
    });
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'shortcut-reset-one';
    reset.textContent = '↺';
    reset.title = '既定値に戻す';
    reset.disabled = keybindings[command.id] === defaultBindings[command.id];
    reset.addEventListener('click', () => {
      keybindings[command.id] = defaultBindings[command.id];
      saveKeybindings(keybindings, localStorage, operatingSystem);
      renderShortcuts();
    });
    row.append(copy, capture, reset);
    ui.shortcutList.append(row);
  }
}

function syncKeybindingLabels(): void {
  for (const node of document.querySelectorAll<HTMLElement>('[data-keybinding]')) {
    const id = node.dataset.keybinding as CommandId | undefined;
    if (id && id in keybindings) node.textContent = formatKeySequence(keybindings[id], operatingSystem);
  }
}

function commandContext(): CommandContext {
  return {
    terminalFocus: !ui.terminalStage.classList.contains('hidden'),
    routeFocus: !ui.builder.classList.contains('hidden'),
    paletteOpen: !ui.palette.classList.contains('hidden'),
    shortcutEditorOpen: !ui.shortcutEditor.classList.contains('hidden'),
  };
}

function runKeybinding(chord: string): boolean {
  const hadPrefix = pendingKeyChords.length > 0;
  pendingKeyChords.push(chord);
  let resolution = resolveKeybinding(pendingKeyChords, keybindings, commands, commandContext());
  if (resolution.status === 'none' && hadPrefix) {
    clearPendingKeySequence();
    pendingKeyChords = [chord];
    resolution = resolveKeybinding(pendingKeyChords, keybindings, commands, commandContext());
  }
  if (resolution.status === 'none') {
    clearPendingKeySequence();
    return false;
  }
  if (resolution.status === 'match') {
    clearPendingKeySequence();
    commands.find((command) => command.id === resolution.commandId)?.run();
    return true;
  }

  if (pendingKeyTimer !== undefined) window.clearTimeout(pendingKeyTimer);
  const exactCommandId = resolution.exactCommandId;
  pendingKeyTimer = window.setTimeout(() => {
    clearPendingKeySequence();
    if (exactCommandId) commands.find((command) => command.id === exactCommandId)?.run();
  }, KEY_SEQUENCE_TIMEOUT_MS);
  return true;
}

function clearPendingKeySequence(): void {
  if (pendingKeyTimer !== undefined) window.clearTimeout(pendingKeyTimer);
  pendingKeyTimer = undefined;
  pendingKeyChords = [];
}

function recordShortcutChord(chord: string): void {
  if (!recordingCommand) return;
  recordingChords.push(chord);
  if (recordingChords.length >= 4) {
    finishShortcutRecording();
    return;
  }
  if (recordingTimer !== undefined) window.clearTimeout(recordingTimer);
  recordingTimer = window.setTimeout(finishShortcutRecording, KEY_SEQUENCE_TIMEOUT_MS);
  renderShortcuts();
}

function finishShortcutRecording(): void {
  if (!recordingCommand || recordingChords.length === 0) {
    cancelShortcutRecording();
    renderShortcuts();
    return;
  }
  keybindings[recordingCommand] = recordingChords.join(' ');
  saveKeybindings(keybindings, localStorage, operatingSystem);
  cancelShortcutRecording();
  renderShortcuts();
}

function cancelShortcutRecording(): void {
  if (recordingTimer !== undefined) window.clearTimeout(recordingTimer);
  recordingTimer = undefined;
  recordingCommand = null;
  recordingChords = [];
}

function downloadShortcuts(): void {
  const blob = new Blob([exportKeybindings(keybindings, operatingSystem)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `ope-term-keybindings-${operatingSystem}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url));
}

async function importShortcuts(file: File): Promise<void> {
  const imported = importKeybindings(await file.text(), operatingSystem);
  keybindings = imported.bindings;
  saveKeybindings(keybindings, localStorage, operatingSystem);
  renderShortcuts();
  const migration = imported.migratedFrom
    ? ` ${imported.migratedFrom} の Ctrl/Cmd を ${operatingSystem} 向けに移行しました。`
    : '';
  toast(`Keyboard Shortcuts を読み込みました。${migration}`);
}

async function openLocalTerminalDialog(): Promise<void> {
  closeCommandPalette();
  try {
    localProfiles = await invoke<ShellProfile[]>('list_shell_profiles');
  } catch (error) {
    toast(`shell profile を取得できません: ${String(error)}`);
    return;
  }
  ui.localShellProfile.replaceChildren();
  for (const profile of localProfiles) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = `${profile.label}${profile.isDefault ? ' (default)' : ''} · ${profile.program}`;
    ui.localShellProfile.append(option);
  }
  selectedLocalDirectory = null;
  ui.localDirectoryLabel.textContent = 'default';
  ui.localDirectoryLabel.title = 'default';
  ui.localShellIntegration.checked = false;
  ui.localTerminalDialog.classList.remove('hidden');
  window.requestAnimationFrame(() => ui.localShellProfile.focus());
}

function closeLocalTerminalDialog(): void {
  ui.localTerminalDialog.classList.add('hidden');
}

async function pickLocalWorkingDirectory(): Promise<void> {
  const selected = await invoke<LocalDirectory | null>('pick_local_directory');
  if (!selected) return;
  selectedLocalDirectory = selected;
  ui.localDirectoryLabel.textContent = selected.displayPath;
  ui.localDirectoryLabel.title = selected.displayPath;
}

async function createLocalTerminal(): Promise<void> {
  const profile = localProfiles.find((candidate) => candidate.id === ui.localShellProfile.value);
  if (!profile) return;
  const session = createSession([], {
    profileId: profile.id,
    profileLabel: profile.label,
    workingDirectory: selectedLocalDirectory,
    shellIntegration: ui.localShellIntegration.checked,
    commandBoundaries: 0,
  });
  sessions.set(session.key, session);
  const split = pendingPaneSplit;
  pendingPaneSplit = null;
  if (split && containsPaneSession(paneLayout, split.anchorSessionKey)) {
    paneLayout = splitPane(paneLayout, split.anchorSessionKey, session.key, split.axis);
  }
  closeLocalTerminalDialog();
  activateSession(session.key);
  renderPaneLayout();
  await startSession(session);
}

ui.hostSearch.addEventListener('input', renderHosts);
ui.connect.addEventListener('click', () => void connectRoute());
ui.newRoute.addEventListener('click', () => showBuilder());
element<HTMLButtonElement>('split-right').addEventListener('click', () => openPanePicker('horizontal'));
element<HTMLButtonElement>('split-down').addEventListener('click', () => openPanePicker('vertical'));
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
  cancelShortcutRecording();
  keybindings = { ...defaultBindings };
  saveKeybindings(keybindings, localStorage, operatingSystem);
  renderShortcuts();
});
element<HTMLButtonElement>('export-shortcuts').addEventListener('click', downloadShortcuts);
element<HTMLButtonElement>('import-shortcuts').addEventListener('click', () => {
  cancelShortcutRecording();
  ui.shortcutImport.value = '';
  ui.shortcutImport.click();
});
ui.shortcutImport.addEventListener('change', () => {
  const file = ui.shortcutImport.files?.[0];
  if (!file) return;
  void importShortcuts(file).catch((error: unknown) => {
    toast(`Keyboard Shortcuts の読み込みに失敗しました: ${String(error)}`);
  });
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
ui.paneNewRoute.addEventListener('click', beginNewRouteForPane);
ui.paneNewLocal.addEventListener('click', beginLocalTerminalForPane);
ui.panePickerCancel.addEventListener('click', () => closePanePicker());
ui.panePicker.addEventListener('mousedown', (event) => {
  if (event.target === ui.panePicker) closePanePicker();
});
ui.localTerminalClose.addEventListener('click', closeLocalTerminalDialog);
ui.localTerminalCancel.addEventListener('click', closeLocalTerminalDialog);
ui.localTerminalOpen.addEventListener('click', () => void createLocalTerminal());
ui.localDirectoryPick.addEventListener('click', () => void pickLocalWorkingDirectory());
ui.localDirectoryClear.addEventListener('click', () => {
  selectedLocalDirectory = null;
  ui.localDirectoryLabel.textContent = 'default';
  ui.localDirectoryLabel.title = 'default';
});
ui.localTerminalDialog.addEventListener('mousedown', (event) => {
  if (event.target === ui.localTerminalDialog) closeLocalTerminalDialog();
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
    if (!ui.panePicker.classList.contains('hidden')) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePanePicker();
      }
      return;
    }
    if (!ui.localTerminalDialog.classList.contains('hidden')) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeLocalTerminalDialog();
      }
      return;
    }
    if (recordingCommand) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        cancelShortcutRecording();
      } else {
        const chord = eventToChord(event);
        if (chord) recordShortcutChord(chord);
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
  window.requestAnimationFrame(() => {
    for (const key of paneSessions(paneLayout)) sessions.get(key)?.fit.fit();
  });
});

async function boot(): Promise<void> {
  await performanceHarnessReady;
  syncKeybindingLabels();
  await loadHosts();
  void loadConfigPath();
  restoreTabs();
  performanceHarness?.markReady();
}

void boot();

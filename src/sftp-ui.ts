import { Channel, invoke } from '@tauri-apps/api/core';

import {
  LatestRequest,
  formatFileSize,
  joinBrowserPath,
  parentBrowserPath,
  transferPercent,
} from './sftp-paths';
import { IncrementalRenderer } from './incremental-render';
import {
  pruneCompletedTransfers,
  transferQueueHasCapacity,
  type TransferQueueStatus,
} from './transfer-queue';

interface SftpEntry {
  name: string;
  kind: 'directory' | 'file' | 'symlink' | 'other';
  size: number;
  permissions: string;
  modifiedUnix?: number;
}

interface LocalEntry {
  name: string;
  kind: 'directory' | 'file' | 'symlink' | 'other';
  size: number;
  modifiedUnix?: number;
}

interface Listing<T> {
  entries: T[];
}

interface LocalListing extends Listing<LocalEntry> {
  relativePath: string;
}

interface RemoteListing extends Listing<SftpEntry> {
  canonicalPath: string;
}

interface LocalScope {
  token: string;
  displayPath: string;
}

interface TransferProgress {
  transferId: string;
  status: TransferStatus;
  transferred: number;
  total: number;
}

type TransferDirection = 'upload' | 'download';
type TransferStatus = TransferQueueStatus;

interface TransferItem {
  id: string;
  connectionId: string;
  direction: TransferDirection;
  localToken: string;
  localRelativePath: string;
  remoteDirectory: string;
  remoteName: string;
  overwrite: boolean;
  followSymlink: boolean;
  status: TransferStatus;
  transferred: number;
  total: number;
  error?: string;
}

export interface SftpPanel {
  element: HTMLElement;
  toggle: () => void;
  close: () => void;
}

interface SftpPanelOptions {
  getConnectionId: () => string | null;
  onLayoutChange: () => void;
  notify: (message: string) => void;
}

function button(label: string, title = label): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.title = title;
  return node;
}

export function createSftpPanel(options: SftpPanelOptions): SftpPanel {
  const root = document.createElement('aside');
  root.className = 'sftp-panel';
  root.hidden = true;

  const header = document.createElement('header');
  const heading = document.createElement('div');
  const headingKicker = document.createElement('small');
  headingKicker.textContent = 'SFTP';
  const headingTitle = document.createElement('strong');
  headingTitle.textContent = 'FILE MANAGER';
  heading.append(headingKicker, headingTitle);
  const closeButton = button('×', 'SFTP を閉じる');
  closeButton.className = 'sftp-icon-button';
  header.append(heading, closeButton);

  const browsers = document.createElement('div');
  browsers.className = 'sftp-browsers';
  const localPane = document.createElement('section');
  const remotePane = document.createElement('section');
  localPane.className = 'sftp-browser';
  remotePane.className = 'sftp-browser';
  browsers.append(localPane, remotePane);

  const localToolbar = document.createElement('div');
  localToolbar.className = 'sftp-toolbar';
  const selectLocal = button('LOCAL', 'local directory を選択');
  const localUp = button('↑', '親 directory');
  const localRefresh = button('↻', '再読み込み');
  const localPath = document.createElement('code');
  localPath.textContent = '未選択';
  localToolbar.append(selectLocal, localUp, localRefresh, localPath);
  const localList = document.createElement('div');
  localList.className = 'sftp-list';
  localPane.append(localToolbar, localList);

  const remoteToolbar = document.createElement('div');
  remoteToolbar.className = 'sftp-toolbar';
  const remoteLabel = document.createElement('b');
  remoteLabel.textContent = 'REMOTE';
  const remoteUp = button('↑', '親 directory');
  const remoteRefresh = button('↻', '再読み込み');
  const remotePath = document.createElement('code');
  remotePath.textContent = '.';
  remoteToolbar.append(remoteLabel, remoteUp, remoteRefresh, remotePath);
  const remoteList = document.createElement('div');
  remoteList.className = 'sftp-list';
  remotePane.append(remoteToolbar, remoteList);

  const actions = document.createElement('div');
  actions.className = 'sftp-actions';
  const uploadButton = button('UPLOAD →');
  const downloadButton = button('← DOWNLOAD');
  uploadButton.disabled = true;
  downloadButton.disabled = true;
  actions.append(downloadButton, uploadButton);

  const queueSection = document.createElement('section');
  queueSection.className = 'sftp-queue';
  const queueHeader = document.createElement('header');
  const queueTitle = document.createElement('b');
  queueTitle.textContent = 'TRANSFER QUEUE';
  const queueCount = document.createElement('span');
  queueCount.textContent = '0';
  queueHeader.append(queueTitle, queueCount);
  const queueList = document.createElement('div');
  queueList.className = 'sftp-queue-list';
  queueSection.append(queueHeader, queueList);
  root.append(header, browsers, actions, queueSection);

  let scope: LocalScope | null = null;
  let localCurrent = '.';
  let remoteCurrent = '.';
  let localEntries: LocalEntry[] = [];
  let remoteEntries: SftpEntry[] = [];
  let selectedLocal: LocalEntry | null = null;
  let selectedRemote: SftpEntry | null = null;
  const queue: TransferItem[] = [];
  let processing = false;
  const localRequests = new LatestRequest();
  const remoteRequests = new LatestRequest();
  const localEntryRenderer = new IncrementalRenderer();
  const remoteEntryRenderer = new IncrementalRenderer();
  const ENTRY_RENDER_BATCH_SIZE = 250;

  function connectionId(): string | null {
    const id = options.getConnectionId();
    if (!id) options.notify('SFTP は接続済み session で開いてください。');
    return id;
  }

  function updateActions(): void {
    uploadButton.disabled = !scope || selectedLocal?.kind !== 'file';
    downloadButton.disabled = !scope || !selectedRemote || !['file', 'symlink'].includes(selectedRemote.kind);
  }

  function renderEntries<T extends LocalEntry | SftpEntry>(
    container: HTMLElement,
    entries: T[],
    selected: T | null,
    onSelect: (entry: T) => void,
    onOpen: (entry: T) => void,
    remote: boolean,
  ): void {
    const renderer = remote ? remoteEntryRenderer : localEntryRenderer;
    renderer.cancel();
    container.replaceChildren();
    container.removeAttribute('aria-busy');
    if (entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'sftp-empty';
      empty.textContent = 'empty';
      container.append(empty);
      return;
    }
    container.setAttribute('aria-busy', 'true');
    let selectedRow: HTMLButtonElement | undefined;
    renderer.render(
      entries.length,
      ENTRY_RENDER_BATCH_SIZE,
      (start, end) => {
        const fragment = document.createDocumentFragment();
        for (let index = start; index < end; index += 1) {
          const entry = entries[index];
          if (!entry) continue;
          const row = button('');
          row.className = `sftp-entry${selected?.name === entry.name ? ' selected' : ''}`;
          if (selected?.name === entry.name) selectedRow = row;
          const kind = document.createElement('span');
          kind.className = `sftp-kind ${entry.kind}`;
          kind.textContent = entry.kind === 'directory' ? 'DIR' : entry.kind === 'symlink' ? 'LNK' : 'FILE';
          const name = document.createElement('strong');
          name.textContent = entry.name;
          const detail = document.createElement('small');
          const permissions = remote ? (entry as SftpEntry).permissions : '';
          detail.textContent = `${permissions}${permissions ? '  ' : ''}${formatFileSize(entry.size)}`;
          row.append(kind, name, detail);
          row.addEventListener('click', () => {
            selectedRow?.classList.remove('selected');
            row.classList.add('selected');
            selectedRow = row;
            onSelect(entry);
          });
          row.addEventListener('dblclick', () => onOpen(entry));
          fragment.append(row);
        }
        container.append(fragment);
      },
      () => {
        container.removeAttribute('aria-busy');
      },
    );
  }

  function renderLocal(): void {
    localPath.textContent = scope ? `${scope.displayPath}${localCurrent === '.' ? '' : ` / ${localCurrent}`}` : '未選択';
    localPath.title = localPath.textContent;
    renderEntries(localList, localEntries, selectedLocal, (entry) => {
      selectedLocal = entry;
      updateActions();
    }, (entry) => {
      if (entry.kind === 'directory') void loadLocal(joinBrowserPath(localCurrent, entry.name));
    }, false);
  }

  function renderRemote(): void {
    remotePath.textContent = remoteCurrent;
    remotePath.title = remoteCurrent;
    renderEntries(remoteList, remoteEntries, selectedRemote, (entry) => {
      selectedRemote = entry;
      updateActions();
    }, (entry) => {
      if (entry.kind === 'directory') void loadRemote(joinBrowserPath(remoteCurrent, entry.name));
    }, true);
  }

  async function loadLocal(path = localCurrent): Promise<void> {
    if (!scope) return;
    const generation = localRequests.begin();
    const selectedScope = scope;
    try {
      const listing = await invoke<LocalListing>('local_list', { token: selectedScope.token, relativePath: path });
      if (!localRequests.isCurrent(generation) || scope?.token !== selectedScope.token) return;
      localCurrent = listing.relativePath;
      localEntries = listing.entries;
      selectedLocal = null;
      renderLocal();
      updateActions();
    } catch (error) {
      if (localRequests.isCurrent(generation) && scope?.token === selectedScope.token) {
        options.notify(`local 一覧を取得できません: ${String(error)}`);
      }
    }
  }

  async function loadRemote(path = remoteCurrent): Promise<void> {
    const id = connectionId();
    if (!id) return;
    const generation = remoteRequests.begin();
    try {
      const listing = await invoke<RemoteListing>('sftp_list', { sessionId: id, path });
      if (!remoteRequests.isCurrent(generation) || options.getConnectionId() !== id) return;
      remoteCurrent = listing.canonicalPath;
      remoteEntries = listing.entries;
      selectedRemote = null;
      renderRemote();
      updateActions();
    } catch (error) {
      if (remoteRequests.isCurrent(generation) && options.getConnectionId() === id) {
        options.notify(`remote 一覧を取得できません: ${String(error)}`);
      }
    }
  }

  function renderQueue(): void {
    queueCount.textContent = String(queue.length);
    queueList.replaceChildren();
    for (const item of queue) {
      const row = document.createElement('article');
      row.className = `sftp-transfer ${item.status}`;
      const summary = document.createElement('div');
      const direction = document.createElement('b');
      direction.textContent = item.direction === 'upload' ? 'UPLOAD →' : '← DOWNLOAD';
      const name = document.createElement('strong');
      name.textContent = item.remoteName;
      const state = document.createElement('small');
      const percent = transferPercent(item.transferred, item.total);
      state.textContent = item.status === 'running' ? `${percent}% · ${formatFileSize(item.transferred)}` : item.status;
      summary.append(direction, name, state);
      const action = item.status === 'running' ? button('CANCEL') : item.status === 'failed' || item.status === 'cancelled' ? button('RETRY') : null;
      if (action) {
        action.addEventListener('click', () => {
          if (item.status === 'running') {
            const id = options.getConnectionId();
            if (id === item.connectionId) {
              void invoke('sftp_cancel', { sessionId: id, transferId: item.id });
            }
          } else {
            const id = connectionId();
            if (!id) return;
            item.id = crypto.randomUUID();
            item.connectionId = id;
            item.status = 'queued';
            item.transferred = 0;
            item.total = 0;
            item.error = undefined;
            renderQueue();
            void processQueue();
          }
        });
      }
      row.append(summary);
      if (action) row.append(action);
      if (item.error) {
        const error = document.createElement('p');
        error.textContent = item.error;
        row.append(error);
      }
      queueList.append(row);
    }
  }

  let queueRenderPending = false;
  function scheduleQueueRender(): void {
    if (queueRenderPending) return;
    queueRenderPending = true;
    window.requestAnimationFrame(() => {
      queueRenderPending = false;
      renderQueue();
    });
  }

  async function processQueue(): Promise<void> {
    if (processing) return;
    const item = queue.find((candidate) => candidate.status === 'queued');
    if (!item) return;
    const id = options.getConnectionId();
    if (!id) {
      item.status = 'failed';
      item.error = '接続が終了したため転送を開始しませんでした。接続後に RETRY してください。';
      renderQueue();
      void processQueue();
      return;
    }
    if (id !== item.connectionId) {
      item.status = 'failed';
      item.error = '接続が変わったため転送を開始しませんでした。内容を確認して RETRY してください。';
      renderQueue();
      void processQueue();
      return;
    }
    processing = true;
    item.status = 'running';
    renderQueue();
    const progress = new Channel<TransferProgress>();
    progress.onmessage = (event) => {
      if (event.transferId !== item.id) return;
      item.status = event.status;
      item.transferred = event.transferred;
      item.total = event.total;
      scheduleQueueRender();
    };
    try {
      await invoke('sftp_transfer', {
        sessionId: id,
        request: {
          transferId: item.id,
          direction: item.direction,
          localToken: item.localToken,
          localRelativePath: item.localRelativePath,
          remoteDirectory: item.remoteDirectory,
          remoteName: item.remoteName,
          overwrite: item.overwrite,
          followSymlink: item.followSymlink,
        },
        onProgress: progress,
      });
      item.status = 'completed';
      await Promise.all([loadLocal(), loadRemote()]);
    } catch (error) {
      item.status = String(error).includes('キャンセル') ? 'cancelled' : 'failed';
      item.error = String(error);
    } finally {
      processing = false;
      pruneCompletedTransfers(queue);
      renderQueue();
      void processQueue();
    }
  }

  function enqueue(item: Omit<TransferItem, 'id' | 'connectionId' | 'status' | 'transferred' | 'total'>): void {
    const id = connectionId();
    if (!id) return;
    pruneCompletedTransfers(queue);
    if (!transferQueueHasCapacity(queue)) {
      options.notify('SFTP transfer queue は100件までです。失敗またはcancel済み項目を再試行してください。');
      return;
    }
    queue.push({ ...item, id: crypto.randomUUID(), connectionId: id, status: 'queued', transferred: 0, total: 0 });
    renderQueue();
    void processQueue();
  }

  selectLocal.addEventListener('click', async () => {
    selectLocal.disabled = true;
    try {
      const selected = await invoke<LocalScope | null>('pick_local_directory');
      if (!selected) return;
      scope = selected;
      localCurrent = '.';
      await loadLocal();
    } catch (error) {
      options.notify(`local directory を選択できません: ${String(error)}`);
    } finally {
      selectLocal.disabled = false;
    }
  });
  localUp.addEventListener('click', () => void loadLocal(parentBrowserPath(localCurrent, false)));
  localRefresh.addEventListener('click', () => void loadLocal());
  remoteUp.addEventListener('click', () => void loadRemote(parentBrowserPath(remoteCurrent, true)));
  remoteRefresh.addEventListener('click', () => void loadRemote());
  uploadButton.addEventListener('click', () => {
    if (!scope || selectedLocal?.kind !== 'file') return;
    const overwrite = remoteEntries.some((entry) => entry.name === selectedLocal!.name);
    if (overwrite && !window.confirm(`${selectedLocal.name} は remote に存在します。上書きしますか？`)) return;
    enqueue({
      direction: 'upload', localToken: scope.token,
      localRelativePath: joinBrowserPath(localCurrent, selectedLocal.name),
      remoteDirectory: remoteCurrent, remoteName: selectedLocal.name,
      overwrite, followSymlink: false,
    });
  });
  downloadButton.addEventListener('click', () => {
    if (!scope || !selectedRemote || !['file', 'symlink'].includes(selectedRemote.kind)) return;
    const overwrite = localEntries.some((entry) => entry.name === selectedRemote!.name);
    if (overwrite && !window.confirm(`${selectedRemote.name} は local に存在します。上書きしますか？`)) return;
    const followSymlink = selectedRemote.kind === 'symlink';
    if (followSymlink && !window.confirm('この symlink の実体を download しますか？')) return;
    enqueue({
      direction: 'download', localToken: scope.token,
      localRelativePath: joinBrowserPath(localCurrent, selectedRemote.name),
      remoteDirectory: remoteCurrent, remoteName: selectedRemote.name,
      overwrite, followSymlink,
    });
  });

  function close(): void {
    root.hidden = true;
    root.closest('.terminal-view')?.classList.remove('sftp-open');
    options.onLayoutChange();
  }
  function toggle(): void {
    if (!root.hidden) {
      close();
      return;
    }
    if (!connectionId()) return;
    root.hidden = false;
    root.closest('.terminal-view')?.classList.add('sftp-open');
    options.onLayoutChange();
    void loadRemote();
  }
  closeButton.addEventListener('click', close);
  renderLocal();
  renderRemote();
  renderQueue();
  return { element: root, toggle, close };
}

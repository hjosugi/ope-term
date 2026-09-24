import type { CloseReason, DisconnectCause } from './types';

export type SessionState = 'idle' | 'connecting' | 'connected' | 'closed';

/**
 * Reconnect policy for a session that lost its transport.
 *
 * Only an unexpected transport loss retries by itself. A local close is the
 * operator's decision, a remote close means the shell exited, and a failed
 * connection means authentication or host-key verification stopped us — none of
 * those get quieter by reconnecting.
 */
export const MAX_AUTO_RETRIES = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

export function shouldAutoRetry(
  reason: CloseReason,
  attempt: number,
  cause?: DisconnectCause,
  reconnecting = false,
): boolean {
  if (attempt > MAX_AUTO_RETRIES) return false;
  if (reason === 'transport') return true;
  // While already reconnecting, an attempt that could not reach the host yet
  // (the path is still down) keeps backing off. A first connection that fails,
  // or any config / host-key / authentication refusal, never retries by itself.
  return reconnecting && reason === 'failed' && (cause === 'timeout' || cause === 'network');
}

/** Rejects delayed events or terminal data from a replaced/closed backend. */
export function isCurrentConnection(current: string | null, incoming: string): boolean {
  return current === incoming;
}

/** Input typed outside an established shell must never be replayed after ready/reconnect. */
export function canQueueTerminalInput(connectionId: string | null, state: SessionState): boolean {
  return Boolean(connectionId) && state === 'connected';
}

/** Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s. */
export function retryDelayMs(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), MAX_DELAY_MS);
}

export function closeMessage(reason: CloseReason, cause?: DisconnectCause, hop?: string): string {
  const where = hop ? `（${hop}）` : '';
  switch (reason) {
    case 'local':
      return 'session closed';
    case 'remote':
      if (cause === 'server_disconnect') return `サーバーが SSH 接続を終了しました${where}`;
      return 'リモートがセッションを閉じました';
    case 'transport':
      if (cause === 'timeout') return `応答が途絶えたため切断しました（keepalive timeout）${where}`;
      if (cause === 'network') return `ネットワーク接続が切れました${where}`;
      return '接続が切断されました';
    case 'failed':
      return '接続を確立できませんでした';
  }
}

import type { CloseReason } from './types';

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

export function shouldAutoRetry(reason: CloseReason, attempt: number): boolean {
  return reason === 'transport' && attempt <= MAX_AUTO_RETRIES;
}

/** Rejects delayed events or terminal data from a replaced/closed backend. */
export function isCurrentConnection(current: string | null, incoming: string): boolean {
  return current === incoming;
}

/** Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s. */
export function retryDelayMs(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), MAX_DELAY_MS);
}

export function closeMessage(reason: CloseReason): string {
  switch (reason) {
    case 'local':
      return 'session closed';
    case 'remote':
      return 'リモートがセッションを閉じました';
    case 'transport':
      return '接続が切断されました';
    case 'failed':
      return '接続を確立できませんでした';
  }
}

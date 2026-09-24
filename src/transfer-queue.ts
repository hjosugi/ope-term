export type TransferQueueStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
/** Progress statuses from Rust; `conflict` flags an existing target and never becomes an item status. */
export type TransferProgressStatus = TransferQueueStatus | 'conflict';
export type TransferAction = 'cancel' | 'retry' | 'remove';

export const MAX_TRANSFER_QUEUE_ITEMS = 100;
export const MAX_COMPLETED_TRANSFER_HISTORY = 20;

export function pruneCompletedTransfers<T extends { status: TransferQueueStatus }>(items: T[]): number {
  let excess = items.filter((item) => item.status === 'completed').length - MAX_COMPLETED_TRANSFER_HISTORY;
  if (excess <= 0) return 0;
  let removed = 0;
  for (let index = 0; index < items.length && excess > 0;) {
    if (items[index]?.status === 'completed') {
      items.splice(index, 1);
      excess -= 1;
      removed += 1;
    } else {
      index += 1;
    }
  }
  return removed;
}

export function transferQueueHasCapacity(items: readonly unknown[]): boolean {
  return items.length < MAX_TRANSFER_QUEUE_ITEMS;
}

/** Buttons a queue row offers: a running transfer can only be cancelled, anything else can be dismissed. */
export function transferActions(status: TransferQueueStatus): TransferAction[] {
  switch (status) {
    case 'running':
      return ['cancel'];
    case 'failed':
    case 'cancelled':
      return ['retry', 'remove'];
    case 'queued':
    case 'completed':
      return ['remove'];
  }
}

/** Removes a transfer that is not running; a running one must be cancelled first. */
export function removeTransfer<T extends { id: string; status: TransferQueueStatus }>(items: T[], id: string): boolean {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0 || items[index]?.status === 'running') return false;
  items.splice(index, 1);
  return true;
}

/**
 * Classifies a rejected transfer from structured signals: the last progress
 * status from Rust or the operator's own cancel request, never error wording.
 */
export function settleFailedTransfer(lastProgress: TransferProgressStatus | undefined, cancelRequested: boolean): 'cancelled' | 'failed' {
  return cancelRequested || lastProgress === 'cancelled' ? 'cancelled' : 'failed';
}

/** A retry of a transfer rejected for an existing target must ask before overwriting. */
export function retryNeedsOverwriteConfirmation(item: { conflict?: boolean; overwrite: boolean }): boolean {
  return Boolean(item.conflict) && !item.overwrite;
}

export type TransferQueueStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';

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

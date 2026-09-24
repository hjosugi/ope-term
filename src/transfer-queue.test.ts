import { describe, expect, it } from 'vitest';

import {
  MAX_COMPLETED_TRANSFER_HISTORY,
  MAX_TRANSFER_QUEUE_ITEMS,
  pruneCompletedTransfers,
  removeTransfer,
  retryNeedsOverwriteConfirmation,
  settleFailedTransfer,
  transferActions,
  transferQueueHasCapacity,
  type TransferQueueStatus,
} from './transfer-queue';

interface Item {
  id: number;
  status: TransferQueueStatus;
}

describe('bounded transfer queue', () => {
  it('keeps active and actionable items while pruning the oldest completed history', () => {
    const items: Item[] = [
      { id: -2, status: 'failed' },
      { id: -1, status: 'cancelled' },
      ...Array.from({ length: MAX_COMPLETED_TRANSFER_HISTORY + 3 }, (_, id) => ({
        id,
        status: 'completed' as const,
      })),
      { id: 99, status: 'running' },
    ];

    expect(pruneCompletedTransfers(items)).toBe(3);
    expect(items.filter((item) => item.status === 'completed')).toHaveLength(MAX_COMPLETED_TRANSFER_HISTORY);
    expect(items.map((item) => item.id)).toEqual(expect.arrayContaining([-2, -1, 3, 99]));
  });

  it('rejects growth at the queue capacity', () => {
    expect(transferQueueHasCapacity(Array(MAX_TRANSFER_QUEUE_ITEMS - 1))).toBe(true);
    expect(transferQueueHasCapacity(Array(MAX_TRANSFER_QUEUE_ITEMS))).toBe(false);
  });

  it('offers cancel only while running and lets every other row be dismissed', () => {
    expect(transferActions('running')).toEqual(['cancel']);
    expect(transferActions('queued')).toEqual(['remove']);
    expect(transferActions('completed')).toEqual(['remove']);
    expect(transferActions('failed')).toEqual(['retry', 'remove']);
    expect(transferActions('cancelled')).toEqual(['retry', 'remove']);
  });

  it('removes queued and finished transfers but never a running one', () => {
    const items = [
      { id: 'a', status: 'queued' as TransferQueueStatus },
      { id: 'b', status: 'running' as TransferQueueStatus },
      { id: 'c', status: 'failed' as TransferQueueStatus },
    ];
    expect(removeTransfer(items, 'b')).toBe(false);
    expect(removeTransfer(items, 'missing')).toBe(false);
    expect(removeTransfer(items, 'a')).toBe(true);
    expect(removeTransfer(items, 'c')).toBe(true);
    expect(items.map((item) => item.id)).toEqual(['b']);
  });

  it('classifies a rejected transfer from structured signals only', () => {
    expect(settleFailedTransfer('cancelled', false)).toBe('cancelled');
    expect(settleFailedTransfer('running', true)).toBe('cancelled');
    expect(settleFailedTransfer('failed', false)).toBe('failed');
    expect(settleFailedTransfer('conflict', false)).toBe('failed');
    expect(settleFailedTransfer(undefined, false)).toBe('failed');
  });

  it('asks before retrying a transfer that hit an existing target', () => {
    expect(retryNeedsOverwriteConfirmation({ conflict: true, overwrite: false })).toBe(true);
    expect(retryNeedsOverwriteConfirmation({ conflict: true, overwrite: true })).toBe(false);
    expect(retryNeedsOverwriteConfirmation({ conflict: false, overwrite: false })).toBe(false);
    expect(retryNeedsOverwriteConfirmation({ overwrite: false })).toBe(false);
  });
});

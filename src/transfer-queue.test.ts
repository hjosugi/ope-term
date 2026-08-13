import { describe, expect, it } from 'vitest';

import {
  MAX_COMPLETED_TRANSFER_HISTORY,
  MAX_TRANSFER_QUEUE_ITEMS,
  pruneCompletedTransfers,
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
});

import { describe, expect, it } from 'vitest';
import {
  MAX_AUTO_RETRIES,
  closeMessage,
  isCurrentConnection,
  retryDelayMs,
  shouldAutoRetry,
} from './reconnect';

describe('reconnect policy', () => {
  it('retries only an unexpected transport loss', () => {
    expect(shouldAutoRetry('transport', 1)).toBe(true);
    expect(shouldAutoRetry('local', 1)).toBe(false);
    expect(shouldAutoRetry('remote', 1)).toBe(false);
    expect(shouldAutoRetry('failed', 1)).toBe(false);
  });

  it('stops after the attempt budget', () => {
    expect(shouldAutoRetry('transport', MAX_AUTO_RETRIES)).toBe(true);
    expect(shouldAutoRetry('transport', MAX_AUTO_RETRIES + 1)).toBe(false);
  });

  it('backs off exponentially and caps the delay', () => {
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(retryDelayMs(99)).toBe(30000);
    expect(retryDelayMs(0)).toBe(1000);
  });

  it('accepts only data from the current connection epoch', () => {
    expect(isCurrentConnection('new-id', 'new-id')).toBe(true);
    expect(isCurrentConnection('new-id', 'old-id')).toBe(false);
    expect(isCurrentConnection(null, 'closed-id')).toBe(false);
  });

  it('explains every close reason', () => {
    for (const reason of ['local', 'remote', 'transport', 'failed'] as const) {
      expect(closeMessage(reason)).not.toBe('');
    }
  });
});

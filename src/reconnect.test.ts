import { describe, expect, it } from 'vitest';
import {
  MAX_AUTO_RETRIES,
  canQueueTerminalInput,
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

  it('queues terminal input only for an established shell', () => {
    expect(canQueueTerminalInput('connection', 'connected')).toBe(true);
    expect(canQueueTerminalInput('connection', 'connecting')).toBe(false);
    expect(canQueueTerminalInput('connection', 'closed')).toBe(false);
    expect(canQueueTerminalInput(null, 'connected')).toBe(false);
  });

  it('explains every close reason', () => {
    for (const reason of ['local', 'remote', 'transport', 'failed'] as const) {
      expect(closeMessage(reason)).not.toBe('');
    }
  });

  it('names the cause and the hop of a lost connection', () => {
    expect(closeMessage('transport', 'timeout', 'bastion')).toContain('keepalive timeout');
    expect(closeMessage('transport', 'timeout', 'bastion')).toContain('bastion');
    expect(closeMessage('transport', 'network', 'db')).toContain('ネットワーク');
    expect(closeMessage('remote', 'server_disconnect', 'db')).toContain('サーバー');
    expect(closeMessage('remote', 'shell_exit', 'db')).toBe(closeMessage('remote'));
    expect(closeMessage('transport')).toBe('接続が切断されました');
  });

  it('never retries a server that ended the connection on purpose', () => {
    // The backend reports SSH_MSG_DISCONNECT as a remote close.
    expect(shouldAutoRetry('remote', 1)).toBe(false);
  });

  it('keeps backing off while the path is still down during a reconnect', () => {
    expect(shouldAutoRetry('failed', 2, 'network', true)).toBe(true);
    expect(shouldAutoRetry('failed', 3, 'timeout', true)).toBe(true);
    expect(shouldAutoRetry('failed', MAX_AUTO_RETRIES + 1, 'network', true)).toBe(false);
    // A first connection that fails is the operator's to retry.
    expect(shouldAutoRetry('failed', 1, 'network', false)).toBe(false);
    // Authentication / host-key / config refusals carry no transport cause.
    expect(shouldAutoRetry('failed', 2, undefined, true)).toBe(false);
    expect(shouldAutoRetry('remote', 2, 'server_disconnect', true)).toBe(false);
  });
});

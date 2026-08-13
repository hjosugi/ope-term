import { describe, expect, it } from 'vitest';

import {
  LatestRequest,
  formatFileSize,
  joinBrowserPath,
  parentBrowserPath,
  transferPercent,
} from './sftp-paths';

describe('SFTP browser paths and progress', () => {
  it('joins relative and rooted paths without duplicate separators', () => {
    expect(joinBrowserPath('.', 'child')).toBe('child');
    expect(joinBrowserPath('/', 'child')).toBe('/child');
    expect(joinBrowserPath('one/two/', 'child')).toBe('one/two/child');
  });

  it('does not navigate above local or remote roots', () => {
    expect(parentBrowserPath('.', false)).toBe('.');
    expect(parentBrowserPath('one', false)).toBe('.');
    expect(parentBrowserPath('one\\two', false)).toBe('one');
    expect(parentBrowserPath('/', true)).toBe('/');
    expect(parentBrowserPath('/one', true)).toBe('/');
    expect(parentBrowserPath('/one/two', true)).toBe('/one');
  });

  it('formats invalid sizes safely and clamps progress', () => {
    expect(formatFileSize(Number.NaN)).toBe('0 B');
    expect(formatFileSize(1536)).toBe('1.5 KiB');
    expect(transferPercent(120, 100)).toBe(100);
    expect(transferPercent(-1, 100)).toBe(0);
    expect(transferPercent(1, 0)).toBe(0);
  });

  it('identifies responses from only the newest directory request', () => {
    const requests = new LatestRequest();
    const first = requests.begin();
    const second = requests.begin();
    expect(requests.isCurrent(first)).toBe(false);
    expect(requests.isCurrent(second)).toBe(true);
  });
});

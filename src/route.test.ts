import { describe, expect, it } from 'vitest';
import { appendUnique, moveRouteItem, routePreview } from './route';
import type { HostProfile } from './types';

const hosts: HostProfile[] = [
  { alias: 'prod', hostname: '10.0.0.8', port: 22, proxyJump: 'bastion', chain: ['bastion', 'prod'] },
];

describe('route helpers', () => {
  it('previews the OpenSSH chain for a single target', () => {
    expect(routePreview(['prod'], hosts)).toEqual(['bastion', 'prod']);
  });
  it('keeps an explicit puzzle route unchanged', () => {
    expect(routePreview(['jump-a', 'prod'], hosts)).toEqual(['jump-a', 'prod']);
  });
  it('moves and deduplicates route pieces', () => {
    expect(moveRouteItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(appendUnique(['a'], 'a')).toEqual(['a']);
  });
});

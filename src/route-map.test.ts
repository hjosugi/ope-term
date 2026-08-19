import { describe, expect, it } from 'vitest';
import { MAX_MAP_HOSTS, buildRouteMap, columnLabel, edgeKey, highlightPath, nodeCount } from './route-map';
import type { HostProfile } from './types';

function host(alias: string, chain: string[], extra: Partial<HostProfile> = {}): HostProfile {
  return { alias, hostname: `${alias}.example.com`, port: 22, chain, ...extra };
}

const config: HostProfile[] = [
  host('bastion', ['bastion'], { user: 'operator' }),
  host('dmz', ['dmz']),
  host('prod-db', ['bastion', 'prod-db'], { user: 'admin', hostname: '10.20.0.15' }),
  host('prod-app', ['bastion', 'prod-db', 'prod-app']),
  host('stage-web', ['dmz', 'stage-web']),
];

describe('route map layout', () => {
  it('puts every host at its jump depth', () => {
    const map = buildRouteMap(config);
    expect(map.columns.map((column) => column.depth)).toEqual([0, 1, 2]);
    expect(map.columns[0]?.nodes.map((node) => node.alias)).toEqual(['bastion', 'dmz']);
    expect(map.columns[1]?.nodes.map((node) => node.alias)).toEqual(['prod-db', 'stage-web']);
    expect(map.columns[2]?.nodes.map((node) => node.alias)).toEqual(['prod-app']);
  });

  it('links each hop to the next one exactly once', () => {
    const map = buildRouteMap(config);
    expect(map.edges).toEqual([
      { from: 'bastion', to: 'prod-db' },
      { from: 'prod-db', to: 'prod-app' },
      { from: 'dmz', to: 'stage-web' },
    ]);
  });

  it('marks the hosts other routes jump through', () => {
    const map = buildRouteMap(config);
    const jumps = map.columns.flatMap((column) => column.nodes.filter((node) => node.isJump));
    expect(jumps.map((node) => node.alias)).toEqual(['bastion', 'dmz', 'prod-db']);
  });

  it('shows the endpoint an alias resolves to', () => {
    const map = buildRouteMap(config);
    expect(map.columns[1]?.nodes[0]?.address).toBe('admin@10.20.0.15:22');
    expect(map.columns[0]?.nodes[0]?.address).toBe('operator@bastion.example.com:22');
  });

  it('keeps a jump that has no Host block of its own', () => {
    const map = buildRouteMap([host('prod', ['edge-gw', 'prod'])]);
    const edge = map.columns[0]?.nodes[0];
    expect(edge).toMatchObject({ alias: 'edge-gw', depth: 0, external: true, isJump: true, address: '' });
    expect(map.columns[1]?.nodes[0]?.external).toBe(false);
  });

  it('treats a host without a resolved chain as a direct connection', () => {
    const map = buildRouteMap([host('solo', [])]);
    expect(map.columns).toEqual([
      { depth: 0, nodes: [expect.objectContaining({ alias: 'solo', chain: ['solo'] })] },
    ]);
    expect(map.edges).toEqual([]);
  });

  it('bounds the rendered host count and reports the remainder', () => {
    const many = Array.from({ length: MAX_MAP_HOSTS + 5 }, (_, index) => host(`host-${index}`, [`host-${index}`]));
    const map = buildRouteMap(many);
    expect(nodeCount(map)).toBe(MAX_MAP_HOSTS);
    expect(map.truncated).toBe(5);
  });
});

describe('route map highlight', () => {
  it('lights the whole chain that reaches a host', () => {
    const map = buildRouteMap(config);
    const highlight = highlightPath(map, 'prod-app');
    expect([...highlight.nodes].sort()).toEqual(['bastion', 'prod-app', 'prod-db']);
    expect([...highlight.edges].sort()).toEqual([edgeKey('bastion', 'prod-db'), edgeKey('prod-db', 'prod-app')].sort());
  });

  it('lights a direct host without any edge', () => {
    const map = buildRouteMap(config);
    const highlight = highlightPath(map, 'bastion');
    expect([...highlight.nodes]).toEqual(['bastion']);
    expect(highlight.edges.size).toBe(0);
  });

  it('returns nothing for an alias outside the map', () => {
    const highlight = highlightPath(buildRouteMap(config), 'unknown');
    expect(highlight.nodes.size).toBe(0);
    expect(highlight.edges.size).toBe(0);
  });

  it('names the columns by hop depth', () => {
    expect(columnLabel(0)).toBe('直結');
    expect(columnLabel(2)).toBe('2 段目');
  });
});

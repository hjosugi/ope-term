import type { HostProfile } from './types';

/**
 * A hop-depth map of `~/.ssh/config`.
 *
 * Column 0 holds the hosts ope-term dials directly. Column N holds the hosts that
 * OpenSSH reaches through N jumps, so a bastion always sits left of everything it
 * carries. Nodes keep the resolved chain, which is what the UI highlights when the
 * operator points at a host.
 */
export interface RouteMapNode {
  alias: string;
  depth: number;
  /** Resolved hops from the first jump to this alias, inclusive. */
  chain: string[];
  /** `user@hostname:port`, empty when the alias is only referenced as a jump. */
  address: string;
  /** Another host reaches its target through this alias. */
  isJump: boolean;
  /** Referenced by ProxyJump but absent from the Host list (wildcard or missing block). */
  external: boolean;
}

export interface RouteMapEdge {
  from: string;
  to: string;
}

export interface RouteMapColumn {
  depth: number;
  nodes: RouteMapNode[];
}

export interface RouteMap {
  columns: RouteMapColumn[];
  edges: RouteMapEdge[];
  /** Hosts left out of the map because the config is larger than the render budget. */
  truncated: number;
}

/** Keeps a huge config from producing an unreadable map and a heavy DOM. */
export const MAX_MAP_HOSTS = 200;

export function buildRouteMap(hosts: readonly HostProfile[], limit = MAX_MAP_HOSTS): RouteMap {
  const profiles = new Map(hosts.map((host) => [host.alias, host]));
  const nodes = new Map<string, RouteMapNode>();
  const edges: RouteMapEdge[] = [];
  const edgeKeys = new Set<string>();
  const jumps = new Set<string>();
  const visible = hosts.slice(0, Math.max(0, limit));

  for (const host of visible) {
    const chain = host.chain.length > 0 ? host.chain : [host.alias];
    chain.forEach((alias, index) => {
      registerNode(nodes, profiles, alias, index, chain);
      if (index === 0) return;
      const from = chain[index - 1];
      if (!from || from === alias) return;
      jumps.add(from);
      const key = edgeKey(from, alias);
      if (edgeKeys.has(key)) return;
      edgeKeys.add(key);
      edges.push({ from, to: alias });
    });
  }

  for (const alias of jumps) {
    const node = nodes.get(alias);
    if (node) node.isJump = true;
  }

  const byDepth = new Map<number, RouteMapNode[]>();
  for (const node of nodes.values()) {
    const column = byDepth.get(node.depth);
    if (column) column.push(node);
    else byDepth.set(node.depth, [node]);
  }
  const columns = [...byDepth.entries()]
    .sort(([left], [right]) => left - right)
    .map(([depth, columnNodes]) => ({ depth, nodes: columnNodes }));

  return { columns, edges, truncated: Math.max(0, hosts.length - visible.length) };
}

function registerNode(
  nodes: Map<string, RouteMapNode>,
  profiles: ReadonlyMap<string, HostProfile>,
  alias: string,
  index: number,
  chain: readonly string[],
): void {
  const profile = profiles.get(alias);
  const existing = nodes.get(alias);
  if (existing) {
    // A jump-only alias can appear at several positions; keep the shallowest.
    if (!profile && index < existing.depth) {
      existing.depth = index;
      existing.chain = chain.slice(0, index + 1);
    }
    return;
  }
  nodes.set(alias, {
    alias,
    depth: profile ? Math.max(0, (profile.chain.length || 1) - 1) : index,
    chain: profile?.chain.length ? [...profile.chain] : chain.slice(0, index + 1),
    address: profile ? `${profile.user ? `${profile.user}@` : ''}${profile.hostname}:${profile.port}` : '',
    isJump: false,
    external: !profile,
  });
}

export function edgeKey(from: string, to: string): string {
  return `${from} ${to}`;
}

export interface RouteMapHighlight {
  nodes: Set<string>;
  edges: Set<string>;
}

/** The full path OpenSSH would take to reach `alias`, for the hover highlight. */
export function highlightPath(map: RouteMap, alias: string): RouteMapHighlight {
  const highlight: RouteMapHighlight = { nodes: new Set(), edges: new Set() };
  const node = findNode(map, alias);
  if (!node) return highlight;
  const chain = node.chain.length > 0 ? node.chain : [node.alias];
  chain.forEach((hop, index) => {
    highlight.nodes.add(hop);
    const previous = chain[index - 1];
    if (previous && previous !== hop) highlight.edges.add(edgeKey(previous, hop));
  });
  highlight.nodes.add(alias);
  return highlight;
}

export function findNode(map: RouteMap, alias: string): RouteMapNode | undefined {
  for (const column of map.columns) {
    const node = column.nodes.find((candidate) => candidate.alias === alias);
    if (node) return node;
  }
  return undefined;
}

export function columnLabel(depth: number): string {
  return depth === 0 ? '直結' : `${depth} 段目`;
}

export function nodeCount(map: RouteMap): number {
  return map.columns.reduce((total, column) => total + column.nodes.length, 0);
}

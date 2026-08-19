import {
  buildRouteMap,
  columnLabel,
  edgeKey,
  highlightPath,
  nodeCount,
  type RouteMap,
  type RouteMapNode,
} from './route-map';
import type { HostProfile } from './types';

export interface RouteMapUiElements {
  canvas: HTMLElement;
  count: HTMLElement;
}

export interface RouteMapUiOptions {
  elements: RouteMapUiElements;
  /** Loads the alias into the route workbench. */
  onSelect: (alias: string) => void;
  /** Reports whether a session is currently open on the alias. */
  isLive: (alias: string) => boolean;
}

export interface RouteMapUi {
  render(hosts: readonly HostProfile[], routeSelection: readonly string[]): void;
  dispose(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function createRouteMapUi(options: RouteMapUiOptions): RouteMapUi {
  const { canvas, count } = options.elements;
  const nodeElements = new Map<string, HTMLElement>();
  const edgeElements = new Map<string, SVGPathElement>();
  let map: RouteMap = { columns: [], edges: [], truncated: 0 };
  let selection: readonly string[] = [];
  let links: SVGSVGElement | null = null;
  let frame = 0;

  const observer = new ResizeObserver(() => scheduleDraw());
  observer.observe(canvas);

  function scheduleDraw(): void {
    if (frame !== 0) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      drawLinks();
      applyHighlight(selection);
    });
  }

  function render(hosts: readonly HostProfile[], routeSelection: readonly string[]): void {
    map = buildRouteMap(hosts);
    selection = [...routeSelection];
    nodeElements.clear();
    edgeElements.clear();
    canvas.replaceChildren();
    count.textContent = `${nodeCount(map)} hosts`;

    if (map.columns.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'route-map-empty';
      empty.textContent = 'Host がありません。~/.ssh/config に Host を追加すると経路が描かれます。';
      canvas.append(empty);
      links = null;
      return;
    }

    links = document.createElementNS(SVG_NS, 'svg');
    links.setAttribute('class', 'route-map-links');
    links.setAttribute('aria-hidden', 'true');
    const columns = document.createElement('div');
    columns.className = 'route-map-columns';

    for (const column of map.columns) {
      const group = document.createElement('div');
      group.className = 'route-map-column';
      const head = document.createElement('div');
      head.className = 'route-map-column-head';
      const label = document.createElement('span');
      label.textContent = columnLabel(column.depth);
      const size = document.createElement('span');
      size.className = 'route-map-column-count';
      size.textContent = String(column.nodes.length);
      head.append(label, size);
      group.append(head);
      for (const node of column.nodes) group.append(createNode(node));
      columns.append(group);
    }

    canvas.append(links, columns);

    if (map.truncated > 0) {
      const note = document.createElement('p');
      note.className = 'route-map-empty';
      note.textContent = `他 ${map.truncated} 件の Host は経路図から省略しました。`;
      canvas.append(note);
    }

    for (const edge of map.edges) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('class', 'route-map-link');
      links.append(path);
      edgeElements.set(edgeKey(edge.from, edge.to), path);
    }

    scheduleDraw();
  }

  function createNode(node: RouteMapNode): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'route-map-node';
    if (node.external) button.classList.add('external');
    button.dataset.alias = node.alias;
    button.title = `${node.chain.join(' → ')} をルートへ読み込む`;

    const alias = document.createElement('span');
    alias.className = 'route-map-alias';
    alias.textContent = node.alias;
    const address = document.createElement('span');
    address.className = 'route-map-address';
    address.textContent = node.address || 'ProxyJump 参照のみ';
    const badges = document.createElement('span');
    badges.className = 'route-map-badges';
    if (node.isJump) badges.append(createBadge('JUMP', 'jump'));
    if (options.isLive(node.alias)) badges.append(createBadge('LIVE', 'live'));
    button.append(alias, address, badges);

    button.addEventListener('click', () => options.onSelect(node.alias));
    button.addEventListener('pointerenter', () => applyHighlight([node.alias]));
    button.addEventListener('focus', () => applyHighlight([node.alias]));
    button.addEventListener('pointerleave', () => applyHighlight(selection));
    button.addEventListener('blur', () => applyHighlight(selection));

    nodeElements.set(node.alias, button);
    return button;
  }

  function createBadge(text: string, kind: string): HTMLElement {
    const badge = document.createElement('span');
    badge.className = `route-map-badge ${kind}`;
    badge.textContent = text;
    return badge;
  }

  function drawLinks(): void {
    if (!links) return;
    const canvasRect = canvas.getBoundingClientRect();
    links.setAttribute('width', String(canvas.scrollWidth));
    links.setAttribute('height', String(canvas.scrollHeight));
    links.setAttribute('viewBox', `0 0 ${canvas.scrollWidth} ${canvas.scrollHeight}`);

    for (const edge of map.edges) {
      const path = edgeElements.get(edgeKey(edge.from, edge.to));
      const from = nodeElements.get(edge.from);
      const to = nodeElements.get(edge.to);
      if (!path || !from || !to) continue;
      const start = anchor(from, canvasRect, 'right');
      const end = anchor(to, canvasRect, 'left');
      const bend = Math.max((end.x - start.x) / 2, 0);
      path.setAttribute(
        'd',
        `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`,
      );
    }
  }

  function anchor(element: HTMLElement, canvasRect: DOMRect, side: 'left' | 'right'): { x: number; y: number } {
    const rect = element.getBoundingClientRect();
    const x = (side === 'right' ? rect.right : rect.left) - canvasRect.left + canvas.scrollLeft;
    const y = rect.top + rect.height / 2 - canvasRect.top + canvas.scrollTop;
    return { x, y };
  }

  function applyHighlight(aliases: readonly string[]): void {
    const nodes = new Set<string>();
    const edges = new Set<string>();
    for (const alias of aliases) {
      const highlight = highlightPath(map, alias);
      for (const node of highlight.nodes) nodes.add(node);
      for (const edge of highlight.edges) edges.add(edge);
    }

    for (const [alias, element] of nodeElements) {
      element.classList.toggle('active', nodes.has(alias));
    }
    for (const [key, path] of edgeElements) {
      const active = edges.has(key);
      path.classList.toggle('active', active);
      // SVG paints in document order, so an active link has to move on top.
      if (active) links?.append(path);
    }
  }

  function dispose(): void {
    observer.disconnect();
    if (frame !== 0) window.cancelAnimationFrame(frame);
    frame = 0;
  }

  return { render, dispose };
}

import type { HostProfile } from './types';

export function routePreview(route: string[], hosts: HostProfile[]): string[] {
  if (route.length !== 1) return [...route];
  const selected = hosts.find((host) => host.alias === route[0]);
  return selected?.chain.length ? [...selected.chain] : [...route];
}

export function moveRouteItem(route: string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= route.length || to >= route.length) {
    return [...route];
  }
  const next = [...route];
  const [item] = next.splice(from, 1);
  if (item === undefined) return [...route];
  next.splice(to, 0, item);
  return next;
}

export function appendUnique(route: string[], alias: string): string[] {
  return route.includes(alias) ? route : [...route, alias];
}

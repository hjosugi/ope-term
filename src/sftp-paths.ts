export function joinBrowserPath(parent: string, name: string, separator = '/'): string {
  if (parent === '.' || parent === '') return name;
  return `${parent.replace(/[\\/]$/u, '')}${separator}${name}`;
}

export function parentBrowserPath(path: string, remote: boolean): string {
  if (remote && path === '/') return '/';
  const separator = remote ? '/' : path.includes('\\') ? '\\' : '/';
  const parts = path.split(/[\\/]/u).filter(Boolean);
  parts.pop();
  if (remote && path.startsWith('/')) return `/${parts.join('/')}` || '/';
  return parts.join(separator) || '.';
}

export function formatFileSize(value: number): string {
  const bytes = Number.isFinite(value) && value > 0 ? value : 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export function transferPercent(transferred: number, total: number): number {
  if (!Number.isFinite(transferred) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.floor((transferred / total) * 100)));
}

export class LatestRequest {
  private generation = 0;

  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }
}

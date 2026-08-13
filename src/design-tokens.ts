type CssTokenSource = Pick<CSSStyleDeclaration, 'getPropertyValue'>;

export function cssTextToken(source: CssTokenSource, name: `--${string}`, fallback: string): string {
  return source.getPropertyValue(name).trim() || fallback;
}

export function cssNumberToken(
  source: CssTokenSource,
  name: `--${string}`,
  fallback: number,
): number {
  const parsed = Number.parseFloat(source.getPropertyValue(name));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

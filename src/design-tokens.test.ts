import { describe, expect, it } from 'vitest';
import { cssNumberToken, cssTextToken } from './design-tokens';

function tokens(values: Record<string, string>): Pick<CSSStyleDeclaration, 'getPropertyValue'> {
  return { getPropertyValue: (name) => values[name] ?? '' };
}

describe('CSS tokens consumed by JavaScript widgets', () => {
  it('reads CSS dimensions and unitless values as positive numbers', () => {
    const source = tokens({ '--font-size': ' 13px ', '--line-height': '1.16' });
    expect(cssNumberToken(source, '--font-size', 12)).toBe(13);
    expect(cssNumberToken(source, '--line-height', 1)).toBe(1.16);
  });

  it('falls back for absent, invalid, or non-positive values', () => {
    const source = tokens({ '--invalid': 'large', '--zero': '0' });
    expect(cssNumberToken(source, '--missing', 13)).toBe(13);
    expect(cssNumberToken(source, '--invalid', 13)).toBe(13);
    expect(cssNumberToken(source, '--zero', 13)).toBe(13);
  });

  it('trims text tokens and preserves a fallback', () => {
    const source = tokens({ '--mono': ' ui-monospace, monospace ' });
    expect(cssTextToken(source, '--mono', 'monospace')).toBe('ui-monospace, monospace');
    expect(cssTextToken(source, '--missing', 'monospace')).toBe('monospace');
  });
});

import { describe, expect, it } from 'vitest';
import css from './style.css?inline';

const appCss = css.slice(css.indexOf('/* 4 px spacing scale.'));

describe('UI size tokens', () => {
  it('defines the shared spacing, type, control, and layout scales', () => {
    for (let step = 1; step <= 10; step += 1) {
      expect(appCss).toContain(`--space-${step}:`);
    }

    for (const token of [
      '--font-2xs:',
      '--font-xs:',
      '--font-sm:',
      '--font-md:',
      '--font-lg:',
      '--control-sm:',
      '--control-md:',
      '--control-lg:',
      '--rail-width:',
      '--dialog-gutter:',
    ]) {
      expect(appCss).toContain(token);
    }
  });

  it('keeps raw pixel values in token definitions or the responsive breakpoint', () => {
    const componentCss = appCss
      .replace(/^\s*--[\w-]+:\s*[^;]+;/gm, '')
      .replace('@media (max-width: 850px)', '@media (max-width: compact)');

    expect(componentCss).not.toMatch(/(?<![\w-])\d+(?:\.\d+)?px/);
  });
});

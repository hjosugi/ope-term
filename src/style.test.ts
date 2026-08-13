import { describe, expect, it } from 'vitest';
import mainSource from './main.ts?raw';
import sftpSource from './sftp-ui.ts?raw';
import css from './style.css?inline';

const appCss = css.slice(css.indexOf('/* 4 px spacing scale.'));
const appRootCss = css.slice(css.indexOf(':root {'));

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
      '--tracking-micro:',
      '--tracking-label:',
      '--tracking-wide:',
      '--terminal-font-size:',
      '--terminal-line-height:',
      '--control-sm:',
      '--control-md:',
      '--control-lg:',
      '--rail-width:',
      '--dialog-gutter:',
      '--file-panel-min:',
      '--file-panel-preferred:',
      '--file-queue-min:',
    ]) {
      expect(appCss).toContain(token);
    }
  });

  it('keeps raw fixed lengths and tracking in token definitions or the responsive breakpoint', () => {
    const componentCss = appCss
      .replace(/^\s*--[\w-]+:\s*[^;]+;/gm, '')
      .replace('@media (max-width: 850px)', '@media (max-width: compact)');

    expect(componentCss).not.toMatch(/(?<![\w-])\d+(?:\.\d+)?(?:px|rem|em)/);
    expect(`${mainSource}\n${sftpSource}`).not.toMatch(/\d+(?:\.\d+)?(?:px|rem)/);
  });

  it('defines every referenced token exactly once', () => {
    const definitions = [...appRootCss.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((match) => match[1]);
    expect(new Set(definitions).size).toBe(definitions.length);

    const defined = new Set(definitions);
    const references = [...appRootCss.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]);
    expect([...new Set(references)].filter((token) => !defined.has(token))).toEqual([]);
  });

  it('keeps shared buttons on the control scale with a visible keyboard focus', () => {
    expect(appCss).toMatch(/button\s*\{[^}]*min-height:\s*var\(--control-sm\)/s);
    expect(appCss).toMatch(/\.rail-reload\s*\{[^}]*min-height:\s*var\(--control-sm\)/s);
    expect(appCss).toMatch(/\.icon-button\s*\{[^}]*min-height:\s*var\(--control-md\)/s);
    expect(appCss).toMatch(/\.secondary-button,\s*\.primary-button\s*\{[^}]*min-height:\s*var\(--control-md\)/s);
    expect(appCss).toMatch(/button:focus-visible[^}]*outline:\s*var\(--focus-ring-width\) solid var\(--amber\)/s);
  });
});

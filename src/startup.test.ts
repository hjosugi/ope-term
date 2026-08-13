import { describe, expect, it } from 'vitest';

import mainSource from './main.ts?raw';

describe('startup degradation policy', () => {
  it('keeps optional performance instrumentation and boot failures observable', () => {
    const performanceImport = mainSource.slice(
      mainSource.indexOf("import('./performance')"),
      mainSource.indexOf('const commands:'),
    );

    expect(performanceImport).toContain('.catch(');
    expect(performanceImport).toContain('通常modeで続行します');
    expect(mainSource).toMatch(/void boot\(\)\.catch\(/);
  });
});

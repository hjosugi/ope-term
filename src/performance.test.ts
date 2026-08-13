import { describe, expect, it } from 'vitest';
import { evaluatePerformance, loadRendererPreference, percentile, type PerformanceReport } from './performance';

function report(overrides: Partial<PerformanceReport> = {}): PerformanceReport {
  return {
    schemaVersion: 1,
    createdAt: '2026-08-13T00:00:00.000Z',
    environment: {
      operatingSystem: 'linux',
      webview: 'WebKitGTK',
      renderer: 'webgl',
      machine: 'test',
      commit: 'deadbeef',
    },
    coldStartMs: 400,
    inputLatency: { samples: 100, p50Ms: 4, p95Ms: 8, p99Ms: 12 },
    memory: { idleMiB: 100, oneSessionMiB: 115, sessionIncrementMiB: 15 },
    output: {
      bytes: 100 * 1024 * 1024,
      durationMs: 2_000,
      throughputMiBPerSecond: 50,
      maximumMainThreadStallMs: 50,
      longTaskObserverSupported: true,
    },
    ...overrides,
  };
}

describe('performance gates', () => {
  it('loads only explicit renderer preferences', () => {
    expect(loadRendererPreference({ getItem: () => 'fallback' })).toBe('fallback');
    expect(loadRendererPreference({ getItem: () => 'webgl' })).toBe('webgl');
    expect(loadRendererPreference({ getItem: () => 'broken' })).toBe('auto');
  });
  it('computes nearest-rank percentiles without mutating samples', () => {
    const samples = [40, 10, 30, 20];
    expect(percentile(samples, 0.5)).toBe(20);
    expect(percentile(samples, 0.95)).toBe(40);
    expect(samples).toEqual([40, 10, 30, 20]);
  });

  it('passes a report within every budget', () => {
    expect(evaluatePerformance(report()).every((result) => result.passed)).toBe(true);
  });

  it('fails values on or beyond maximum budgets and short output fixtures', () => {
    const results = evaluatePerformance(report({
      coldStartMs: 500,
      output: {
        bytes: 99 * 1024 * 1024,
        durationMs: 2_000,
        throughputMiBPerSecond: 49.5,
        maximumMainThreadStallMs: 100,
        longTaskObserverSupported: true,
      },
    }));
    expect(results.filter((result) => !result.passed).map((result) => result.name)).toEqual([
      'coldStartMs',
      'minimumOutputBytes',
      'maximumMainThreadStallMs',
    ]);
  });
});

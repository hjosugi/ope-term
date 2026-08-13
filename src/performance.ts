import budgets from '../performance-budgets.json';
import type { RendererName } from './renderer-preference';

export type { RendererName } from './renderer-preference';

export interface PerformanceEnvironment {
  operatingSystem: string;
  webview: string;
  renderer: RendererName;
  machine: string;
  commit: string;
  notes?: string;
}

export interface PerformanceMemory {
  idleMiB: number;
  oneSessionMiB: number;
}

export interface PerformanceReport {
  schemaVersion: 1;
  createdAt: string;
  environment: PerformanceEnvironment;
  coldStartMs: number;
  inputLatency: {
    samples: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  };
  memory: {
    idleMiB: number;
    oneSessionMiB: number;
    sessionIncrementMiB: number;
  };
  output: {
    bytes: number;
    durationMs: number;
    throughputMiBPerSecond: number;
    maximumMainThreadStallMs: number;
    longTaskObserverSupported: boolean;
  };
}

export interface PerformanceVerdict {
  name: keyof typeof budgets;
  passed: boolean;
  actual: number;
  limit: number;
}

export interface PerformanceHarnessApi {
  resetOutput(): void;
  snapshot(environment: PerformanceEnvironment, memory: PerformanceMemory): PerformanceReport;
  download(environment: PerformanceEnvironment, memory: PerformanceMemory): void;
}

export const MAX_PERFORMANCE_SAMPLES = 10_000;

export class BoundedSamples {
  private readonly values: number[] = [];
  private cursor = 0;

  constructor(private readonly capacity = MAX_PERFORMANCE_SAMPLES) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('sample capacity must be a positive integer');
  }

  record(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    if (this.values.length < this.capacity) {
      this.values.push(value);
      return;
    }
    this.values[this.cursor] = value;
    this.cursor = (this.cursor + 1) % this.capacity;
  }

  reset(): void {
    this.values.length = 0;
    this.cursor = 0;
  }

  snapshot(): readonly number[] {
    return this.values;
  }
}

declare global {
  interface Window {
    __opeTermPerformance?: PerformanceHarnessApi;
  }
}

export function percentile(samples: readonly number[], requestedPercentile: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(requestedPercentile * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)] ?? 0;
}

export function evaluatePerformance(report: PerformanceReport): PerformanceVerdict[] {
  return [
    verdict('coldStartMs', report.coldStartMs, budgets.coldStartMs, 'max'),
    verdict('minimumInputSamples', report.inputLatency.samples, budgets.minimumInputSamples, 'min'),
    verdict('inputLatencyP99Ms', report.inputLatency.p99Ms, budgets.inputLatencyP99Ms, 'max'),
    verdict('idleMemoryMiB', report.memory.idleMiB, budgets.idleMemoryMiB, 'max'),
    verdict('sessionIncrementMiB', report.memory.sessionIncrementMiB, budgets.sessionIncrementMiB, 'max'),
    verdict('minimumOutputBytes', report.output.bytes, budgets.minimumOutputBytes, 'min'),
    verdict(
      'maximumMainThreadStallMs',
      report.output.maximumMainThreadStallMs,
      budgets.maximumMainThreadStallMs,
      'max',
    ),
  ];
}

export class BrowserPerformanceHarness implements PerformanceHarnessApi {
  private readonly inputLatencies = new BoundedSamples();
  private maximumLongTaskMs = 0;
  private coldStartMs = 0;
  private outputBytes = 0;
  private outputStartedAt?: number;
  private outputCompletedAt?: number;
  private renderer: RendererName = 'unknown';
  private readonly longTaskObserverSupported: boolean;
  private observer?: PerformanceObserver;

  constructor(private readonly clock: Pick<Performance, 'now'> = performance) {
    this.longTaskObserverSupported = globalThis.PerformanceObserver?.supportedEntryTypes.includes('longtask') ?? false;
  }

  start(): void {
    window.addEventListener('keydown', this.onKeydown, { capture: true });
    if (!this.longTaskObserverSupported) return;
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this.maximumLongTaskMs = Math.max(this.maximumLongTaskMs, entry.duration);
      }
    });
    this.observer.observe({ entryTypes: ['longtask'] });
  }

  stop(): void {
    window.removeEventListener('keydown', this.onKeydown, { capture: true });
    this.observer?.disconnect();
  }

  markReady(): void {
    this.coldStartMs = this.clock.now();
  }

  setRenderer(renderer: RendererName): void {
    this.renderer = renderer;
  }

  recordOutput(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    const now = this.clock.now();
    this.outputStartedAt ??= now;
    this.outputBytes += bytes;
    if (this.outputBytes >= budgets.minimumOutputBytes && this.outputCompletedAt === undefined) {
      this.outputCompletedAt = now;
    }
  }

  resetOutput(): void {
    this.outputBytes = 0;
    this.outputStartedAt = undefined;
    this.outputCompletedAt = undefined;
    this.maximumLongTaskMs = 0;
  }

  snapshot(environment: PerformanceEnvironment, memory: PerformanceMemory): PerformanceReport {
    const outputEnd = this.outputCompletedAt ?? this.clock.now();
    const durationMs = this.outputStartedAt === undefined ? 0 : Math.max(0, outputEnd - this.outputStartedAt);
    const inputLatencies = this.inputLatencies.snapshot();
    return {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      environment: { ...environment, renderer: this.renderer },
      coldStartMs: round(this.coldStartMs),
      inputLatency: {
        samples: inputLatencies.length,
        p50Ms: round(percentile(inputLatencies, 0.5)),
        p95Ms: round(percentile(inputLatencies, 0.95)),
        p99Ms: round(percentile(inputLatencies, 0.99)),
      },
      memory: {
        idleMiB: round(memory.idleMiB),
        oneSessionMiB: round(memory.oneSessionMiB),
        sessionIncrementMiB: round(memory.oneSessionMiB - memory.idleMiB),
      },
      output: {
        bytes: this.outputBytes,
        durationMs: round(durationMs),
        throughputMiBPerSecond: durationMs === 0
          ? 0
          : round((this.outputBytes / 1024 / 1024) / (durationMs / 1000)),
        maximumMainThreadStallMs: round(this.maximumLongTaskMs),
        longTaskObserverSupported: this.longTaskObserverSupported,
      },
    };
  }

  download(environment: PerformanceEnvironment, memory: PerformanceMemory): void {
    const report = this.snapshot(environment, memory);
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ope-term-performance-${report.createdAt.replaceAll(':', '-')}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url));
  }

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    const startedAt = this.clock.now();
    window.requestAnimationFrame(() => this.inputLatencies.record(this.clock.now() - startedAt));
  };
}

function verdict(
  name: keyof typeof budgets,
  actual: number,
  limit: number,
  comparison: 'min' | 'max',
): PerformanceVerdict {
  return { name, actual, limit, passed: comparison === 'min' ? actual >= limit : actual < limit };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

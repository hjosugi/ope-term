import { describe, expect, it } from 'vitest';
import { BrowserPerformanceHarness } from './performance';
import { AUTORUN_OUTPUT_BYTES, runPerformanceAutorun, type AutorunConfig } from './performance-autorun';

const config: AutorunConfig = {
  renderer: 'fallback',
  fixtureCommand: 'node /repo/scripts/performance-fixture.mjs',
  operatingSystem: 'Linux (Xvfb)',
  webview: 'WebKitGTK 2.44',
  machine: 'x86_64 / 4 CPUs',
  commit: 'abc123',
  notes: 'ci',
  inputSamples: 5,
};

class FakeHarness {
  bytes = 0;
  resets = 0;
  snapshots: unknown[] = [];
  outputByteCount(): number {
    return this.bytes;
  }
  resetOutput(): void {
    this.resets += 1;
    this.bytes = 0;
  }
  snapshot(environment: unknown, memory: unknown) {
    this.snapshots.push({ environment, memory });
    return { environment, memory } as never;
  }
  download(): void {}
}

describe('performance autorun', () => {
  it('measures idle and one-session memory, keys, and the full fixture in order', async () => {
    const harness = new FakeHarness();
    const events: string[] = [];
    let clock = 0;
    const memory = [180, 205];
    await runPerformanceAutorun(config, {
      harness,
      memory: async () => {
        events.push('memory');
        return memory.shift() ?? null;
      },
      openSession: async () => {
        events.push('open');
        return {
          pressKey: (key) => events.push(`key:${key}`),
          send: async (data) => {
            events.push(`send:${data}`);
            if (data.startsWith('node ')) harness.bytes = AUTORUN_OUTPUT_BYTES;
          },
        };
      },
      nextFrame: async () => undefined,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      now: () => clock,
    });

    expect(events).toEqual([
      'memory',
      'open',
      'memory',
      'key:a',
      'key:b',
      'key:c',
      'key:d',
      'key:e',
      'send:\u0015',
      `send:${config.fixtureCommand}\r`,
    ]);
    expect(harness.resets).toBe(1);
    expect(harness.snapshots[0]).toMatchObject({
      environment: { operatingSystem: 'Linux (Xvfb)', webview: 'WebKitGTK 2.44', commit: 'abc123' },
      memory: { idleMiB: 180, oneSessionMiB: 205 },
    });
  });

  it('gives up waiting for output at the timeout and reports missing memory as NaN', async () => {
    const harness = new FakeHarness();
    let clock = 0;
    await runPerformanceAutorun(config, {
      harness,
      memory: async () => null,
      openSession: async () => ({ pressKey: () => undefined, send: async () => undefined }),
      nextFrame: async () => undefined,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      now: () => clock,
    });
    const snapshot = harness.snapshots[0] as { environment: { notes: string }; memory: { idleMiB: number } };
    expect(Number.isNaN(snapshot.memory.idleMiB)).toBe(true);
    expect(snapshot.environment.notes).toContain('memory not measured');
    expect(clock).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });

  it('reports the real harness output count used to wait on the fixture', () => {
    const harness = new BrowserPerformanceHarness({ now: () => 0 });
    harness.recordOutput(1024);
    expect(harness.outputByteCount()).toBe(1024);
    harness.resetOutput();
    expect(harness.outputByteCount()).toBe(0);
  });
});

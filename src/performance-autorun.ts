import type { PerformanceEnvironment, PerformanceHarnessApi, PerformanceReport } from './performance';
import type { RendererPreference } from './renderer-preference';

/** Settings the Rust core reads from `OPE_TERM_PERFORMANCE_*` for one scripted run. */
export interface AutorunConfig {
  renderer: RendererPreference;
  fixtureCommand: string;
  operatingSystem: string;
  webview: string;
  machine: string;
  commit: string;
  notes: string;
  inputSamples: number;
}

export interface AutorunSession {
  /** Dispatches one synthetic keydown on the terminal's input element. */
  pressKey(key: string): void;
  /** Sends bytes to the shell through the normal terminal input IPC. */
  send(data: string): Promise<void>;
}

export interface AutorunDependencies {
  harness: PerformanceHarnessApi & { outputByteCount(): number };
  /** Resident memory of the app process tree in MiB, or null when unsupported. */
  memory(): Promise<number | null>;
  /** Opens a local terminal with the default shell and resolves once it is ready. */
  openSession(): Promise<AutorunSession>;
  nextFrame(): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
  /** Reports the current stage so a stuck run shows where it stopped. */
  progress?(stage: string): void;
}

export const AUTORUN_OUTPUT_BYTES = 100 * 1024 * 1024;
export const AUTORUN_OUTPUT_TIMEOUT_MS = 10 * 60 * 1000;
const SETTLE_MS = 1_500;
const OUTPUT_POLL_MS = 250;
const KEYS = 'abcdefghijklmnopqrstuvwxyz';

/**
 * Runs the same measurement an operator does by hand: idle memory, one local
 * session, keystrokes, then the 100 MiB fixture through PTY → IPC → xterm.
 *
 * Keystrokes are synthetic keydown events, so the latency covers the WebView's
 * handling and the next frame but not the OS input stack; the report says so.
 */
export async function runPerformanceAutorun(
  config: AutorunConfig,
  dependencies: AutorunDependencies,
): Promise<PerformanceReport> {
  const { harness } = dependencies;
  const progress = (stage: string): void => dependencies.progress?.(stage);
  await dependencies.sleep(SETTLE_MS);
  const idle = await dependencies.memory();
  progress(`idle memory ${idle ?? 'n/a'} MiB`);

  const session = await dependencies.openSession();
  await dependencies.sleep(SETTLE_MS);
  const oneSession = await dependencies.memory();
  progress(`session ready, memory ${oneSession ?? 'n/a'} MiB`);

  for (let index = 0; index < config.inputSamples; index += 1) {
    session.pressKey(KEYS[index % KEYS.length] ?? 'a');
    // Two frames apart so each sample measures one keydown to one frame.
    await dependencies.nextFrame();
    await dependencies.nextFrame();
  }
  // Clear anything the keystrokes typed at the prompt (Ctrl+U) before the fixture.
  await session.send('\u0015');
  await dependencies.sleep(SETTLE_MS);
  progress(`${config.inputSamples} keys sent`);

  harness.resetOutput();
  await session.send(`${config.fixtureCommand}\r`);
  const deadline = dependencies.now() + AUTORUN_OUTPUT_TIMEOUT_MS;
  while (harness.outputByteCount() < AUTORUN_OUTPUT_BYTES && dependencies.now() < deadline) {
    await dependencies.sleep(OUTPUT_POLL_MS);
  }
  progress(`fixture output ${harness.outputByteCount()} bytes`);

  const environment: PerformanceEnvironment = {
    operatingSystem: config.operatingSystem,
    webview: config.webview,
    renderer: 'unknown',
    machine: config.machine,
    commit: config.commit,
    notes: [
      'automated run (scripts/performance-autorun.mjs)',
      'input latency from synthetic keydown events',
      idle === null ? 'memory not measured on this OS' : 'memory = RSS of the app process tree',
      config.notes,
    ]
      .filter(Boolean)
      .join('; '),
  };
  // A missing memory reading must fail the gate instead of passing as zero.
  const idleMiB = idle ?? Number.NaN;
  const oneSessionMiB = oneSession ?? Number.NaN;
  return harness.snapshot(environment, { idleMiB, oneSessionMiB });
}

/**
 * OSC 133 ("FinalTerm") command boundaries, opt-in for local shells.
 *
 * A shell integration prints `ESC ] 133 ; A` at the prompt, `B` where the
 * command line starts, `C` when the command runs, and `D[;exit]` when it
 * finishes. ope-term only counts these marks and remembers where prompts start
 * so the operator can jump between commands; it never stores command text.
 */
export type CommandMark =
  | { kind: 'prompt-start' }
  | { kind: 'command-start' }
  | { kind: 'command-executed' }
  | { kind: 'command-finished'; exitCode?: number };

/** Prompt positions kept per terminal; older ones fall out of scrollback anyway. */
export const MAX_PROMPT_MARKS = 1_000;

/** Parses the payload xterm hands an OSC 133 handler (everything after `133;`). */
export function parseOsc133(data: string): CommandMark | null {
  const [code, first] = data.split(';', 2);
  switch (code) {
    case 'A':
      return { kind: 'prompt-start' };
    case 'B':
      return { kind: 'command-start' };
    case 'C':
      return { kind: 'command-executed' };
    case 'D': {
      if (first === undefined || first === '') return { kind: 'command-finished' };
      if (!/^-?\d{1,10}$/u.test(first)) return { kind: 'command-finished' };
      const exitCode = Number.parseInt(first, 10);
      return Number.isSafeInteger(exitCode) ? { kind: 'command-finished', exitCode } : { kind: 'command-finished' };
    }
    default:
      return null;
  }
}

export interface CommandBoundarySummary {
  /** Commands that ran (C) and then finished (D). */
  commands: number;
  /** Finished commands with a non-zero exit code. */
  failed: number;
  lastExitCode?: number;
  running: boolean;
}

/**
 * Counts commands from the mark sequence. A `D` without a preceding `C` (an
 * empty prompt, or a shell that reports D for every prompt) is not a command.
 */
export class CommandBoundaryTracker {
  #commands = 0;
  #failed = 0;
  #lastExitCode: number | undefined;
  #running = false;

  record(mark: CommandMark): void {
    switch (mark.kind) {
      case 'prompt-start':
      case 'command-start':
        return;
      case 'command-executed':
        this.#running = true;
        return;
      case 'command-finished':
        if (!this.#running) return;
        this.#running = false;
        this.#commands += 1;
        this.#lastExitCode = mark.exitCode;
        if (mark.exitCode !== undefined && mark.exitCode !== 0) this.#failed += 1;
    }
  }

  summary(): CommandBoundarySummary {
    return {
      commands: this.#commands,
      failed: this.#failed,
      lastExitCode: this.#lastExitCode,
      running: this.#running,
    };
  }
}

/** Nearest prompt line above the viewport top, for "previous command". */
export function previousPromptLine(promptLines: readonly number[], viewportTop: number): number | null {
  let best: number | null = null;
  for (const line of promptLines) {
    if (line < viewportTop && (best === null || line > best)) best = line;
  }
  return best;
}

/** Nearest prompt line below the viewport top, for "next command". */
export function nextPromptLine(promptLines: readonly number[], viewportTop: number): number | null {
  let best: number | null = null;
  for (const line of promptLines) {
    if (line > viewportTop && (best === null || line < best)) best = line;
  }
  return best;
}

export function formatCommandSummary(summary: CommandBoundarySummary): string {
  const parts = [`OSC 133 · ${summary.commands} commands`];
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  if (summary.running) parts.push('running');
  else if (summary.lastExitCode !== undefined) parts.push(`exit ${summary.lastExitCode}`);
  return parts.join(' · ');
}

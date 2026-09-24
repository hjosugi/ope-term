import { describe, expect, it } from 'vitest';
import {
  CommandBoundaryTracker,
  formatCommandSummary,
  nextPromptLine,
  parseOsc133,
  previousPromptLine,
} from './shell-integration';

describe('OSC 133 command boundaries', () => {
  it('parses the four FinalTerm marks and exit codes', () => {
    expect(parseOsc133('A')).toEqual({ kind: 'prompt-start' });
    expect(parseOsc133('B')).toEqual({ kind: 'command-start' });
    expect(parseOsc133('C')).toEqual({ kind: 'command-executed' });
    expect(parseOsc133('D')).toEqual({ kind: 'command-finished' });
    expect(parseOsc133('D;0')).toEqual({ kind: 'command-finished', exitCode: 0 });
    expect(parseOsc133('D;127')).toEqual({ kind: 'command-finished', exitCode: 127 });
    expect(parseOsc133('A;cl=m;aid=42')).toEqual({ kind: 'prompt-start' });
  });

  it('ignores unknown marks and never trusts a malformed exit code', () => {
    expect(parseOsc133('')).toBeNull();
    expect(parseOsc133('P;k=i')).toBeNull();
    expect(parseOsc133('D;abc')).toEqual({ kind: 'command-finished' });
    expect(parseOsc133('D;99999999999999999999')).toEqual({ kind: 'command-finished' });
  });

  it('counts only commands that ran, and tracks failures and the last exit code', () => {
    const tracker = new CommandBoundaryTracker();
    const marks = ['A', 'B', 'C', 'D;0', 'A', 'B', 'D;0', 'A', 'B', 'C', 'D;2', 'A', 'B', 'C'];
    for (const mark of marks) {
      const parsed = parseOsc133(mark);
      if (parsed) tracker.record(parsed);
    }
    expect(tracker.summary()).toEqual({ commands: 2, failed: 1, lastExitCode: 2, running: true });
    expect(formatCommandSummary(tracker.summary())).toBe('OSC 133 · 2 commands · 1 failed · running');
    tracker.record({ kind: 'command-finished', exitCode: 0 });
    expect(formatCommandSummary(tracker.summary())).toBe('OSC 133 · 3 commands · 1 failed · exit 0');
  });

  it('finds the nearest prompt above and below the viewport', () => {
    const prompts = [3, 40, 12, 90];
    expect(previousPromptLine(prompts, 41)).toBe(40);
    expect(previousPromptLine(prompts, 40)).toBe(12);
    expect(previousPromptLine(prompts, 3)).toBeNull();
    expect(nextPromptLine(prompts, 12)).toBe(40);
    expect(nextPromptLine(prompts, 90)).toBeNull();
    expect(nextPromptLine([], 0)).toBeNull();
  });
});

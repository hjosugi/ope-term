import { describe, expect, it } from 'vitest';
import { defaultLogPolicy, loadLogPolicies, normalizePolicy, saveLogPolicies } from './session-log-settings';

describe('session log settings', () => {
  it('round trips bounded host-specific policies', () => {
    let saved = '';
    const policy = { ...defaultLogPolicy(), enabled: true };
    saveLogPolicies({ 'ssh:prod': policy }, { setItem: (_key, value) => { saved = value; } });
    expect(loadLogPolicies({ getItem: () => saved })).toEqual({ 'ssh:prod': policy });
  });

  it('rejects malformed values and clamps rotation limits', () => {
    expect(normalizePolicy({})).toBeNull();
    expect(normalizePolicy({
      ...defaultLogPolicy(), rotationBytes: 1, retainedFiles: 999,
    })).toMatchObject({ rotationBytes: 1024 * 1024, retainedFiles: 20 });
    expect(loadLogPolicies({ getItem: () => 'broken' })).toEqual({});
  });
});


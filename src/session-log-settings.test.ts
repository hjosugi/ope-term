import { describe, expect, it } from 'vitest';
import {
  createLogPolicy,
  defaultLogPolicy,
  isValidFileNameTemplate,
  loadLogPolicies,
  normalizePolicy,
  saveLogPolicies,
} from './session-log-settings';

describe('session log settings', () => {
  it('round trips bounded host-specific policies', () => {
    let saved = '';
    const policy = { ...defaultLogPolicy(), enabled: true };
    expect(saveLogPolicies({ 'ssh:prod': policy }, { setItem: (_key, value) => { saved = value; } })).toBe(true);
    expect(loadLogPolicies({ getItem: () => saved })).toEqual({ 'ssh:prod': policy });
  });

  it('keeps unavailable storage non-fatal', () => {
    expect(saveLogPolicies({}, { setItem: () => { throw new Error('quota'); } })).toBe(false);
    expect(loadLogPolicies({ getItem: () => { throw new Error('disabled'); } })).toEqual({});
  });

  it('rejects malformed values and clamps rotation limits', () => {
    expect(normalizePolicy({})).toBeNull();
    expect(normalizePolicy({
      ...defaultLogPolicy(), rotationBytes: 1, retainedFiles: 999,
    })).toMatchObject({ rotationBytes: 1024 * 1024, retainedFiles: 20 });
    expect(loadLogPolicies({ getItem: () => 'broken' })).toEqual({});
  });

  it('builds a bounded policy from UI values', () => {
    expect(createLogPolicy({
      enabled: true,
      fileNameTemplate: '  {host}-{date}.log  ',
      timestamps: false,
      rotationMiB: '9999',
      retainedFiles: '2.9',
      hasDirectory: true,
    })).toEqual({
      ok: true,
      policy: {
        enabled: true,
        fileNameTemplate: '{host}-{date}.log',
        timestamps: false,
        rotationBytes: 1024 * 1024 * 1024,
        retainedFiles: 2,
      },
    });
  });

  it('rejects unknown variables, control characters, non-portable names, and UTF-8 overflow', () => {
    expect(isValidFileNameTemplate('{host}-{user}-{date}-{time}.log')).toBe(true);
    for (const template of [
      '{unknown}.log',
      'line\nbreak.log',
      'windows?.log',
      'directory/name.log',
      `${'界'.repeat(53)}.log`,
    ]) {
      expect(isValidFileNameTemplate(template)).toBe(false);
      expect(normalizePolicy({ ...defaultLogPolicy(), fileNameTemplate: template })).toBeNull();
    }
  });

  it('requires a directory only when logging is enabled', () => {
    const draft = {
      enabled: true,
      fileNameTemplate: 'session.log',
      timestamps: true,
      rotationMiB: '',
      retainedFiles: '',
      hasDirectory: false,
    };
    expect(createLogPolicy(draft)).toMatchObject({ ok: false });
    expect(createLogPolicy({ ...draft, enabled: false })).toMatchObject({ ok: true });
  });
});

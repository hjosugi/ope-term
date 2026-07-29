import { describe, expect, it } from 'vitest';
import { clearAuthResponses, takeAndClearAuthResponses } from './auth-secrets';

describe('authentication secrets', () => {
  it('removes values from input fields immediately after collection', () => {
    const fields = [{ value: 'password-value' }, { value: '123456' }];

    const responses = takeAndClearAuthResponses(fields);

    expect(responses).toEqual(['password-value', '123456']);
    expect(fields).toEqual([{ value: '' }, { value: '' }]);
  });

  it('clears the short-lived IPC response buffer', () => {
    const responses = ['password-value', '123456'];

    clearAuthResponses(responses);

    expect(responses).toEqual(['', '']);
  });
});

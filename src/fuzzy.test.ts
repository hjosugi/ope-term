import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyScore } from './fuzzy';

describe('fuzzy matching', () => {
  it('rejects a non-match', () => expect(fuzzyScore('zzz', 'prod-db')).toBeNull());
  it('matches case-insensitively', () => expect(fuzzyScore('PDB', 'prod-db')).not.toBeNull());
  it('prefers consecutive word starts', () => {
    expect(fuzzyFilter('pdb', ['deploy-web', 'prod-db', 'dashboard'], String)[0]).toBe('prod-db');
  });
});

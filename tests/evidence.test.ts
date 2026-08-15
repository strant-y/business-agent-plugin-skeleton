import { describe, expect, it } from 'vitest';
import { heuristicScorer } from '../src/core/evidence.js';

describe('heuristicScorer', () => {
  it('returns low for no evidence', () => {
    expect(heuristicScorer.score([])).toBe('low');
  });

  it('returns medium for a single code reference', () => {
    expect(heuristicScorer.score(['src/Product.ts'])).toBe('medium');
  });

  it('returns high for three or more code references', () => {
    expect(heuristicScorer.score(['a.ts', 'b.ts', 'c.ts'])).toBe('high');
  });

  it('returns medium for text-only evidence', () => {
    expect(heuristicScorer.score(['reviewed in meeting'])).toBe('medium');
  });
});

import type { Confidence } from './types.js';

export interface EvidenceScorer {
  readonly name: string;
  score(evidence: string[], context?: { text?: string; count?: number }): Confidence;
}

export const heuristicScorer: EvidenceScorer = {
  name: 'heuristic',
  score(evidence, context) {
    const count = context?.count ?? evidence.length;
    const hasCodeRef = evidence.some((e) => /\.(ts|tsx|js|jsx|vue|java|sql|xml)$/i.test(e));
    const hasText = evidence.some((e) => e.trim().length > 0);
    if (hasText && hasCodeRef && count >= 3) return 'high';
    if (hasText && (hasCodeRef || count >= 1)) return 'medium';
    return 'low';
  },
};

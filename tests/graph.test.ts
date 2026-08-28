import { describe, expect, it } from 'vitest';
import { buildGraph, traceGraph } from '../src/core/graph.js';

describe('traceGraph accuracy weighting', () => {
  it('keeps low-accuracy relationships but visits them after reliable edges', () => {
    const graph = buildGraph(
      { entities: [{ name: 'Root' }, { name: 'Reliable' }, { name: 'Noisy' }] } as never,
      [
        { source: 'Root', target: 'Noisy', relationship: 'references', cardinality: 'unknown' },
        { source: 'Root', target: 'Reliable', relationship: 'calls', cardinality: '1:1' },
      ] as never,
    );
    const steps = traceGraph('root.ts', 'Root', graph, 2, { lowAccuracyRelationships: new Set(['references']) });
    expect(steps.map((step) => step.node)).toEqual(['Root', 'Reliable', 'Noisy']);
  });
});

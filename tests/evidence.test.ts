import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { heuristicScorer, normalizeEvidence, validateEvidence } from '../src/core/evidence.js';
import { retrieveTaskContext } from '../src/core/retrieval.js';

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

  it('returns high when code references outnumber doc references', () => {
    expect(heuristicScorer.score(['a.ts', 'b.ts', 'docs/design.md'])).toBe('high');
  });

  it('returns low for text-only evidence (docs are reference, not ground truth)', () => {
    expect(heuristicScorer.score(['reviewed in meeting'])).toBe('low');
    expect(heuristicScorer.score(['docs/design.md', 'docs/api.md'])).toBe('low');
  });
});

describe('normalizeEvidence', () => {
  it('keeps old string evidence compatible with line ranges', () => {
    const [item] = normalizeEvidence('src/Product.ts:12-18');
    expect(item.file).toBe('src/Product.ts');
    expect(item.lineStart).toBe(12);
    expect(item.lineEnd).toBe(18);
    expect(item.kind).toBe('source');
  });

  it('preserves non-standard evidence objects while filling defaults', () => {
    const [item] = normalizeEvidence({ id: 'e-1', kind: 'human', file: 'a.ts', capturedAt: '', strength: undefined });
    expect(item.id).toBe('e-1');
    expect(item.kind).toBe('human');
    expect(item.strength).toBe('linked');
    expect(item.capturedAt.length).toBeGreaterThan(0);
  });
});

describe('validateEvidence', () => {
  it('reports invalid line ranges and missing snippets', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-evidence-'));
    const file = path.join(root, 'sample.txt');
    await fs.writeFile(file, 'alpha\nbeta\ngamma\n', 'utf8');

    const result = await validateEvidence(
      {
        id: 'e-1',
        kind: 'source',
        capturedAt: new Date().toISOString(),
        file: 'sample.txt',
        lineStart: 4,
        lineEnd: 5,
        snippet: 'missing',
      },
      root,
    );

    expect(result.valid).toBe(false);
    expect(result.warnings).toContain('Evidence line range is outside the file.');
    expect(result.warnings).toContain('Evidence snippet was not found.');
  });
});

describe('evidence-aware retrieval', () => {
  it('prefers direct evidence over linked evidence and exposes the reason', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-evidence-retrieval-'));
    const now = new Date().toISOString();
    await fs.mkdir(path.join(root, '.agent/memory/indexes'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.agent/memory/indexes/retrieval-index.json'),
      JSON.stringify(
        [
          {
            id: 'direct-evidence-doc',
            type: 'rule',
            title: 'Directly evidenced pricing rule',
            tokens: ['pricing', 'discount', 'rule'],
            aliases: ['Order'],
            relatedIds: ['order'],
            status: 'verified',
            confidence: 0.82,
            updatedAt: now,
            text: 'pricing rule backed by code and test evidence',
            evidence: [
              {
                id: 'e1',
                kind: 'source',
                capturedAt: now,
                file: 'src/pricing.ts',
                lineStart: 10,
                lineEnd: 20,
                strength: 'direct',
              },
              {
                id: 'e2',
                kind: 'test',
                capturedAt: now,
                file: 'tests/pricing.test.ts',
                lineStart: 5,
                lineEnd: 15,
                strength: 'direct',
              },
            ],
          },
          {
            id: 'linked-evidence-doc',
            type: 'rule',
            title: 'Linked pricing rule',
            tokens: ['pricing', 'discount', 'rule'],
            aliases: ['Order'],
            relatedIds: ['order'],
            status: 'verified',
            confidence: 0.78,
            updatedAt: now,
            text: 'pricing rule backed by meeting notes',
            evidence: [
              { id: 'e3', kind: 'human', capturedAt: now, snippet: 'confirm pricing rule', strength: 'linked' },
            ],
          },
        ],
        null,
        2,
      ),
      'utf8',
    );

    const hits = await retrieveTaskContext(root, 'pricing discount rule');
    expect(hits[0].id).toBe('direct-evidence-doc');
    expect(hits[0].reasons).toContain('证据强度：2条');
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
  });
});

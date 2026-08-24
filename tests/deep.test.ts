import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discover } from '../src/core/discovery.js';

const DEEP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/deep');

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ba-deep-'));
}

describe('discover analyzers', () => {
  it('runs sql, api and ast analyzers by default in dry-run', async () => {
    const manifest = await discover(DEEP, { dryRun: true });

    expect(manifest.apis.length).toBeGreaterThanOrEqual(3);
    expect(manifest.apis.map((a) => a.path)).toEqual(
      expect.arrayContaining(['/api/products', '/api/orders', '/api/orders/:id']),
    );

    const fk = manifest.relations.find((r) => r.source === 'Orders' && r.target === 'Customer');
    expect(fk?.cardinality).toBe('N:1');

    const customer = manifest.entities.find((e) => e.name === 'Customer');
    expect(customer?.confidence).toBe('high');
    expect(customer?.attributes?.some((a) => a.name === 'orders')).toBe(true);
    expect(manifest.apis.find((api) => api.path === '/api/orders')?.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ entity: 'Order', field: 'id' })]),
    );
  });

  it('writes relationships to confirmed store and candidate rules to memory/candidates', async () => {
    const dir = await tempRoot();
    await fs.cp(DEEP, dir, { recursive: true });
    await discover(dir);

    const rulesDir = path.join(dir, '.agent/business/rules');
    const relsDir = path.join(dir, '.agent/business/relationships');
    const impactDir = path.join(dir, '.agent/business/impact');
    const candidatesDir = path.join(dir, '.agent/memory/candidates');

    // Discovered rules are candidates: they must NOT leak into the confirmed store.
    const ruleFiles = (await fs.readdir(rulesDir).catch(() => [] as string[])).filter((f) => f.endsWith('.json'));
    expect(ruleFiles).toEqual([]);

    const candidateFiles = (await fs.readdir(candidatesDir)).filter((f) => f.endsWith('.md'));
    expect(candidateFiles).toEqual(
      expect.arrayContaining(['rule-discovery-validation-state.md', 'rule-discovery-thrown-error.md']),
    );
    const candidate = await fs.readFile(path.join(candidatesDir, 'rule-discovery-thrown-error.md'), 'utf8');
    expect(candidate).toContain('# Candidate:');
    expect(candidate).toContain('## Hypothesis');
    expect(candidate).toContain('## Evidence');
    expect(candidate).toContain('## Context');
    expect(candidate).toContain('Customer.ts');
    expect(candidate).toMatch(/Context\n- .*Customer\.ts:/);

    const relFiles = (await fs.readdir(relsDir)).filter((f) => f.endsWith('.json'));
    expect(relFiles.length).toBeGreaterThan(0);

    const impactFiles = (await fs.readdir(impactDir)).filter((f) => f.endsWith('.md'));
    expect(impactFiles.length).toBeGreaterThan(0);

    const manifest = JSON.parse(await fs.readFile(path.join(dir, '.agent/memory/discovery-manifest.json'), 'utf8'));
    expect(manifest.conflicts).toEqual([]);
    expect(manifest.apis.length).toBeGreaterThan(0);
  });
});

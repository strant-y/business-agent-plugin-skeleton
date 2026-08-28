import { describe, expect, it } from 'vitest';
import { runAnalyzers, type Analyzer } from '../src/core/analyzer.js';
import { loadTs } from '../src/core/analyzers/ast.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import type { ProjectScan } from '../src/core/scanner.js';
import type { ApiRoute, Entity, Relation } from '../src/core/types.js';

const SCAN: ProjectScan = { files: [], sampleText: '', samples: [] };

function makeEntity(name: string): Entity {
  return {
    id: `entity.${name.toLowerCase()}`,
    name,
    type: 'business_entity',
    description: 'test entity',
    confidence: 'medium',
    evidence: [],
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('runAnalyzers', () => {
  it('lets dependent-phase analyzers see entities discovered in the entity phase', async () => {
    let captured: Entity[] = [];
    const producer: Analyzer = {
      name: 'sql',
      analyze() {
        return { entities: [makeEntity('Wizard')] };
      },
    };
    const dependent: Analyzer = {
      name: 'api',
      analyze(_scan, ctx) {
        captured = ctx.entities;
        return {};
      },
    };

    await runAnalyzers(SCAN, { config: DEFAULT_CONFIG, entities: [], rules: [] }, [dependent, producer]);

    expect(captured.map((e) => e.name)).toContain('Wizard');
  });

  it('reports a failing analyzer as a warning and keeps the rest of the run', async () => {
    const failing: Analyzer = {
      name: 'ast',
      analyze() {
        throw new Error('boom');
      },
    };
    const producer: Analyzer = {
      name: 'sql',
      analyze() {
        return { entities: [makeEntity('Wizard')] };
      },
    };

    const warnings: string[] = [];
    const result = await runAnalyzers(
      SCAN,
      { config: DEFAULT_CONFIG, entities: [], rules: [] },
      [failing, producer],
      (m) => warnings.push(m),
    );

    expect(warnings.join(' ')).toContain('Analyzer "ast" failed');
    expect(warnings.join(' ')).toContain('boom');
    expect(result.entities.some((e) => e.name === 'Wizard')).toBe(true);
  });

  it('runs entity-phase analyzers concurrently', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = new Set<string>();
    let maxConcurrent = 0;

    const makeGated = (name: 'sql' | 'ast'): Analyzer => ({
      name,
      async analyze() {
        current.add(name);
        maxConcurrent = Math.max(maxConcurrent, current.size);
        await gate;
        current.delete(name);
        return { entities: [makeEntity(name === 'sql' ? 'Alpha' : 'Beta')] };
      },
    });

    const run = runAnalyzers(SCAN, { config: DEFAULT_CONFIG, entities: [], rules: [] }, [
      makeGated('sql'),
      makeGated('ast'),
    ]);
    await waitFor(() => current.size === 2);
    release();
    const result = await run;

    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
    expect(result.entities.map((e) => e.name).sort()).toEqual(['Alpha', 'Beta']);
  });

  it('merges results in phase order regardless of completion timing', async () => {
    const slowFirst: Analyzer = {
      name: 'sql',
      async analyze() {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { entities: [makeEntity('SlowSql')] };
      },
    };
    const fastSecond: Analyzer = {
      name: 'ast',
      analyze() {
        return { entities: [makeEntity('FastAst')] };
      },
    };

    const first = await runAnalyzers(SCAN, { config: DEFAULT_CONFIG, entities: [], rules: [] }, [
      slowFirst,
      fastSecond,
    ]);
    const second = await runAnalyzers(SCAN, { config: DEFAULT_CONFIG, entities: [], rules: [] }, [
      fastSecond,
      slowFirst,
    ]);

    expect(first.entities.map((e) => e.name)).toEqual(['SlowSql', 'FastAst']);
    expect(second.entities.map((e) => e.name)).toEqual(['SlowSql', 'FastAst']);
  });

  it('preserves distinct relations and API routes during deduplication', async () => {
    const relation = (
      relationship: Relation['relationship'],
      subtype?: Relation['subtype'],
      provenance?: Relation['provenance'],
    ): Relation => ({
      id: `relation.${relationship}.${subtype ?? 'none'}.${provenance ?? 'none'}`,
      source: 'Order',
      target: 'Customer',
      relationship,
      subtype,
      provenance,
      cardinality: 'unknown',
      confidence: 'low',
      evidence: [],
    });
    const api = (kind: 'backend' | 'frontend'): ApiRoute => ({
      id: `api.${kind}`,
      method: 'GET',
      path: '/orders',
      kind,
      confidence: 'low',
      evidence: [],
    });
    const analyzer: Analyzer = {
      name: 'sql',
      analyze() {
        return {
          relations: [
            relation('references'),
            relation('calls', 'api_route_call', 'frontend_page'),
            relation('calls', 'api_route_call', 'frontend_linkage'),
            relation('calls', 'composable_usage', 'store_module'),
          ],
          apis: [api('backend'), api('frontend')],
        };
      },
    };
    const result = await runAnalyzers(SCAN, { config: DEFAULT_CONFIG, entities: [], rules: [] }, [analyzer]);
    expect(result.relations).toHaveLength(4);
    expect(result.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relationship: 'references', source: 'Order', target: 'Customer' }),
        expect.objectContaining({
          relationship: 'calls',
          subtype: 'api_route_call',
          provenance: 'frontend_page',
          source: 'Order',
          target: 'Customer',
        }),
        expect.objectContaining({
          relationship: 'calls',
          subtype: 'api_route_call',
          provenance: 'frontend_linkage',
          source: 'Order',
          target: 'Customer',
        }),
        expect.objectContaining({
          relationship: 'calls',
          subtype: 'composable_usage',
          provenance: 'store_module',
          source: 'Order',
          target: 'Customer',
        }),
      ]),
    );
    expect(result.apis).toHaveLength(2);
  });

  it('does not emit false typescript-missing warnings when ast and vue run concurrently', async () => {
    // Mirror the real ast/vue analyzers: both check loadTs() at the start.
    const astLike: Analyzer = {
      name: 'ast',
      async analyze(_scan, ctx) {
        if (!(await loadTs())) {
          ctx.warn?.('ast/vue analysis skipped');
          return {};
        }
        return { entities: [makeEntity('FromAst')] };
      },
    };
    const vueLike: Analyzer = {
      name: 'vue',
      async analyze(_scan, ctx) {
        if (!(await loadTs())) {
          ctx.warn?.('ast/vue analysis skipped');
          return {};
        }
        return { entities: [makeEntity('FromVue')] };
      },
    };

    const warnings: string[] = [];
    const result = await runAnalyzers(
      SCAN,
      { config: DEFAULT_CONFIG, entities: [], rules: [] },
      [astLike, vueLike],
      (m) => warnings.push(m),
    );

    expect(warnings).toEqual([]);
    expect(result.entities.map((e) => e.name).sort()).toEqual(['FromAst', 'FromVue']);
  });
});

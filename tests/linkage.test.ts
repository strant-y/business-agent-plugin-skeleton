import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanProject } from '../src/core/scanner.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { apiAnalyzer } from '../src/core/analyzers/api.js';
import {
  linkageAnalyzer,
  linkFrontendModules,
  linkViewsToApis,
  staticCallPath,
} from '../src/core/analyzers/linkage.js';
import { runAnalyzers } from '../src/core/analyzer.js';
import { buildModuleDescriptor, moduleNodeId } from '../src/core/module-id.js';
import type { ApiRoute, Entity } from '../src/core/types.js';

const LINK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/linkage');

const ORDER_ENTITY: Entity = {
  id: 'entity.order',
  name: 'Order',
  type: 'business_entity',
  description: '',
  confidence: 'low',
  evidence: [],
};

describe('linkageAnalyzer', () => {
  it('links a Vue view call to the matching backend API route and its entity', async () => {
    const scan = await scanProject(LINK, DEFAULT_CONFIG);
    const { apis, relations } = await runAnalyzers(
      scan,
      { config: DEFAULT_CONFIG, entities: [ORDER_ENTITY], rules: [], relations: [] },
      [apiAnalyzer, linkageAnalyzer],
    );

    expect(apis.some((a) => a.path === '/api/orders')).toBe(true);

    const rel = relations.find((r) => r.relationship === 'calls_api');
    expect(rel).toBeDefined();
    expect(rel?.source).toBe(moduleNodeId('ui/OrderList.vue'));
    expect(rel?.target).toBe('Order');
    expect(rel?.description).toContain('GET /api/orders');
    expect(rel?.evidence.some((f) => f.endsWith('OrderList.vue'))).toBe(true);
  });

  it('links components to composables and stores and identifies frontend entities', async () => {
    const scan = await scanProject(LINK, DEFAULT_CONFIG);
    const relations = linkFrontendModules(
      scan,
      [
        {
          method: 'GET',
          path: '/api/orders',
          entity: 'Order',
          kind: 'backend',
          id: 'api.orders',
          confidence: 'low',
          evidence: [],
        },
      ],
      [ORDER_ENTITY],
      [
        buildModuleDescriptor('ui/OrderList.vue'),
        buildModuleDescriptor('stores/orderStore.ts'),
        buildModuleDescriptor('composables/useOrderData.ts'),
      ],
    );
    expect(relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: moduleNodeId('ui/OrderList.vue'),
          target: moduleNodeId('stores/orderStore.ts'),
          relationship: 'uses_store',
        }),
        expect.objectContaining({
          source: moduleNodeId('ui/OrderList.vue'),
          target: moduleNodeId('composables/useOrderData.ts'),
          relationship: 'uses_composable',
        }),
        expect.objectContaining({
          source: moduleNodeId('ui/OrderList.vue'),
          target: 'Order',
          relationship: 'uses_entity',
        }),
        expect.objectContaining({
          source: moduleNodeId('stores/orderStore.ts'),
          target: moduleNodeId('composables/useOrderData.ts'),
          relationship: 'uses_composable',
        }),
      ]),
    );
  });

  it('marks vue-router paths as frontend routes and never links views to them', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-link2-'));
    await fs.writeFile(
      path.join(dir, 'router.ts'),
      'export const routes = [{ path: "/orders", component: OrderList }];',
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, 'OrderList.vue'),
      '<script setup lang="ts">import axios from "axios";\naxios.get("/orders");</script>',
      'utf8',
    );
    const scan = await scanProject(dir, DEFAULT_CONFIG);
    const apis = apiAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities: [ORDER_ENTITY], rules: [] }).apis ?? [];

    const frontend = apis.find((a) => a.path === '/orders');
    expect(frontend?.kind).toBe('frontend');

    // A frontend-only route must not produce a calls_api relation.
    const relations = linkViewsToApis(
      scan,
      apis.filter((a) => a.kind === 'frontend'),
    );
    expect(relations).toEqual([]);

    // While an equivalent backend route still links.
    const backend: ApiRoute[] = [
      {
        id: 'api.get-orders',
        method: 'GET',
        path: '/orders',
        entity: 'Order',
        kind: 'backend',
        confidence: 'low',
        evidence: [],
      },
    ];
    const linked = linkViewsToApis(scan, backend);
    expect(linked.length).toBe(1);
    expect(linked[0].target).toBe('Order');
  });

  it('matches template-literal calls with query strings to parameterized backend routes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-link3-'));
    await fs.writeFile(
      path.join(dir, 'OrderDetail.vue'),
      '<script setup lang="ts">import axios from "axios";\naxios.get(`/api/orders/${id}?expand=items`);</script>',
      'utf8',
    );
    const scan = await scanProject(dir, DEFAULT_CONFIG);
    const backend: ApiRoute[] = [
      {
        id: 'api.get-order',
        method: 'GET',
        path: '/api/orders/:id',
        entity: 'Order',
        kind: 'backend',
        confidence: 'low',
        evidence: [],
      },
    ];
    const relations = linkViewsToApis(scan, backend);
    expect(relations.length).toBe(1);
    expect(relations[0].target).toBe('Order');
  });
});

describe('module-id', () => {
  it('builds stable module descriptors from file paths', () => {
    expect(buildModuleDescriptor('src/views/OrderList.vue')).toEqual({
      id: moduleNodeId('src/views/OrderList.vue'),
      name: 'OrderList',
      file: 'src/views/OrderList.vue',
    });
  });
});

describe('staticCallPath', () => {
  it('strips query strings, template expressions and trailing slashes', () => {
    expect(staticCallPath('/api/orders?sort=desc')).toBe('/api/orders');
    expect(staticCallPath('/api/orders/${id}')).toBe('/api/orders');
    expect(staticCallPath('/api/orders/${id}?x=1#frag')).toBe('/api/orders');
    expect(staticCallPath('/api/orders/')).toBe('/api/orders');
    expect(staticCallPath('/api/orders')).toBe('/api/orders');
  });
});

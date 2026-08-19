import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanProject } from '../src/core/scanner.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { storesAnalyzer } from '../src/core/analyzers/stores.js';
import { runAnalyzers } from '../src/core/analyzer.js';
import type { Entity } from '../src/core/types.js';

const ORDER: Entity = {
  id: 'entity.order',
  name: 'Order',
  type: 'business_entity',
  description: '',
  confidence: 'medium',
  evidence: [],
};

async function analyze(
  files: Record<string, string>,
  entities: Entity[] = [ORDER],
): Promise<ReturnType<typeof storesAnalyzer.analyze> extends Promise<infer T> ? T : never> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-stores-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content, 'utf8');
  }
  const scan = await scanProject(dir, DEFAULT_CONFIG);
  return storesAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities, rules: [], relations: [] });
}

describe('storesAnalyzer', () => {
  it('extracts a Pinia option store: entity, state attributes, transitions, guards and thrown errors', async () => {
    const result = await analyze({
      'orderStore.ts': `
import { defineStore } from 'pinia';

export const useOrderStore = defineStore('orderStore', {
  state: () => ({
    status: 'DRAFT',
    total: 0,
    order: null as Order | null,
  }),
  actions: {
    submit() {
      if (this.status === 'AUDIT') throw new Error('audited order cannot be resubmitted');
      this.status = 'AUDITING';
    },
  },
});
`,
    });

    const store = result.entities?.find((e) => e.name === 'OrderStore');
    expect(store).toBeDefined();
    expect(store?.type).toBe('frontend_store');
    expect(store?.description).toContain('orderStore');
    expect(store?.attributes?.map((a) => a.name)).toEqual(expect.arrayContaining(['status', 'total', 'order']));

    const rules = result.rules ?? [];
    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Store state transition', entity: 'OrderStore' }),
        expect.objectContaining({ name: 'State-dependent action guard', entity: 'OrderStore' }),
        expect.objectContaining({ name: 'Explicit validation error thrown', entity: 'OrderStore' }),
      ]),
    );
    const transition = rules.find((r) => r.name === 'Store state transition');
    expect(transition?.rule[0]).toContain('AUDITING');
    expect(transition?.context?.[0]).toContain('orderStore.ts');

    expect(result.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'OrderStore', target: 'Order', relationship: 'uses_entity' }),
      ]),
    );
  });

  it('extracts a composable with ref attributes and state transition rules', async () => {
    const result = await analyze({
      'useOrderData.ts': `
import { ref } from 'vue';

export function useOrderData() {
  const orders = ref<Order[]>([]);
  const status = ref('DRAFT');
  function submit() {
    status.value = 'AUDITING';
  }
  return { orders, status, submit };
}
`,
    });

    const composable = result.entities?.find((e) => e.name === 'UseOrderData');
    expect(composable).toBeDefined();
    expect(composable?.type).toBe('composable');
    expect(composable?.attributes?.map((a) => a.name)).toEqual(expect.arrayContaining(['orders', 'status']));
    expect(result.rules).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Store state transition', entity: 'UseOrderData' })]),
    );
  });

  it('extracts a Vuex store', async () => {
    const result = await analyze({
      'vuexStore.ts': `
import { createStore } from 'vuex';

export default createStore({
  state: { status: 'DRAFT' },
  actions: {
    submit(ctx) {
      ctx.state.status = 'AUDITING';
    },
  },
});
`,
    });

    expect(result.entities?.some((e) => e.name === 'VuexStore')).toBe(true);
    const vuex = result.entities?.find((e) => e.name === 'VuexStore');
    expect(vuex?.type).toBe('frontend_store');
    expect(vuex?.attributes?.some((a) => a.name === 'status')).toBe(true);
    expect(result.rules).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Store state transition', entity: 'VuexStore' })]),
    );
  });

  it('extracts an API wrapper module and links its Promise response types to entities', async () => {
    const result = await analyze({
      'orderApi.ts': `
import axios from 'axios';

export const orderApi = {
  async getOrder(id: number): Promise<Order> {
    return (await axios.get(\`/api/orders/\${id}\`)).data;
  },
};
`,
    });

    const apiClient = result.entities?.find((e) => e.name === 'OrderApi');
    expect(apiClient?.type).toBe('api_client');
    expect(result.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'OrderApi', target: 'Order', relationship: 'calls_api' }),
      ]),
    );
  });

  it('merges store entities through the analyzer pipeline', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-stores-pipe-'));
    await fs.writeFile(
      path.join(dir, 'orderStore.ts'),
      `
import { defineStore } from 'pinia';
export const useOrderStore = defineStore('orderStore', {
  state: () => ({ status: 'DRAFT' }),
  actions: { submit() { this.status = 'AUDITING'; } },
});
`,
      'utf8',
    );
    const scan = await scanProject(dir, DEFAULT_CONFIG);
    const result = await runAnalyzers(scan, { config: DEFAULT_CONFIG, entities: [ORDER], rules: [], relations: [] }, [
      storesAnalyzer,
    ]);
    expect(result.entities.some((e) => e.name === 'OrderStore')).toBe(true);
    expect(result.rules.length).toBeGreaterThan(0);
  });
});

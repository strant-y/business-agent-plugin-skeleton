import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanProject } from '../src/core/scanner.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { storesAnalyzer } from '../src/core/analyzers/stores.js';

describe('storesAnalyzer field refs', () => {
  it('extracts store.state fields and DTO-backed refs from store code', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-stores-'));
    await fs.mkdir(path.join(dir, 'stores'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'stores/orderStore.ts'),
      `import { computed } from 'vue';
import { defineStore } from 'pinia';
interface OrderDTO { id: string; status: string; totalAmount: number }
export const useOrderStore = defineStore('order', {
  state: () => ({ status: 'DRAFT', totalAmount: 0 }),
  actions: {
    hydrate(response: { data: OrderDTO }) {
      this.state.status = response.data.status;
      this.totalAmount = response.data.totalAmount;
    },
  },
});
export const canSubmit = computed(() => store.state.status === 'DRAFT' && store.totalAmount > 0);`,
      'utf8',
    );

    const scan = await scanProject(dir, DEFAULT_CONFIG);
    const result = await storesAnalyzer.analyze(scan, {
      config: DEFAULT_CONFIG,
      entities: [
        {
          id: 'entity.order',
          name: 'Order',
          type: 'business_entity',
          description: 'Order entity',
          confidence: 'high',
          evidence: ['Order.ts'],
          attributes: [
            { name: 'id', type: 'string' },
            { name: 'status', type: 'string' },
            { name: 'totalAmount', type: 'number' },
          ],
        },
      ],
      rules: [],
      relations: [],
    });

    const store = result.entities?.[0];
    expect(store?.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'status' }),
        expect.objectContaining({ name: 'totalAmount' }),
      ]),
    );
    const computedRule = (result.rules ?? []).find((rule) => rule.name === 'Computed permission guard');
    expect(computedRule?.preconditions).toContain('reads state.status');
    expect(computedRule?.rule[0]).toContain("store.state.status === 'DRAFT'");
  });
});

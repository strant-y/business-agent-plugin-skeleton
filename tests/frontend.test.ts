import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanProject } from '../src/core/scanner.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { frontendAnalyzer } from '../src/core/analyzers/frontend.js';
import { discover } from '../src/core/discovery.js';

describe('frontendAnalyzer', () => {
  it('models Vue pages, actions, stores, permissions and validation constraints', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-frontend-'));
    await fs.mkdir(path.join(dir, 'views'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'views/OrderEdit.vue'),
      `<template><form @submit="submit"><button @click="save" :disabled="order.status === 'AUDIT'">Save</button></form></template>
<script setup lang="ts">
import { ref } from 'vue';
import axios from 'axios';
import { useOrderStore } from '../stores/orderStore';
import { postOrder } from '../api/orderApi';
interface OrderDTO { id: string; status: string; totalAmount: number }
const orderStore = useOrderStore();
const order = ref<OrderDTO>({ id: '1', status: 'DRAFT', totalAmount: 1 });
const permission = hasPermission('order.edit');
const rules = { required: true, minLength: 3 };
function submit() { orderStore.status = 'AUDITING'; axios.post('/api/order'); }
function save() { submit(); }
</script>`,
      'utf8',
    );
    const scan = await scanProject(dir, DEFAULT_CONFIG);
    const result = await frontendAnalyzer.analyze(scan, {
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
    expect(result.pages?.[0]).toEqual(
      expect.objectContaining({ component: 'OrderEdit', stores: expect.arrayContaining(['useOrderStore']) }),
    );
    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ trigger: 'submit', stores: ['useOrderStore'] }),
        expect.objectContaining({ trigger: 'click', stores: ['useOrderStore'] }),
      ]),
    );
    expect(result.rules?.[0]?.rule.join(' ')).toContain('AUDIT');
    expect(result.rules?.[0]?.rule.join(' ')).toContain('order.edit');
    expect(result.rules?.[0]?.rule.join(' ')).toContain('Form validation');
    expect(result.workflows?.[0]?.steps).toEqual(
      expect.arrayContaining(['Action: submit', 'Action: save', 'State: AUDITING', 'Field: Order.status']),
    );
    expect(result.pages?.[0]?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity: 'Order', field: 'status' }),
        expect.objectContaining({ entity: 'Order', field: 'totalAmount' }),
      ]),
    );
    expect(result.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'OrderEdit',
          target: 'action.orderedit-submit-0',
          relationship: 'calls',
          subtype: 'page_action_trigger',
        }),
        expect.objectContaining({
          source: 'submit',
          relationship: 'calls',
          target: 'useOrderStore',
          subtype: 'action_store_update',
        }),
        expect.objectContaining({
          source: 'submit',
          relationship: 'calls',
          target: '/api/order',
          subtype: 'action_api_call',
        }),
      ]),
    );
  });

  it('models React components and hooks as frontend pages and actions', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-react-'));
    await fs.writeFile(
      path.join(dir, 'OrderPage.tsx'),
      `import { useEffect } from 'react';
export function OrderPage() { useEffect(() => loadOrders(), []); return <button onClick={submitOrder}>Submit</button>; }`,
      'utf8',
    );
    const scan = await scanProject(dir, DEFAULT_CONFIG);
    const result = await frontendAnalyzer.analyze(scan, {
      config: DEFAULT_CONFIG,
      entities: [],
      rules: [],
      relations: [],
    });
    expect(result.entities?.some((entity) => entity.name === 'OrderPage' && entity.type === 'page')).toBe(true);
    expect(result.actions?.some((action) => action.name === 'submitOrder')).toBe(true);
  });

  it('includes frontend models in the discovery manifest', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-frontend-manifest-'));
    await fs.mkdir(path.join(dir, 'pages'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'pages/Order.vue'),
      `<template><button @click="submit">Submit</button></template><script setup>function submit() {}</script>`,
      'utf8',
    );
    const manifest = await discover(dir, { dryRun: true, analyzers: ['frontend'] });
    expect(manifest.pages?.some((page) => page.component === 'Order')).toBe(true);
    expect(manifest.actions?.some((action) => action.source === 'Order')).toBe(true);
    expect(manifest.workflows?.some((workflow) => workflow.name.includes('frontend flow'))).toBe(true);
  });

  it('inherits store API calls onto pages (Pinia data flow) and reads request({url}) wrappers', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-frontend-store-api-'));
    await fs.mkdir(path.join(dir, 'stores'), { recursive: true });
    await fs.mkdir(path.join(dir, 'views'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'stores/quoteStore.ts'),
      `import request from '../api/request';
export const useQuoteStore = () => ({
  async doQuote() {
    const quote = await request({ url: '/quote/calc', method: 'post' });
    return request({ url: '/quote/detail' });
  },
});`,
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, 'views/QuoteView.vue'),
      `<script setup lang="ts">
import { useQuoteStore } from '../stores/quoteStore';
const quoteStore = useQuoteStore();
function submit() { quoteStore.doQuote(); }
</script>`,
      'utf8',
    );
    const scan = await scanProject(dir, DEFAULT_CONFIG);
    const result = await frontendAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities: [] });

    const page = result.pages?.find((p) => p.component === 'QuoteView');
    expect(page).toBeDefined();
    expect(page?.stores).toContain('useQuoteStore');
    expect(page?.apiCalls).toEqual(expect.arrayContaining(['/quote/calc', '/quote/detail']));
  });

  it('inherits api-wrapper module URLs onto pages and drops pure template noise', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-frontend-import-api-'));
    await fs.mkdir(path.join(dir, 'api'), { recursive: true });
    await fs.mkdir(path.join(dir, 'views'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'api/orderApi.ts'),
      `import request from './request';
export const getOrder = (id: string) => request({ url: '/api/orders/' + id });
export const listOrders = () => axios.get('/api/orders');`,
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, 'views/OrderList.vue'),
      `<script setup lang="ts">
import { listOrders, getOrder } from '../api/orderApi';
const rows = listOrders();
</script>`,
      'utf8',
    );
    const scan = await scanProject(dir, DEFAULT_CONFIG);
    const result = await frontendAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities: [] });

    const page = result.pages?.find((p) => p.component === 'OrderList');
    expect(page).toBeDefined();
    expect(page?.apiCalls).toEqual(expect.arrayContaining(['/api/orders', '/api/orders/']));
  });
});

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
import axios from 'axios';
import { useOrderStore } from '../stores/orderStore';
import { postOrder } from '../api/orderApi';
const orderStore = useOrderStore();
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
      entities: [],
      rules: [],
      relations: [],
    });
    expect(result.pages?.[0]).toEqual(
      expect.objectContaining({ component: 'OrderEdit', stores: expect.arrayContaining(['useOrderStore']) }),
    );
    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ trigger: 'submit' }),
        expect.objectContaining({ trigger: 'click' }),
      ]),
    );
    expect(result.rules?.[0]?.rule.join(' ')).toContain('AUDIT');
    expect(result.rules?.[0]?.rule.join(' ')).toContain('order.edit');
    expect(result.rules?.[0]?.rule.join(' ')).toContain('Form validation');
    expect(result.workflows?.[0]?.steps).toEqual(
      expect.arrayContaining(['Action: submit', 'Action: save', 'State: AUDITING']),
    );
    expect(result.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'OrderEdit', relationship: 'triggers_action' }),
        expect.objectContaining({ relationship: 'action_updates_store', target: 'useOrderStore' }),
        expect.objectContaining({ relationship: 'action_calls_api', target: '/api/order' }),
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
});

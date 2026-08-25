import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanProject } from '../src/core/scanner.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { vueAnalyzer } from '../src/core/analyzers/vue.js';

const FULL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/full');

describe('vueAnalyzer', () => {
  it('parses <script lang="ts"> via the shared TS AST logic', async () => {
    const scan = await scanProject(FULL, DEFAULT_CONFIG);
    const result = await vueAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities: [], rules: [] });

    const order = (result.entities ?? []).find((e) => e.name === 'Order');
    expect(order).toBeDefined();
    expect(order?.confidence).toBe('high');
    expect(order?.attributes?.map((a) => a.name)).toEqual(expect.arrayContaining(['id', 'status']));
  });

  it('maps defineProps / defineEmits to entity attributes', async () => {
    const scan = await scanProject(FULL, DEFAULT_CONFIG);
    const result = await vueAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities: [], rules: [] });

    const list = (result.entities ?? []).find((e) => e.name === 'OrderList');
    expect(list).toBeDefined();
    const selected = list?.attributes?.find((a) => a.name === 'selected');
    expect(selected?.type).toContain('Order');
    expect(selected?.required).toBe(true);
    expect(list?.attributes?.some((a) => a.name === 'change' && a.type === 'emit')).toBe(true);
  });

  it('turns component imports into relations', async () => {
    const scan = await scanProject(FULL, DEFAULT_CONFIG);
    const result = await vueAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities: [], rules: [] });

    const rel = (result.relations ?? []).find((r) => r.source === 'OrderList' && r.target === 'OrderCard');
    expect(rel).toBeDefined();
    expect(rel?.relationship).toBe('renders');
    expect(rel?.evidence.some((f) => f.endsWith('OrderList.vue'))).toBe(true);
  });

  it('extracts template v-if / :disabled constraints as rules', async () => {
    const scan = await scanProject(FULL, DEFAULT_CONFIG);
    const result = await vueAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities: [], rules: [] });

    const rules = (result.rules ?? []).filter((r) => r.entity === 'OrderList');
    expect(rules.some((r) => r.name.includes('v-if'))).toBe(true);
    expect(rules.some((r) => r.name.includes(':disabled'))).toBe(true);
    for (const rule of rules) {
      expect(rule.confidence).toBe('low');
      expect(rule.status).toBe('candidate');
    }
  });

  it('aggregates repeated template constraints and keeps nearby context', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-vue-aggregate-'));
    await fs.writeFile(
      path.join(dir, 'OrderList.vue'),
      '<template><button v-if="canEdit">Edit</button><span v-if="canEdit">Edit hint</span><button :disabled="isLocked">Save</button><a :disabled="isLocked">Link</a></template>',
      'utf8',
    );

    const scan = await scanProject(dir, DEFAULT_CONFIG);
    const result = await vueAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities: [], rules: [] });
    const rules = result.rules ?? [];
    const ifRule = rules.find((rule) => rule.name.includes('v-if'));
    const disabledRule = rules.find((rule) => rule.name.includes(':disabled'));

    expect(rules).toHaveLength(2);
    expect(ifRule?.rule).toEqual(['Elements are rendered only when: canEdit.']);
    expect(ifRule?.context?.[0]).toContain('button v-if="canEdit"');
    expect(disabledRule?.rule).toEqual(['Controls are disabled when: isLocked.']);
    expect(disabledRule?.context?.[0]).toContain('button :disabled="isLocked"');
  });

  it('keeps rule ids unique across multiple components (no silent drops)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-vue-'));
    await fs.writeFile(
      path.join(dir, 'CompA.vue'),
      '<template><div v-if="a > 1">x</div></template>\n<script setup lang="ts">defineProps<{ a: number }>()</script>',
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, 'CompB.vue'),
      '<template><div v-if="b > 2">y</div></template>\n<script setup lang="ts">defineProps<{ b: number }>()</script>',
      'utf8',
    );

    const scan = await scanProject(dir, DEFAULT_CONFIG);
    const result = await vueAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities: [], rules: [] });

    const ifRules = (result.rules ?? []).filter((r) => r.name.includes('v-if'));
    expect(ifRules.length).toBe(2);
    const ids = new Set(ifRules.map((r) => r.id));
    expect(ids.size).toBe(2);
    expect(ifRules.map((r) => r.evidence[0]).sort()).toEqual(['CompA.vue', 'CompB.vue']);
  });
});

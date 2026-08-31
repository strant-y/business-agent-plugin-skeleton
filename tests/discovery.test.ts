import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discover } from '../src/core/discovery.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/sample');
const DEEP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/deep');

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ba-disc-'));
}

describe('discover', () => {
  it('detects entities from interface/class declarations', async () => {
    const manifest = await discover(FIXTURE, { dryRun: true });
    const names = manifest.entities.map((e) => e.name);
    expect(names).toContain('Product');
    expect(names).toContain('Order');
  });

  it('uses preferredEntities from config and marks them medium confidence', async () => {
    const config = { ...DEFAULT_CONFIG, analyzers: [], preferredEntities: ['Order'] };
    const manifest = await discover(FIXTURE, { dryRun: true, config });
    const order = manifest.entities.find((e) => e.name === 'Order');
    expect(order?.confidence).toBe('medium');
  });

  it('matches preferred entities on word boundaries only', async () => {
    const dir = await tempRoot();
    await fs.writeFile(path.join(dir, 'a.ts'), 'const Planning = 1;\ninterface RealThing {}', 'utf8');
    const config = { ...DEFAULT_CONFIG, preferredEntities: ['Plan', 'Planning'] };
    const manifest = await discover(dir, { dryRun: true, config });
    const names = manifest.entities.map((e) => e.name);
    expect(names).toContain('Planning');
    expect(names).not.toContain('Plan');
  });

  it('merges glossary aliases into one canonical entity and writes alias map', async () => {
    const dir = await tempRoot();
    await fs.mkdir(path.join(dir, '.agent/business'), { recursive: true });
    await fs.writeFile(path.join(dir, 'Order.ts'), 'export interface Order {}', 'utf8');
    await fs.writeFile(path.join(dir, 'OrderDTO.ts'), 'export interface OrderDTO {}', 'utf8');
    await fs.writeFile(
      path.join(dir, '.agent/business/glossary.md'),
      '| 术语 | 别名 | 实体 |\n| --- | --- | --- |\n| 缴费 | OrderDTO, orders | Order |\n',
      'utf8',
    );

    const manifest = await discover(dir, { dryRun: true, config: { ...DEFAULT_CONFIG, analyzers: [] } });
    expect(manifest.entities.filter((e) => e.name === 'Order')).toHaveLength(1);
    expect(manifest.entities.some((e) => e.name === 'OrderDTO')).toBe(false);
    expect(manifest.aliases?.Order).toEqual(expect.arrayContaining(['缴费', 'OrderDTO', 'orders']));
  });

  it('does not create relations from name-only co-occurrence', async () => {
    const dir = await tempRoot();
    await fs.writeFile(
      path.join(dir, 'a.ts'),
      'export interface Order {}\nexport interface Customer {}\nconst text = "Order Customer";\n',
      'utf8',
    );
    const manifest = await discover(dir, { dryRun: true, config: { ...DEFAULT_CONFIG, analyzers: [] } });
    expect(manifest.relations).toEqual([]);
  });

  it('detects relations between entities appearing near each other', async () => {
    const manifest = await discover(FIXTURE, { dryRun: true });
    const hasProductOrder = manifest.relations.some((r) => r.source === 'Product' && r.target === 'Order');
    expect(hasProductOrder).toBe(true);
  });

  it('records same-file evidence for co-occurrence relations and skips cross-file pairs', async () => {
    const dir = await tempRoot();
    // Product and Order co-occur with a structural hint inside ONE file -> relation with evidence.
    await fs.writeFile(
      path.join(dir, 'catalog.ts'),
      "import { Order } from './order';\nexport interface Product {}\nexport interface Order {}\nconst latest: Product[] = order.items;\n",
      'utf8',
    );
    // Customer and Invoice merely co-occur in a different file from the structural hint -> no relation.
    await fs.writeFile(path.join(dir, 'other.ts'), 'export interface Customer {}\n', 'utf8');
    await fs.writeFile(
      path.join(dir, 'invoice.ts'),
      'export interface Invoice {}\nconst text = "Customer Invoice";\n',
      'utf8',
    );
    const manifest = await discover(dir, { dryRun: true, config: { ...DEFAULT_CONFIG, analyzers: [] } });

    const productOrder = manifest.relations.find((r) => r.source === 'Product' && r.target === 'Order');
    expect(productOrder).toBeDefined();
    expect(productOrder?.evidence).toHaveLength(1);
    expect(productOrder?.evidence[0]).toMatch(/^catalog\.ts:\d+$/);

    const customerInvoice = manifest.relations.find((r) => r.source === 'Customer' && r.target === 'Invoice');
    expect(customerInvoice).toBeUndefined();
  });

  it('quotes the matched condition in rule text and extracts preconditions', async () => {
    const dir = await tempRoot();
    await fs.writeFile(
      path.join(dir, 'OrderService.ts'),
      "export class OrderService { update(order: Order) { if (admin && order.status === 'AUDIT') throw new OrderBusinessException('locked'); } }\n",
      'utf8',
    );
    const manifest = await discover(dir, { dryRun: true, config: { ...DEFAULT_CONFIG, analyzers: [] } });
    const stateRule = manifest.rules.find((rule) => rule.id === 'rule.discovery.validation-state');
    expect(stateRule).toBeDefined();
    expect(stateRule?.rule[0]).toContain('匹配条件');
    expect(stateRule?.rule[0]).toContain('order.status');
    expect(stateRule?.preconditions).toContain('order.status = AUDIT');
    expect(stateRule?.preconditions).toContain('role: admin');
  });

  it('extracts custom business exceptions as candidate rules', async () => {
    const dir = await tempRoot();
    await fs.writeFile(
      path.join(dir, 'OrderService.ts'),
      "export class OrderService { update(order: Order) { if (order.status === 'AUDIT') throw new OrderBusinessException('Order cannot be modified'); } }\n",
      'utf8',
    );
    const manifest = await discover(dir, { dryRun: true, config: { ...DEFAULT_CONFIG, analyzers: [] } });
    const exceptionRule = manifest.rules.find((rule) => rule.id === 'rule.discovery.thrown-error');
    expect(exceptionRule).toBeDefined();
    expect(exceptionRule?.rule[0]).toContain('Order cannot be modified');
    expect(exceptionRule?.confidence).toBe('medium');
  });

  it('attributes rule evidence to files that actually match', async () => {
    const manifest = await discover(FIXTURE, { dryRun: true });
    expect(manifest.rules.length).toBeGreaterThan(0);
    for (const rule of manifest.rules) {
      expect(rule.evidence.length).toBeGreaterThan(0);
      expect(rule.evidence[0]).toMatch(/\.(ts|sql|tsx|js|jsx|vue|java|xml)$/);
    }
  });

  it('writes manifest, entity markdown and index when not dry-run', async () => {
    const dir = await tempRoot();
    await fs.cp(FIXTURE, dir, { recursive: true });
    await discover(dir);

    const manifestFile = path.join(dir, '.agent/memory/discovery-manifest.json');
    expect(await fs.stat(manifestFile)).toBeDefined();

    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    expect(manifest.entities.length).toBeGreaterThan(0);

    for (const entity of manifest.entities) {
      const md = path.join(dir, '.agent/business/entities', `${entity.name.toLowerCase()}.md`);
      expect(await fs.stat(md)).toBeDefined();
    }

    const index = await fs.readFile(path.join(dir, '.agent/business/INDEX.md'), 'utf8');
    expect(index).toContain('Product');
  });

  it('writes candidate rules to memory/candidates instead of the confirmed rules store', async () => {
    const dir = await tempRoot();
    await fs.writeFile(
      path.join(dir, 'Service.ts'),
      'interface Order {}\nfunction check(): void { throw new Error("cannot modify audited order"); }',
      'utf8',
    );
    await discover(dir);

    const rulesDir = path.join(dir, '.agent/business/rules');
    const ruleFiles = (await fs.readdir(rulesDir).catch(() => [] as string[])).filter((f) => f.endsWith('.json'));
    expect(ruleFiles).toEqual([]);

    const candidatesDir = path.join(dir, '.agent/memory/candidates');
    const candidateFiles = (await fs.readdir(candidatesDir)).filter((f) => f.endsWith('.md'));
    expect(candidateFiles.length).toBeGreaterThan(0);
    const candidate = await fs.readFile(path.join(candidatesDir, candidateFiles[0]), 'utf8');
    expect(candidate).toContain('## Context');
  });

  it('preserves manual edits to entity files across discover runs', async () => {
    const dir = await tempRoot();
    await fs.cp(FIXTURE, dir, { recursive: true });
    await discover(dir);

    const productMd = path.join(dir, '.agent/business/entities', 'product.md');
    const original = await fs.readFile(productMd, 'utf8');
    await fs.writeFile(productMd, `${original}\n<!-- MANUAL EDIT -->\n`, 'utf8');

    const warnings: string[] = [];
    await discover(dir, { onWarning: (m) => warnings.push(m) });

    const after = await fs.readFile(productMd, 'utf8');
    expect(after).toContain('<!-- MANUAL EDIT -->');
    expect(warnings.join('\n')).toContain('Preserved manual edits');
  });

  it('captures full fileText for test matching during discovery', async () => {
    const dir = await tempRoot();
    await fs.writeFile(path.join(dir, 'Order.ts'), 'interface Order {}\n', 'utf8');
    await fs.mkdir(path.join(dir, 'tests'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'tests', 'order.test.ts'),
      "describe('Order rule', () => {\n  it('mentions AUDIT', () => expect('AUDIT').toBe('AUDIT'));\n});\n",
      'utf8',
    );

    const manifest = await discover(dir, { dryRun: true, config: { ...DEFAULT_CONFIG, analyzers: [] } });
    expect(manifest.tests).toEqual(expect.arrayContaining(['tests\\order.test.ts']));
  });

  it('honors the maxEntities config limit', async () => {
    const dir = await tempRoot();
    await fs.writeFile(path.join(dir, 'A1.ts'), 'interface A1 {}\n', 'utf8');
    await fs.writeFile(path.join(dir, 'B2.ts'), 'interface B2 {}\n', 'utf8');
    await fs.writeFile(path.join(dir, 'C3.ts'), 'interface C3 {}\n', 'utf8');
    const config = { ...DEFAULT_CONFIG, maxEntities: 2 };
    const manifest = await discover(dir, { dryRun: true, config });
    expect(manifest.entities.length).toBeLessThanOrEqual(2);
  });

  it('builds fieldIndex entries from SQL attributes', async () => {
    const manifest = await discover(DEEP, { dryRun: true });
    expect(manifest.fieldIndex?.['order.status']).toMatchObject({ entity: 'Order', field: 'status' });
    const fieldEvidence = (key: string) =>
      manifest.fieldIndex?.[key]?.evidence?.map((file) => file.replaceAll('\\', '/'));
    expect(fieldEvidence('order.status')).toEqual(expect.arrayContaining(['db/schema.sql', 'db/schema.sql:9']));
    expect(manifest.fieldIndex?.['order.customer_id']).toMatchObject({ entity: 'Order', field: 'customer_id' });
    expect(fieldEvidence('order.customer_id')).toEqual(expect.arrayContaining(['db/schema.sql', 'db/schema.sql:8']));
    expect(manifest.fieldIndex?.['auditlog.event_type']).toMatchObject({ entity: 'AuditLog', field: 'event_type' });
    expect(fieldEvidence('auditlog.event_type')).toEqual(expect.arrayContaining(['db/schema.sql', 'db/schema.sql:15']));
  });

  it('matches covering tests through entity aliases and plural forms', async () => {
    const dir = await tempRoot();
    await fs.mkdir(path.join(dir, '.agent', 'business', 'rules'), { recursive: true });
    await fs.writeFile(path.join(dir, 'Order.ts'), 'export interface Order { status: string }\n', 'utf8');
    await fs.writeFile(path.join(dir, 'orders.ts'), 'export interface Orders { status: string }\n', 'utf8');
    await fs.mkdir(path.join(dir, 'tests'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'tests', 'order-rule.test.ts'),
      "it('缴费 orders must be APPROVED', () => expect('APPROVED').toBe('APPROVED'));\n",
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, '.agent', 'business', 'glossary.md'),
      '| 术语 | 别名 | 实体 |\n| --- | --- | --- |\n| 缴费 | premium_payment | Order |\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, '.agent', 'business', 'rules', 'rule-order-approved.json'),
      JSON.stringify({
        id: 'rule.order-approved',
        name: 'Order approval rule',
        entity: 'Order',
        rule: ['Order must be APPROVED before shipment'],
        confidence: 'high',
        evidence: ['Order.ts'],
        status: 'confirmed',
      }),
      'utf8',
    );
    const manifest = await discover(dir, { dryRun: true, config: { ...DEFAULT_CONFIG, analyzers: [] } });
    expect(manifest.rules.find((rule) => rule.id === 'rule.order-approved')?.coveringTests).toEqual([
      'tests\\order-rule.test.ts',
    ]);
  });

  it('rebuilds coveringTests for persisted confirmed rules without broad unknown matches', async () => {
    const dir = await tempRoot();
    await fs.mkdir(path.join(dir, '.agent', 'business', 'rules'), { recursive: true });
    await fs.writeFile(path.join(dir, 'Order.ts'), 'export interface Order { status: string }\n', 'utf8');
    await fs.mkdir(path.join(dir, 'tests'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'tests', 'order-rule.test.ts'),
      "it('mentions APPROVED for Order', () => expect('APPROVED').toBe('APPROVED'));\n",
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, 'tests', 'product-rule.test.ts'),
      "it('mentions APPROVED for Product', () => expect('APPROVED').toBe('APPROVED'));\n",
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, '.agent', 'business', 'rules', 'rule-order-approved.json'),
      JSON.stringify(
        {
          id: 'rule.order-approved',
          name: 'Order approval rule',
          entity: 'Order',
          rule: ['Order must be APPROVED before shipment'],
          confidence: 'high',
          evidence: ['Order.ts'],
          status: 'confirmed',
        },
        null,
        2,
      ),
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, '.agent', 'business', 'rules', 'rule-unknown-approved.json'),
      JSON.stringify(
        {
          id: 'rule.unknown-approved',
          name: 'Unknown approval rule',
          entity: 'Unknown',
          rule: ['Request must be APPROVED before submission'],
          confidence: 'medium',
          evidence: ['Service.ts'],
          status: 'confirmed',
        },
        null,
        2,
      ),
      'utf8',
    );

    const manifest = await discover(dir, { dryRun: true, config: { ...DEFAULT_CONFIG, analyzers: [] } });
    const confirmed = manifest.rules.find((rule) => rule.id === 'rule.order-approved');
    expect(confirmed?.coveringTests).toEqual(['tests\\order-rule.test.ts']);

    const unknown = manifest.rules.find((rule) => rule.id === 'rule.unknown-approved');
    expect(unknown?.coveringTests).toBeUndefined();
  });

  it('copies discovered lifecycle states onto the entity (G1.5)', async () => {
    const dir = await tempRoot();
    await fs.writeFile(
      path.join(dir, 'Order.ts'),
      [
        'export interface Order { id: string; status: string }',
        '',
        'export function submit(order: Order): void {',
        "  if (order.status === 'DRAFT') {",
        "    order.status = 'AUDIT';",
        '  }',
        "  if (order.status === 'AUDIT') {",
        "    order.status = 'APPROVED';",
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const manifest = await discover(dir, { dryRun: true, config: { ...DEFAULT_CONFIG, analyzers: ['states'] } });
    const machine = manifest.states?.find((item) => item.entity.toLowerCase() === 'order');
    expect(machine).toBeDefined();

    const order = manifest.entities.find((entity) => entity.name.toLowerCase() === 'order');
    expect(order?.states).toBeDefined();
    expect(order?.states).toEqual(expect.arrayContaining(machine?.states ?? []));
  });

  it('describes discovered entities with their evidence instead of a bare template (G1.2)', async () => {
    const dir = await tempRoot();
    await fs.writeFile(path.join(dir, 'Order.ts'), 'export interface Order { id: string; status: string }\n', 'utf8');

    const manifest = await discover(dir, { dryRun: true, config: { ...DEFAULT_CONFIG, analyzers: [] } });
    const order = manifest.entities.find((entity) => entity.name === 'Order');

    expect(order?.description).not.toBe('Discovered business candidate: Order');
    expect(order?.description).toContain('Order');
    expect(order?.description).toContain('Order.ts');
  });

  it('sanitizes relation ids with special characters so the manifest validates', async () => {
    const dir = await tempRoot();
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'src/order.ts'),
      'export interface Order { id: string; status: string }\nexport const orderStatus: Record<string, string> = {};\n',
      'utf8',
    );
    const manifest = await discover(dir, { dryRun: true, config: { ...DEFAULT_CONFIG, analyzers: ['sql', 'ast'] } });
    for (const relation of manifest.relations) {
      expect(relation.id).toMatch(/^relation\.[a-z0-9._-]+$/);
    }
    expect(manifest.relations.some((r) => r.id.includes(':') || r.id.includes('/'))).toBe(false);
  });

  it('attaches discovery rules to business entities instead of framework types', async () => {
    const dir = await tempRoot();
    await fs.writeFile(
      path.join(dir, 'CustomerSection.vue'),
      '<template><button :disabled="submitting">Save</button></template><script setup lang="ts">interface Props { submitting: boolean } const submitting = ref(false);</script>',
      'utf8',
    );
    const manifest = await discover(dir, { dryRun: true, config: { ...DEFAULT_CONFIG, analyzers: [] } });
    const disabledRule = manifest.rules.find((rule) => rule.id === 'rule.discovery.disabled-control');
    expect(disabledRule).toBeDefined();
    expect(disabledRule?.entity).not.toBe('Props');
    expect(['CustomerSection', 'Unknown']).toContain(disabledRule?.entity);
  });
});

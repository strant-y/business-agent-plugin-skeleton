import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discover } from '../src/core/discovery.js';
import { buildImpactReport, impactMarkdown } from '../src/core/impact.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';

async function setupProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-openapi-'));
  await fs.mkdir(path.join(dir, 'src/api'), { recursive: true });
  await fs.mkdir(path.join(dir, 'contracts'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'src/api/orderApi.ts'),
    [
      "export interface Order {",
      '  id: number;',
      '  status: string;',
      '  total: number;',
      '}',
      '',
      "router.get('/api/orders', () => undefined);",
      "router.post('/api/orders', () => undefined);",
      '',
      'export async function getOrder(): Promise<Order> {',
      "  return request('GET', '/api/orders');",
      '}',
      '',
      'export async function saveOrder(): Promise<Order> {',
      "  return request('POST', '/api/orders');",
      '}',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'contracts/openapi.json'),
    JSON.stringify(
      {
        openapi: '3.0.0',
        paths: {
          '/api/orders': {
            get: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: { $ref: '#/components/schemas/Order' },
                    },
                  },
                },
              },
            },
          },
          '/api/order-history': {
            get: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: { $ref: '#/components/schemas/OrderHistory' },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            Order: {
              type: 'object',
              required: ['id', 'status'],
              properties: {
                id: { type: 'integer' },
                status: { type: 'string' },
                amount: { type: 'number' },
              },
            },
            OrderHistory: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
              },
            },
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  return dir;
}

const API_DIFF = `diff --git a/src/api/orderApi.ts b/src/api/orderApi.ts
index 3333333..4444444 100644
--- a/src/api/orderApi.ts
+++ b/src/api/orderApi.ts
@@ -6,3 +6,3 @@
-export async function getOrder(): Promise<Order> {
-  return request('GET', '/api/orders');
+export async function getOrder(): Promise<OrderHistory> {
+  return request('GET', '/api/order-history');
 }
`;

describe('openapi analyzer', () => {
  it('does not warn for matched GET code routes', async () => {
    const dir = await setupProject();
    const warnings: string[] = [];
    const manifest = await discover(dir, {
      dryRun: true,
      config: { ...DEFAULT_CONFIG, analyzers: ['ast', 'api', 'openapi'] },
      onWarning: (message) => warnings.push(message),
    });

    expect(manifest.apis?.map((api) => `${api.method} ${api.path}`)).toEqual(
      expect.arrayContaining(['GET /api/orders', 'GET /api/order-history']),
    );
    const getOrdersWarnings = warnings.filter((message) => message.includes('GET /api/orders'));
    expect(getOrdersWarnings).toEqual([]);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Code route missing from OpenAPI contract: POST /api/orders'),
        expect.stringContaining('OpenAPI schema mismatch for entity Order'),
      ]),
    );
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('OpenAPI contract route missing from code: GET /api/order-history'),
      ]),
    );
  });

  it('reports only actual contract drift during discovery', async () => {
    const dir = await setupProject();
    const warnings: string[] = [];
    const manifest = await discover(dir, {
      dryRun: true,
      config: { ...DEFAULT_CONFIG, analyzers: ['ast', 'api', 'openapi'] },
      onWarning: (message) => warnings.push(message),
    });

    expect(manifest.apis?.map((api) => `${api.method} ${api.path}`)).toEqual(
      expect.arrayContaining(['GET /api/orders', 'GET /api/order-history']),
    );
    expect(manifest.entities.map((entity) => entity.name)).toContain('Order');
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('OpenAPI contract route missing from code: GET /api/order-history'),
        expect.stringContaining('Code route missing from OpenAPI contract: POST /api/orders'),
        expect.stringContaining('OpenAPI schema mismatch for entity Order'),
      ]),
    );
    expect(warnings).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining('OpenAPI contract route missing from code: GET /api/orders'),
      ]),
    );
  });

  it('reports contract drift in impact risks for API changes', async () => {
    const dir = await setupProject();
    await discover(dir, {
      config: { ...DEFAULT_CONFIG, analyzers: ['ast', 'api', 'openapi'] },
    });

    const report = await buildImpactReport(dir, ['src/api/orderApi.ts'], API_DIFF);
    expect(report.contractDrift.some((risk) => risk.includes('契约漂移'))).toBe(true);
    expect(report.risks.some((risk) => risk.includes('契约漂移'))).toBe(true);
    const markdown = impactMarkdown(report);
    expect(markdown).toContain('契约漂移');
  });
});

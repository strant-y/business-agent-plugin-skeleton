import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import type { AgentConfig } from '../src/core/config.js';
import { buildRulesPrompt, selectRuleSnippets, llmRulesAnalyzer } from '../src/core/analyzers/llm-rules.js';
import type { ProjectScan } from '../src/core/scanner.js';

const SNIPPETS = [
  { file: 'service.ts', text: 'if (status === "AUDIT") { throw new Error("no edits under audit"); }' },
  { file: 'Order.vue', text: '<button :disabled="order.locked">Save</button>' },
];

const SCAN: ProjectScan = {
  files: ['service.ts', 'Order.vue'],
  sampleText: '',
  samples: SNIPPETS,
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  delete process.env.TEST_LLM_KEY;
  globalThis.fetch = originalFetch;
});

describe('buildRulesPrompt', () => {
  it('embeds file-attributed snippets', () => {
    const prompt = buildRulesPrompt(SNIPPETS);
    expect(prompt).toContain('--- service.ts ---');
    expect(prompt).toContain('AUDIT');
  });
});

describe('selectRuleSnippets', () => {
  it('prioritizes business-signal files over a blind prefix', () => {
    const samples = [
      { file: 'a.ts', text: 'const x = 1;' },
      { file: 'b.ts', text: 'const y = 2;' },
      { file: 'c.ts', text: 'const z = 3;' },
      { file: 'd.ts', text: 'if (order.status === "AUDIT") { throw new Error("locked"); }' },
      { file: 'e.ts', text: 'const w = 4;' },
    ];
    const picked = selectRuleSnippets(samples, 3);
    expect(picked.map((s) => s.file)).toEqual(['d.ts', 'a.ts', 'b.ts']);
  });

  it('keeps stable deterministic order within groups and respects the limit', () => {
    const samples = [
      { file: 'a.ts', text: 'x' },
      { file: 'b.ts', text: 'if (status === "DRAFT") {}' },
      { file: 'c.ts', text: 'y' },
      { file: 'd.ts', text: 'if (status === "PENDING") {}' },
    ];
    const first = selectRuleSnippets(samples, 3).map((s) => s.file);
    const second = selectRuleSnippets(samples, 3).map((s) => s.file);
    expect(first).toEqual(['b.ts', 'd.ts', 'a.ts']);
    expect(second).toEqual(first);
  });
});

describe('llmRulesAnalyzer', () => {
  it('returns nothing when no LLM config is present', async () => {
    const result = await llmRulesAnalyzer.analyze(SCAN, { config: DEFAULT_CONFIG, entities: [], rules: [] });
    expect(result).toEqual({});
  });

  it('parses LLM-extracted rules and relations as low-confidence candidates', async () => {
    process.env.TEST_LLM_KEY = 'sk-test';
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    rules: [
                      {
                        entity: 'Order',
                        name: 'No edits under audit',
                        rule: ['No edits while status is AUDIT'],
                        evidence: ['Order.vue'],
                      },
                    ],
                    relations: [
                      {
                        source: 'Order',
                        target: 'Customer',
                        relationship: 'references',
                        description: 'Order belongs to Customer',
                      },
                    ],
                  }),
                },
              },
            ],
          }),
      })) as unknown as typeof fetch;

    const config: AgentConfig = {
      ...DEFAULT_CONFIG,
      llm: {
        provider: 'openai-compatible',
        model: 'm',
        baseUrl: 'https://example.com/v1',
        apiKeyEnv: 'TEST_LLM_KEY',
        allowSourceUpload: true,
      },
    };
    const result = await llmRulesAnalyzer.analyze(SCAN, { config, entities: [], rules: [] });

    const rule = (result.rules ?? []).find((r) => r.entity === 'Order');
    expect(rule).toBeDefined();
    expect(rule?.confidence).toBe('low');
    expect(rule?.status).toBe('candidate');
    expect(rule?.evidence).toContain('Order.vue');

    const relation = (result.relations ?? []).find((r) => r.source === 'Order' && r.target === 'Customer');
    expect(relation).toBeDefined();
    expect(relation?.confidence).toBe('low');
  });
});

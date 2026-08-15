import type { Analyzer, AnalyzeResult } from '../analyzer.js';
import type { BusinessRule, Relation } from '../types.js';
import { completeLlm } from './llm.js';

export function buildRulesPrompt(snippets: Array<{ file: string; text: string }>): string {
  const lines = snippets.map((s) => `--- ${s.file} ---\n${s.text.slice(0, 1200)}`);
  return [
    'You are a business analyst for a codebase. Extract business rules and relationships from the code snippets below.',
    'Rules: conditional constraints, state guards, validation, disabled controls, thrown errors.',
    'Relationships: entity references between types, tables, components, or API calls.',
    'Respond with a single JSON object of the shape {"rules":[{"entity":"Name","name":"...","rule":["..."],"evidence":["file"]}],"relations":[{"source":"Name","target":"Name","relationship":"...","cardinality":"unknown","description":"..."}]}.',
    'Use entity names exactly as written (PascalCase for classes/interfaces, table names as-is). No markdown.',
    'Snippets:',
    ...lines,
  ].join('\n');
}

/** Files likely to carry business rules (status branches, validation, disabled controls, throws). */
const BUSINESS_SIGNAL =
  /\b(status|audit|approve|approved|reject|rejected|draft|pending|submit|validate|validation|throw\s+new|disabled|v-if|required|forbidden|permission|role)\b|不能|必须|禁止|不可|审核|状态|允许|校验/i;

/**
 * Pick the snippets most likely to contain business knowledge instead of a
 * blind prefix of the (sorted) sample list. Signal-bearing files come first;
 * order stays stable and deterministic within each group.
 */
export function selectRuleSnippets(
  samples: Array<{ file: string; text: string }>,
  limit = 12,
): Array<{ file: string; text: string }> {
  const scored = samples.map((s) => ({ s, hit: BUSINESS_SIGNAL.test(s.text) ? 1 : 0 }));
  // Array.prototype.sort is stable, so equal scores keep their original order.
  return scored
    .sort((a, b) => b.hit - a.hit)
    .slice(0, Math.max(1, limit))
    .map((x) => x.s);
}

interface LlmRule {
  entity?: string;
  name?: string;
  rule?: string[];
  evidence?: string[];
}

interface LlmRelation {
  source?: string;
  target?: string;
  relationship?: string;
  cardinality?: '1:1' | '1:N' | 'N:1' | 'N:M' | 'unknown';
  description?: string;
}

interface LlmPayload {
  rules?: LlmRule[];
  relations?: LlmRelation[];
}

const CARDINALITY = new Set(['1:1', '1:N', 'N:1', 'N:M', 'unknown']);

export const llmRulesAnalyzer: Analyzer = {
  name: 'llm-rules',
  async analyze(scan, ctx) {
    const config = ctx.config.llm;
    if (!config) return {};

    const snippets = selectRuleSnippets(scan.samples);
    const content = await completeLlm(buildRulesPrompt(snippets), config);
    if (!content) return {};

    let parsed: LlmPayload;
    try {
      parsed = JSON.parse(content.trim().replace(/^```json?|```$/g, '')) as LlmPayload;
    } catch {
      return {};
    }

    const rules: BusinessRule[] = (parsed.rules ?? []).map((r, i) => {
      const ruleLines = r.rule ?? [];
      const evidence = r.evidence ?? [];
      return {
        id: `rule.llm-rules.${i}`,
        name: r.name || `LLM-extracted rule ${i}`,
        entity: r.entity || 'Unknown',
        rule: ruleLines.length ? ruleLines : ['LLM-extracted candidate rule; verify manually.'],
        confidence: 'low' as const,
        evidence: evidence.length ? evidence : ['LLM extraction; needs manual verification'],
        status: 'candidate' as const,
      };
    });

    const relations: Relation[] = (parsed.relations ?? []).map((r, i) => ({
      id: `relation.llm-rules.${i}`,
      source: r.source || 'Unknown',
      target: r.target || 'Unknown',
      relationship: r.relationship || 'references',
      cardinality: CARDINALITY.has(r.cardinality ?? '') ? (r.cardinality as Relation['cardinality']) : 'unknown',
      description: r.description,
      confidence: 'low',
      evidence: ['LLM extraction; needs manual verification'],
    }));

    const result: AnalyzeResult = {};
    if (rules.length) result.rules = rules;
    if (relations.length) result.relations = relations;
    return result;
  },
};

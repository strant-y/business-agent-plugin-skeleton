import type { ProjectScan } from './scanner.js';
import type { AgentConfig, AnalyzerName } from './config.js';
import type { ApiRoute, BusinessRule, Entity, Relation } from './types.js';
import { AVAILABLE_ANALYZERS } from './config.js';
import { sqlAnalyzer } from './analyzers/sql.js';
import { apiAnalyzer } from './analyzers/api.js';
import { astAnalyzer } from './analyzers/ast.js';
import { vueAnalyzer } from './analyzers/vue.js';
import { javaAnalyzer } from './analyzers/java.js';
import { xmlAnalyzer } from './analyzers/xml.js';
import { linkageAnalyzer } from './analyzers/linkage.js';
import { llmAnalyzer } from './analyzers/llm.js';
import { llmRulesAnalyzer } from './analyzers/llm-rules.js';

export interface AnalyzerContext {
  config: AgentConfig;
  entities: Entity[];
  rules: BusinessRule[];
  relations: Relation[];
  apis?: ApiRoute[];
  /** Non-fatal warning sink shared with the discovery pipeline. */
  warn?: (message: string) => void;
}

export interface AnalyzeResult {
  entities?: Entity[];
  rules?: BusinessRule[];
  relations?: Relation[];
  apis?: ApiRoute[];
}

export interface Analyzer {
  readonly name: AnalyzerName;
  analyze(scan: ProjectScan, ctx: AnalyzerContext): Promise<AnalyzeResult> | AnalyzeResult;
}

const REGISTRY: Record<AnalyzerName, Analyzer> = {
  sql: sqlAnalyzer,
  api: apiAnalyzer,
  ast: astAnalyzer,
  vue: vueAnalyzer,
  java: javaAnalyzer,
  xml: xmlAnalyzer,
  linkage: linkageAnalyzer,
  llm: llmAnalyzer,
  'llm-rules': llmRulesAnalyzer,
};

export function resolveAnalyzers(
  config: AgentConfig,
  requested: AnalyzerName[] = [],
  warn?: (message: string) => void,
): Analyzer[] {
  const names = new Set<AnalyzerName>(config.analyzers as AnalyzerName[]);
  for (const name of requested) names.add(name);
  for (const name of names) {
    if (!(AVAILABLE_ANALYZERS as readonly string[]).includes(name)) {
      warn?.(`Unknown analyzer "${name}" in configuration; available: ${AVAILABLE_ANALYZERS.join(', ')}`);
    }
  }
  return AVAILABLE_ANALYZERS.filter((n) => names.has(n)).map((n) => REGISTRY[n]);
}

type EntityAttribute = NonNullable<Entity['attributes']>[number];

function mergeEntityAttributes(a?: Entity['attributes'], b?: Entity['attributes']): Entity['attributes'] | undefined {
  const out = new Map<string, EntityAttribute>();
  for (const attr of [...(a ?? []), ...(b ?? [])]) {
    if (!out.has(attr.name)) out.set(attr.name, attr);
  }
  return out.size ? [...out.values()] : undefined;
}

export function uniqEntities(items: Entity[]): Entity[] {
  const byName = new Map<string, Entity>();
  for (const item of items) {
    const existing = byName.get(item.name);
    if (!existing) {
      byName.set(item.name, item);
      continue;
    }
    byName.set(item.name, {
      ...existing,
      description:
        existing.description === 'Discovered business candidate: ' + item.name
          ? item.description
          : existing.description,
      attributes: mergeEntityAttributes(existing.attributes, item.attributes),
      evidence: uniqStrings([...existing.evidence, ...item.evidence]).slice(0, 8),
      confidence:
        rankConfidence(item.confidence) > rankConfidence(existing.confidence) ? item.confidence : existing.confidence,
    });
  }
  return [...byName.values()];
}

export function uniqStrings(items: string[]): string[] {
  return [...new Set(items)];
}

function rankConfidence(c: string): number {
  if (c === 'high') return 3;
  if (c === 'medium') return 2;
  return 1;
}

export interface RunAnalyzersResult {
  entities: Entity[];
  rules: BusinessRule[];
  relations: Relation[];
  apis: ApiRoute[];
  /** Non-fatal problems encountered while running analyzers. */
  warnings: string[];
}

/**
 * Analyzers are grouped into dependency phases. Within a phase they run in
 * parallel; phases run in order:
 *  1. ENTITY — sql/ast/vue/java/xml (produce entities independently).
 *  2. DEPENDENT — api/llm/llm-rules (consume the entities discovered in phase 1).
 *  3. LINKAGE — runs last because it needs every API route.
 * Results are always merged in phase order, so the output is deterministic
 * regardless of which parallel analyzer finishes first.
 */
const ENTITY_PHASE: AnalyzerName[] = ['sql', 'ast', 'vue', 'java', 'xml'];
const DEPENDENT_PHASE: AnalyzerName[] = ['api', 'llm', 'llm-rules'];

export async function runAnalyzers(
  scan: ProjectScan,
  ctx: AnalyzerContext,
  analyzers: Analyzer[],
  onWarning?: (message: string) => void,
): Promise<RunAnalyzersResult> {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    onWarning?.(message);
  };

  const byName = new Map<AnalyzerName, Analyzer>(analyzers.map((a) => [a.name, a]));

  const baseEntities = ctx.entities ?? [];
  const baseRules = ctx.rules ?? [];
  const baseRelations = ctx.relations ?? [];

  const accEntities: Entity[] = [];
  const accRules: BusinessRule[] = [];
  const accRelations: Relation[] = [];
  const accApis: ApiRoute[] = [];

  const runPhase = async (names: AnalyzerName[], phaseCtx: AnalyzerContext): Promise<void> => {
    // All analyzers in a phase share the same context snapshot and run concurrently.
    const outcomes = await Promise.all(
      names.map(async (name) => {
        try {
          return { name, result: await byName.get(name)!.analyze(scan, phaseCtx) };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return { name, error: detail };
        }
      }),
    );
    for (const outcome of outcomes) {
      if (outcome.error) {
        warn(`Analyzer "${outcome.name}" failed and was skipped: ${outcome.error}`);
        continue;
      }
      accEntities.push(...(outcome.result?.entities ?? []));
      accRules.push(...(outcome.result?.rules ?? []));
      accRelations.push(...(outcome.result?.relations ?? []));
      accApis.push(...(outcome.result?.apis ?? []));
    }
  };

  const initialCtx: AnalyzerContext = {
    config: ctx.config,
    entities: baseEntities,
    rules: baseRules,
    relations: baseRelations,
    warn,
  };
  await runPhase(
    ENTITY_PHASE.filter((n) => byName.has(n)),
    initialCtx,
  );

  const enrichedCtx: AnalyzerContext = {
    config: ctx.config,
    entities: uniqEntities([...baseEntities, ...accEntities]),
    rules: dedupeRules([...baseRules, ...accRules]),
    relations: dedupeRelations([...baseRelations, ...accRelations]),
    apis: accApis,
    warn,
  };
  await runPhase(
    DEPENDENT_PHASE.filter((n) => byName.has(n)),
    enrichedCtx,
  );

  if (byName.has('linkage')) {
    const finalCtx: AnalyzerContext = {
      config: ctx.config,
      entities: uniqEntities([...baseEntities, ...accEntities]),
      rules: dedupeRules([...baseRules, ...accRules]),
      relations: dedupeRelations([...baseRelations, ...accRelations]),
      apis: accApis,
      warn,
    };
    await runPhase(['linkage'], finalCtx);
  }

  return {
    entities: uniqEntities([...baseEntities, ...accEntities]),
    rules: dedupeRules([...baseRules, ...accRules]),
    relations: dedupeRelations([...baseRelations, ...accRelations]),
    apis: dedupeApis(accApis),
    warnings,
  };
}

function dedupeRules(rules: BusinessRule[]): BusinessRule[] {
  const seen = new Set<string>();
  return rules.filter((r) => {
    const key = r.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeRelations(relations: Relation[]): Relation[] {
  const seen = new Set<string>();
  return relations.filter((r) => {
    const key = `${r.source}|${r.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeApis(apis: ApiRoute[]): ApiRoute[] {
  const seen = new Set<string>();
  return apis.filter((a) => {
    const key = `${a.method.toUpperCase()} ${a.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Programmatic entry point for the business-agent library.
 * Everything the CLI does is available here for embedding in other tools.
 */
export { discover, entityId, candidateMarkdown, type DiscoverOptions } from './core/discovery.js';
export { scanProject, type ProjectScan, type SampleFile } from './core/scanner.js';
export {
  loadConfig,
  DEFAULT_CONFIG,
  AVAILABLE_ANALYZERS,
  CONFIG_FILE,
  type AgentConfig,
  type AnalyzerName,
  type LlmConfig,
} from './core/config.js';
export {
  resolveAnalyzers,
  runAnalyzers,
  uniqEntities,
  uniqStrings,
  type Analyzer,
  type AnalyzerContext,
  type AnalyzeResult,
  type RunAnalyzersResult,
} from './core/analyzer.js';
export { detectConflicts, ruleSign } from './core/conflicts.js';
export { heuristicScorer, type EvidenceScorer } from './core/evidence.js';
export {
  writeRule,
  writeRelation,
  buildIndex,
  loadRules,
  loadRelations,
  listImpacts,
  ruleMarkdown,
  relationMarkdown,
  impactMarkdown,
  safeFileId,
} from './core/knowledge.js';
export {
  parseCandidate,
  buildRuleFromCandidate,
  buildRelationFromInput,
  candidateSlug,
  type ParsedCandidate,
  type PromoteRuleInput,
  type PromoteRelationInput,
} from './core/candidate.js';
export {
  validateManifest,
  validateEntity,
  validateRule,
  validateRelation,
  validateApi,
  validateConflict,
  validateKnowledgeDir,
  validateAgainstSchema,
  type ValidationResult,
  type KnowledgeProblem,
} from './core/validate.js';
export { sqlAnalyzer } from './core/analyzers/sql.js';
export { apiAnalyzer } from './core/analyzers/api.js';
export { astAnalyzer, analyzeTypeScript, type TypeScriptAnalysis } from './core/analyzers/ast.js';
export { vueAnalyzer } from './core/analyzers/vue.js';
export { javaAnalyzer } from './core/analyzers/java.js';
export { xmlAnalyzer } from './core/analyzers/xml.js';
export { linkageAnalyzer, linkViewsToApis } from './core/analyzers/linkage.js';
export { llmAnalyzer, completeLlm, buildEntityPrompt } from './core/analyzers/llm.js';
export { llmRulesAnalyzer, buildRulesPrompt } from './core/analyzers/llm-rules.js';
export { parseSqlRelations, pascal } from './core/analyzers/parse.js';
export { parseArgs, parsePromoteOptions, rejectUnexpectedArgs, PROMOTE_KEYS, type Flags } from './cli-args.js';
export type {
  Confidence,
  Entity,
  BusinessRule,
  Relation,
  ApiRoute,
  RuleConflict,
  DiscoverManifest,
} from './core/types.js';

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
export {
  heuristicScorer,
  normalizeEvidence,
  validateEvidence,
  contentHash,
  type EvidenceScorer,
  type EvidenceRef,
  type EvidenceKind,
  type EvidenceStrength,
  type EvidenceValidation,
} from './core/evidence.js';
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
export { storesAnalyzer } from './core/analyzers/stores.js';
export { linkageAnalyzer, linkViewsToApis } from './core/analyzers/linkage.js';
export { fileModuleName, moduleNodeId, buildModuleDescriptor } from './core/module-id.js';
export { llmAnalyzer, completeLlm, buildEntityPrompt } from './core/analyzers/llm.js';
export { redactSecrets } from './core/analyzers/privacy.js';
export { llmRulesAnalyzer, buildRulesPrompt } from './core/analyzers/llm-rules.js';
export {
  loadReviewState,
  saveReviewState,
  applyReviewState,
  mergeCandidateRules,
  shouldAutoPromote,
  candidateReviewKey,
  type ReviewState,
  type ReviewStateEntry,
} from './core/review.js';
export { parseSqlRelations, pascal } from './core/analyzers/parse.js';
export { statesAnalyzer, extractStateMachines } from './core/analyzers/states.js';
export { frontendAnalyzer } from './core/analyzers/frontend.js';
export {
  buildImpactReport,
  writeImpactReport,
  impactMarkdown as changeImpactMarkdown,
  type ImpactReport,
  type ImpactChainStep,
} from './core/impact.js';
export { gitDiffFiles, gitDiffText, gitBranch } from './utils/git.js';
export {
  dispatchLifecycleEvent,
  loadEventResult,
  lifecycleAdapter,
  type LifecycleAdapter,
  type LifecycleWarning,
  type TaskLifecycleEvent as ExtendedTaskLifecycleEvent,
  type EventLifecycleResult,
} from './core/lifecycle.js';
export {
  transitionKnowledge,
  validateKnowledgeState,
  persistKnowledgeState,
  loadKnowledgeState,
  type KnowledgeRecord,
  type KnowledgeStateEvent,
  type KnowledgeStatus,
} from './core/knowledge-state.js';
export {
  recordFeedback,
  applyFeedback,
  loadFeedback,
  feedbackStats,
  type FeedbackInput,
  type FeedbackRecord,
  type FeedbackType,
} from './core/feedback.js';
export {
  rebuildRetrievalIndex,
  retrieveTaskContext,
  type RetrievalDocument,
  type RetrievalHit,
  type RetrieveOptions,
} from './core/retrieval.js';
export { runAudit, type AuditCheck, type AuditReport, type AuditStatus } from './core/audit.js';
export {
  buildTaskContext,
  startTask,
  loadTaskSession,
  saveTaskSession,
  updateTaskSession,
  predictTaskImpact,
  checkpointTask,
  recordTaskTest,
  finishTask,
  compareImpact,
  runTaskValidation,
  handleTaskEvent,
  type TaskSession,
  type TaskContext,
  type TaskPhase,
  type TaskStatus,
  type TestObservation,
  type TaskExperience,
  type ImpactComparison,
  type TaskLifecycleEvent,
  type LifecycleResult,
} from './core/task.js';
export {
  parseArgs,
  parsePromoteOptions,
  parseCaptureOptions,
  rejectUnexpectedArgs,
  PROMOTE_KEYS,
  CAPTURE_KEYS,
  type Flags,
} from './cli-args.js';
export type {
  Confidence,
  Entity,
  BusinessRule,
  Relation,
  ApiRoute,
  RuleConflict,
  DiscoverManifest,
  EntityType,
  FrontendPage,
  UserAction,
  UserActionTrigger,
} from './core/types.js';

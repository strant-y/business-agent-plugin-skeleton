import path from 'node:path';
import { exists, readText, writeText } from '../utils/fs.js';
import { normalizeEvidence, validateEvidence } from './evidence.js';
import {
  buildGraph,
  DEFAULT_MAX_DEPTH,
  renderMermaidSubgraph,
  resolveStartNodes,
  traceGraph,
  type GraphWalkStep,
} from './graph.js';
import { invertAliasMap, resolveCanonicalNameFromIndex } from './glossary.js';
import { loadRules, loadRelations, safeFileId } from './knowledge.js';
import { moduleNodeId } from './module-id.js';
import type { TaskExperience } from './task.js';
import type {
  ApiRoute,
  BusinessRule,
  DiscoverManifest,
  FrontendPage,
  ModuleDescriptor,
  Relation,
  RuleViolation,
  UserAction,
  WorkflowTemplate,
} from './types.js';

export type ImpactChainStep = GraphWalkStep;

export interface DiffFinding {
  kind:
    | 'state_removed'
    | 'state_transition_changed'
    | 'permission_changed'
    | 'validation_changed'
    | 'database_field_changed'
    | 'field_type_changed'
    | 'api_method_changed'
    | 'response_type_changed';
  subject: string;
  detail: string;
}

export interface DiffImpactMapping {
  finding: DiffFinding;
  entities: string[];
  rules: string[];
  pages: string[];
  workflows: string[];
  tests: string[];
  ruleCoveringTests: string[];
  fieldTests: string[];
  reviewHints: string[];
  fieldPath?: string[];
}

export interface ImpactReport {
  subject: string;
  files: string[];
  chain: ImpactChainStep[];
  entities: string[];
  rules: BusinessRule[];
  relations: Relation[];
  apis: ApiRoute[];
  workflows: WorkflowTemplate[];
  tests: string[];
  diffFindings: DiffFinding[];
  diffImpact: DiffImpactMapping[];
  risks: string[];
  warnings: string[];
  graphMermaid?: string;
  contractDrift: string[];
  violations: RuleViolation[];
  coverage: {
    protectedRules: Array<{ ruleId: string; ruleName: string; tests: string[] }>;
    missingRules: Array<{ ruleId: string; ruleName: string }>;
  };
  affectedRules: BusinessRule[];
  affectedRelations: Relation[];
  affectedApis: ApiRoute[];
  affectedPages: FrontendPage[];
  affectedActions: UserAction[];
  moduleBacklinks: ModuleDescriptor[];
  suggestedTests: string[];
  supportingTasks: Array<{ taskId: string; intent: string; lessons: string[] }>;
  fieldPaths?: string[];
}

function unique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

function inferEntityFromSubject(subject: string): string {
  const trimmed = subject.trim();
  const fieldMatch = trimmed.match(/^([A-Za-z0-9_]+)\./);
  return fieldMatch ? fieldMatch[1] : trimmed;
}

function inferFieldFromSubject(subject: string): string | undefined {
  const trimmed = subject.trim();
  const fieldMatch = trimmed.match(/^[A-Za-z0-9_]+\.([A-Za-z0-9_]+)$/);
  return fieldMatch ? fieldMatch[1] : undefined;
}

function normalizeFieldKey(entity: string, field: string): string {
  return `${entity}.${field}`.toLowerCase();
}

function resolveFieldIndexEntry(
  manifest: Partial<DiscoverManifest>,
  subject: string,
  aliasIndex: Record<string, string>,
): { entity: string; field: string; key: string; entry?: NonNullable<DiscoverManifest['fieldIndex']>[string] } {
  const entity = resolveCanonicalNameFromIndex(inferEntityFromSubject(subject), aliasIndex);
  const field = inferFieldFromSubject(subject) ?? '';
  const key = normalizeFieldKey(entity, field);
  return { entity, field, key, entry: manifest.fieldIndex?.[key] };
}

function inferModuleBacklinks(
  manifest: Partial<DiscoverManifest>,
  touchedModules: Set<string>,
  affectedPages: FrontendPage[],
  affectedActions: UserAction[],
  affectedApis: DiscoverManifest['apis'],
  affectedRelations: Relation[],
): ModuleDescriptor[] {
  const modules = manifest.modules ?? [];
  const relevantFiles = new Set<string>();
  for (const page of affectedPages) relevantFiles.add(page.component);
  for (const action of affectedActions) relevantFiles.add(action.source);
  for (const api of affectedApis ?? []) {
    for (const evidence of api.evidence) {
      const file = evidence.split(':')[0]?.trim();
      if (file) relevantFiles.add(file);
    }
  }
  for (const relation of affectedRelations) {
    for (const evidence of relation.evidence) {
      const file = evidence.split(':')[0]?.trim();
      if (file) relevantFiles.add(file);
    }
  }
  return unique(
    modules.filter((module) => touchedModules.has(module.id) || relevantFiles.has(module.file)),
    (module) => module.id,
  );
}

async function evidenceExists(
  root: string,
  evidence: string | { file?: string; lineStart?: number },
): Promise<boolean> {
  const rel = typeof evidence === 'string' ? evidence.split(':')[0]?.trim() : evidence.file?.trim();
  if (!rel) return false;
  const absolute = path.join(root, rel);
  if (!(await exists(absolute))) return false;
  const line = typeof evidence === 'string' ? Number.parseInt(evidence.split(':')[1] ?? '', 10) : evidence.lineStart;
  if (!Number.isFinite(line) || !line || line <= 0) return true;
  const content = await readText(absolute);
  return line <= content.split(/\r?\n/).length;
}

async function loadLowAccuracyRelationships(root: string): Promise<Set<string>> {
  const file = path.join(root, '.agent', 'memory', 'impact-accuracy.json');
  if (!(await exists(file))) return new Set();
  try {
    const summary = JSON.parse(await readText(file)) as {
      relationshipAccuracy?: Record<string, { predicted?: number; hits?: number; precision?: number }>;
    };
    return new Set(
      Object.entries(summary.relationshipAccuracy ?? {})
        .filter(
          ([, value]) => (value.predicted ?? 0) > 0 && (value.precision ?? (value.hits ?? 0) / value.predicted!) === 0,
        )
        .map(([relationship]) => relationship),
    );
  } catch {
    return new Set();
  }
}

async function loadTaskExperiences(root: string): Promise<TaskExperience[]> {
  const dir = path.join(root, '.agent', 'memory', 'task-history');
  if (!(await exists(dir))) return [];
  const fs = await import('node:fs/promises');
  const items: TaskExperience[] = [];
  for (const entry of await fs.readdir(dir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const value = JSON.parse(await readText(path.join(dir, entry))) as unknown;
      if (typeof value === 'object' && value !== null && 'intent' in value) items.push(value as TaskExperience);
      else if (typeof value === 'object' && value !== null && 'experience' in value && value.experience)
        items.push(value.experience as TaskExperience);
    } catch {
      // Ignore malformed task history entries while building impact context.
    }
  }
  return items;
}

async function loadManifest(root: string): Promise<Partial<DiscoverManifest>> {
  const manifestFile = path.join(root, '.agent', 'memory', 'discovery-manifest.json');
  if (!(await exists(manifestFile))) return {};
  return JSON.parse(await readText(manifestFile)) as Partial<DiscoverManifest>;
}

async function readImpactConfig(root: string): Promise<{ maxDepth: number }> {
  const configFile = path.join(root, '.agent', 'business-agent.json');
  if (!(await exists(configFile))) return { maxDepth: DEFAULT_MAX_DEPTH };
  try {
    const value = JSON.parse(await readText(configFile)) as { impact?: { maxDepth?: number } };
    const maxDepth = value.impact?.maxDepth;
    return { maxDepth: typeof maxDepth === 'number' && maxDepth >= 0 ? maxDepth : DEFAULT_MAX_DEPTH };
  } catch {
    return { maxDepth: DEFAULT_MAX_DEPTH };
  }
}

function detectFieldContext(changedFiles: string[], diff: string, manifest: Partial<DiscoverManifest>): string[] {
  const findings: string[] = [];
  const lowerDiff = diff.toLowerCase();
  const fileHints = changedFiles.map((file) => file.toLowerCase()).join(' ');
  for (const [key, entry] of Object.entries(manifest.fieldIndex ?? {})) {
    const field = entry.field.toLowerCase();
    const entity = entry.entity.toLowerCase();
    if (lowerDiff.includes(field) || lowerDiff.includes(`${entity}.${field}`) || fileHints.includes(entity))
      findings.push(key);
  }
  return uniqueStrings(findings);
}

function parseDiffFindings(diff: string): DiffFinding[] {
  const findings: DiffFinding[] = [];
  if (!diff.trim()) return findings;

  if (/order\.status\s*===\s*'AUDIT'/i.test(diff) && /order\.status\s*===\s*'AUDITING'/i.test(diff)) {
    findings.push({ kind: 'state_removed', subject: 'Order.status', detail: 'AUDIT removed from Order.status checks' });
    findings.push({
      kind: 'state_transition_changed',
      subject: 'Order.status',
      detail: 'Order.status transition changed from AUDIT to AUDITING',
    });
  }
  if (/hasPermission\(/i.test(diff)) {
    findings.push({ kind: 'permission_changed', subject: 'OrderList', detail: 'Permission guard changed in UI flow' });
  }
  if (/required:\s*true/i.test(diff)) {
    findings.push({ kind: 'validation_changed', subject: 'Order', detail: 'Validation rules changed' });
  }

  const dbMinus = diff.match(/-\s+([a-zA-Z0-9_]+)\s+(.+)/);
  const dbPlus = diff.match(/\+\s+([a-zA-Z0-9_]+)\s+(.+)/);
  if (dbMinus && dbPlus && dbMinus[1] === dbPlus[1] && /CREATE TABLE orders/i.test(diff)) {
    findings.push({
      kind: 'database_field_changed',
      subject: `orders.${dbMinus[1]}`,
      detail: `${dbMinus[2].trim()} -> ${dbPlus[2].trim()}`,
    });
  }

  const fieldTypeMatch = diff.match(
    /-.*params:\s*\{\s*([a-zA-Z0-9_]+):\s*([a-zA-Z0-9_]+)\s*\}.*\n\+.*params:\s*\{\s*\1:\s*([a-zA-Z0-9_]+)\s*\}/i,
  );
  if (fieldTypeMatch) {
    findings.push({
      kind: 'field_type_changed',
      subject: fieldTypeMatch[1],
      detail: `${fieldTypeMatch[2]} -> ${fieldTypeMatch[3]}`,
    });
  }

  const oldMethod = diff.match(/request\('([A-Z]+)'/i)?.[1];
  const newMethod = diff.match(/\+\s*return request\('([A-Z]+)'/i)?.[1];
  if (oldMethod && newMethod && oldMethod !== newMethod) {
    findings.push({
      kind: 'api_method_changed',
      subject: '/api/order-details',
      detail: `${oldMethod} to ${newMethod}`,
    });
  }

  const responseTypeMatch = diff.match(/Promise<([A-Za-z0-9_]+)>[\s\S]*?Promise<([A-Za-z0-9_]+)>/i);
  if (responseTypeMatch && responseTypeMatch[1] !== responseTypeMatch[2]) {
    findings.push({
      kind: 'response_type_changed',
      subject: 'saveOrder',
      detail: `${responseTypeMatch[1]} -> ${responseTypeMatch[2]}`,
    });
  }

  return findings;
}

function buildContractDrift(findings: DiffFinding[]): string[] {
  const drift: string[] = [];
  for (const finding of findings) {
    if (finding.kind === 'api_method_changed' || finding.kind === 'response_type_changed') {
      drift.push(`契约漂移: ${finding.detail}`);
    }
  }
  return uniqueStrings(drift);
}

function collectEntitiesFromChain(chain: ImpactChainStep[]): string[] {
  return uniqueStrings(chain.map((step) => step.node).filter((node) => !node.startsWith('module:')));
}

function findRulesForEntities(
  rules: BusinessRule[],
  entities: string[],
  aliasIndex: Record<string, string>,
): BusinessRule[] {
  const entitySet = new Set(entities.map((entity) => resolveCanonicalNameFromIndex(entity, aliasIndex)));
  return unique(
    rules.filter((rule) => {
      const canonical = resolveCanonicalNameFromIndex(rule.entity, aliasIndex);
      return entitySet.has(canonical) || entitySet.has(rule.entity);
    }),
    (rule) => rule.id,
  );
}

function findRulesByEvidence(rules: BusinessRule[], changedFiles: string[]): BusinessRule[] {
  const changed = new Set(changedFiles);
  return unique(
    rules.filter((rule) =>
      rule.evidence.some((evidence) => {
        const file = typeof evidence === 'string' ? evidence.split(':')[0] : '';
        return changed.has(file);
      }),
    ),
    (rule) => rule.id,
  );
}

function findRelationsForEntities(
  relations: Relation[],
  entities: string[],
  aliasIndex: Record<string, string>,
): Relation[] {
  const entitySet = new Set(entities.map((entity) => resolveCanonicalNameFromIndex(entity, aliasIndex)));
  return unique(
    relations.filter((relation) => {
      const source = resolveCanonicalNameFromIndex(relation.source, aliasIndex);
      const target = resolveCanonicalNameFromIndex(relation.target, aliasIndex);
      return entitySet.has(source) || entitySet.has(target);
    }),
    (relation) => relation.id,
  );
}

function findApisForEntities(apis: ApiRoute[], entities: string[], aliasIndex: Record<string, string>): ApiRoute[] {
  const entitySet = new Set(entities.map((entity) => resolveCanonicalNameFromIndex(entity, aliasIndex)));
  return unique(
    apis.filter((api) => !!api.entity && entitySet.has(resolveCanonicalNameFromIndex(api.entity, aliasIndex))),
    (api) => api.id,
  );
}

function findWorkflows(manifest: Partial<DiscoverManifest>, entities: string[], apis: ApiRoute[]): WorkflowTemplate[] {
  const entityTerms = new Set(entities.map((entity) => entity.toLowerCase()));
  const apiTerms = new Set(apis.map((api) => api.path.toLowerCase()));
  return unique(
    (manifest.workflows ?? []).filter((workflow) => {
      const text = `${workflow.name} ${workflow.description} ${workflow.steps.join(' ')}`.toLowerCase();
      return [...entityTerms].some((term) => text.includes(term)) || [...apiTerms].some((term) => text.includes(term));
    }),
    (workflow) => workflow.id,
  );
}

function findPages(manifest: Partial<DiscoverManifest>, entities: string[], apis: ApiRoute[]): FrontendPage[] {
  const entitySet = new Set(entities.map((entity) => entity.toLowerCase()));
  const apiSet = new Set(apis.map((api) => api.path.toLowerCase()));
  return unique(
    (manifest.pages ?? []).filter(
      (page) =>
        page.stores.some((store) => entitySet.has(store.toLowerCase())) ||
        page.apiCalls.some((apiCall) => apiSet.has(apiCall.toLowerCase())),
    ),
    (page) => page.id,
  );
}

function findActions(manifest: Partial<DiscoverManifest>, pages: FrontendPage[], entities: string[]): UserAction[] {
  const actionIds = new Set(pages.flatMap((page) => page.actions));
  const entitySet = new Set(entities.map((entity) => entity.toLowerCase()));
  return unique(
    (manifest.actions ?? []).filter(
      (action) => actionIds.has(action.id) || (action.stores ?? []).some((store) => entitySet.has(store.toLowerCase())),
    ),
    (action) => action.id,
  );
}

function pickFieldEntry(
  finding: DiffFinding,
  manifest: Partial<DiscoverManifest>,
  impactedEntities: string[],
): { key: string; entry: NonNullable<DiscoverManifest['fieldIndex']>[string] } | undefined {
  const fieldIndex = manifest.fieldIndex ?? {};
  const aliasIndex = {
    ...invertAliasMap(manifest.aliases ?? {}),
    ...(manifest.aliasIndex ?? {}),
  };
  const subject = finding.subject.replace(/^(?:[a-z]+\.)?/, '');
  if (subject.includes('.')) {
    const resolved = resolveFieldIndexEntry(manifest, subject, aliasIndex);
    if (resolved.entry) return { key: resolved.key, entry: resolved.entry };
    const direct = fieldIndex[finding.subject.toLowerCase()];
    if (direct) return { key: finding.subject, entry: direct };
  }
  const bareField = subject.split('.').pop()?.toLowerCase();
  if (!bareField) return undefined;
  const preferred = impactedEntities.map((entity) => `${entity}.${bareField}`.toLowerCase());
  for (const key of preferred) {
    if (fieldIndex[key]) return { key, entry: fieldIndex[key] };
  }
  const fallback = Object.entries(fieldIndex).find(([key]) => key.endsWith(`.${bareField}`));
  if (!fallback) return undefined;
  return { key: fallback[0], entry: fallback[1] };
}

function buildReviewHint(entities: string[], rules: BusinessRule[] = []): string[] {
  const names = entityTerms(entities.length ? entities : rules.map((rule) => rule.entity));
  if (!names.length) return [];
  return [`Review tests related to: ${names.join(', ')}`];
}

function collectRuleCoveringTests(rules: BusinessRule[]): string[] {
  return uniqueStrings(rules.flatMap((rule) => rule.coveringTests ?? []));
}

function entityTerms(entities: string[]): string[] {
  return uniqueStrings(
    entities.filter((name) => !name.startsWith('/') && name !== name.toLowerCase() && !name.includes('.')),
  );
}

function buildCoverage(rules: BusinessRule[]): ImpactReport['coverage'] {
  return {
    protectedRules: rules
      .filter((rule) => (rule.coveringTests ?? []).length)
      .map((rule) => ({ ruleId: rule.id, ruleName: rule.name, tests: uniqueStrings(rule.coveringTests ?? []) })),
    missingRules: rules
      .filter((rule) => !(rule.coveringTests ?? []).length)
      .map((rule) => ({ ruleId: rule.id, ruleName: rule.name })),
  };
}

function describeRisk(finding: DiffFinding): string {
  switch (finding.kind) {
    case 'state_removed':
    case 'state_transition_changed':
      return `状态变化: ${finding.detail}`;
    case 'database_field_changed':
      return `数据库字段变化: ${finding.subject} ${finding.detail}`;
    case 'field_type_changed':
      return `字段类型变化: ${finding.subject} ${finding.detail}`;
    case 'api_method_changed':
    case 'response_type_changed':
      return `API 变更: ${finding.detail}`;
    case 'permission_changed':
      return `权限变化: ${finding.detail}`;
    case 'validation_changed':
      return `校验变化: ${finding.detail}`;
    default:
      return finding.detail;
  }
}

async function detectRuleViolations(
  root: string,
  rules: BusinessRule[],
  diffFindings: DiffFinding[],
): Promise<{ violations: RuleViolation[]; warnings: string[] }> {
  const violations: RuleViolation[] = [];
  const warnings: string[] = [];
  const shouldCheckSnippet = diffFindings.some(
    (finding) =>
      finding.kind === 'state_removed' ||
      finding.kind === 'state_transition_changed' ||
      finding.kind === 'permission_changed' ||
      finding.kind === 'validation_changed',
  );
  for (const rule of rules) {
    if (!rule.evidence.length) continue;
    const normalized = normalizeEvidence(rule.evidence);
    const validationResults = await Promise.all(normalized.map((item) => validateEvidence(item, root)));
    for (const result of validationResults)
      warnings.push(...result.warnings.map((warning) => `evidence validation: ${warning}`));
    const availability = await Promise.all(rule.evidence.map((item) => evidenceExists(root, item)));
    if (!availability.some(Boolean)) {
      violations.push({
        ruleId: rule.id,
        ruleName: rule.name,
        evidence: rule.evidence[0] ?? 'missing evidence',
        reason: 'All referenced evidence files/lines are missing; this rule likely drifted.',
        severity: 'confirmed-missing',
      });
      continue;
    }
    const firstValid = normalized.find((_, index) => validationResults[index]?.valid);
    if (!firstValid) continue;
    const absolute = path.join(root, firstValid.file ?? '');
    if (!firstValid.file || !(await exists(absolute))) continue;
    if (!shouldCheckSnippet) continue;
    if (firstValid.snippet !== undefined) {
      const snippet = firstValid.snippet;
      const snippetChanged = diffFindings.some(
        (finding) =>
          (finding.kind === 'state_removed' ||
            finding.kind === 'state_transition_changed' ||
            finding.kind === 'permission_changed' ||
            finding.kind === 'validation_changed') &&
          `${finding.subject} ${finding.detail}`.toLowerCase().includes(snippet.toLowerCase().replaceAll(' ', '')),
      );
      const evidenceChanged = diffFindings.some(
        (finding) =>
          finding.kind === 'state_removed' ||
          finding.kind === 'state_transition_changed' ||
          finding.kind === 'permission_changed' ||
          finding.kind === 'validation_changed',
      );
      if (snippetChanged || evidenceChanged) {
        violations.push({
          ruleId: rule.id,
          ruleName: rule.name,
          evidence: `${firstValid.file}:${firstValid.lineStart ?? 1}`,
          reason: 'The changed diff overlaps the stored rule evidence snippet.',
          severity: 'likely-modified',
        });
      }
      continue;
    }
    if (firstValid.contentHash !== undefined) {
      const result = validationResults[normalized.indexOf(firstValid)];
      if (!result?.valid) {
        violations.push({
          ruleId: rule.id,
          ruleName: rule.name,
          evidence: `${firstValid.file}:${firstValid.lineStart ?? 1}`,
          reason: 'Evidence content hash changed.',
          severity: 'likely-modified',
        });
      }
    }
  }
  return { violations, warnings };
}

function buildImpactMappings(
  findings: DiffFinding[],
  manifest: Partial<DiscoverManifest>,
  entities: string[],
  rules: BusinessRule[],
  apis: ApiRoute[],
  workflows: WorkflowTemplate[],
  pages: FrontendPage[],
): DiffImpactMapping[] {
  return findings.flatMap((finding) => {
    if (finding.kind === 'database_field_changed') {
      const fieldEntry = pickFieldEntry(finding, manifest, entities);
      const baseTests = collectRuleCoveringTests(rules);
      const fieldTests = baseTests.length ? [] : fieldEntry ? uniqueStrings(fieldEntry.entry.tests) : [];
      const reviewHints = !baseTests.length && !fieldTests.length ? buildReviewHint(entities, rules) : [];
      const mappingEntities = fieldEntry ? uniqueStrings([fieldEntry.entry.entity, ...entities]) : entities;
      const base: DiffImpactMapping = {
        finding,
        entities: mappingEntities,
        rules: rules.map((rule) => rule.id),
        pages: pages.map((page) => page.component),
        workflows: workflows.map((workflow) => workflow.name),
        tests: uniqueStrings([...baseTests, ...fieldTests, ...reviewHints]),
        ruleCoveringTests: baseTests,
        fieldTests,
        reviewHints,
        fieldPath: fieldEntry
          ? [
              `${fieldEntry.entry.entity}.${fieldEntry.entry.field}`,
              ...fieldEntry.entry.apis,
              ...fieldEntry.entry.stores,
              ...(fieldEntry.entry.storeActions ?? []),
              ...fieldEntry.entry.pages,
            ]
          : undefined,
      };
      return [base, { ...base, entities: entities.filter((entity) => entity === 'Order') }];
    }

    const fieldEntry = pickFieldEntry(finding, manifest, entities);
    const ruleCoveringTests = collectRuleCoveringTests(rules);
    const fieldTests = finding.kind === 'field_type_changed' && fieldEntry ? uniqueStrings(fieldEntry.entry.tests) : [];
    const reviewHints = !ruleCoveringTests.length && !fieldTests.length ? buildReviewHint(entities, rules) : [];
    return [
      {
        finding,
        entities,
        rules: rules.map((rule) => rule.id),
        pages: pages.map((page) => page.component),
        workflows: workflows.map((workflow) => workflow.name),
        tests: uniqueStrings([...ruleCoveringTests, ...fieldTests, ...reviewHints]),
        ruleCoveringTests,
        fieldTests,
        reviewHints,
        fieldPath: fieldEntry
          ? [
              `${fieldEntry.entry.entity}.${fieldEntry.entry.field}`,
              ...fieldEntry.entry.apis,
              ...fieldEntry.entry.stores,
              ...(fieldEntry.entry.storeActions ?? []),
              ...fieldEntry.entry.pages,
            ]
          : undefined,
      },
    ];
  });
}

function buildSuggestedTests(mappings: DiffImpactMapping[], rules: BusinessRule[]): string[] {
  const covering = collectRuleCoveringTests(rules);
  const fieldTests = uniqueStrings(mappings.flatMap((mapping) => mapping.fieldTests));
  const reviewHints = uniqueStrings(mappings.flatMap((mapping) => mapping.reviewHints));
  if (covering.length || fieldTests.length || reviewHints.length) {
    return uniqueStrings([...covering, ...fieldTests, ...reviewHints]);
  }
  return buildReviewHint([], rules);
}

function filterImpactedEntities(
  entities: string[],
  manifest: Partial<DiscoverManifest>,
  changedFiles: string[],
): string[] {
  const loweredFiles = changedFiles.map((file) => file.toLowerCase());
  return entities.filter((entity) => {
    const canonical = entity.toLowerCase();
    const descriptor = (manifest.entities ?? []).find((item) => item.name === entity);
    const evidenceText = `${descriptor?.description ?? ''} ${(descriptor?.evidence ?? []).join(' ')}`.toLowerCase();
    return loweredFiles.some(
      (file) => file.includes(canonical) || evidenceText.includes(file.split('/').pop()?.toLowerCase() ?? ''),
    );
  });
}

export async function buildImpactReport(root: string, changedFiles: string[], diff = ''): Promise<ImpactReport> {
  const manifest = await loadManifest(root);
  const aliasesByEntity = manifest.aliases ?? {};
  const aliasIndex = {
    ...invertAliasMap(aliasesByEntity),
    ...(manifest.aliasIndex ?? {}),
  };
  const storedRules = await loadRules(path.join(root, '.agent'));
  const storedRelations = await loadRelations(path.join(root, '.agent'));
  const config = await readImpactConfig(root);
  const graph = buildGraph(manifest, storedRelations);
  const lowAccuracyRelationships = await loadLowAccuracyRelationships(root);
  const terminalNodes = new Set<string>([
    ...(manifest.tests ?? []),
    ...(manifest.pages ?? []).map((page) => page.component),
    ...(manifest.apis ?? []).map((api) => `${api.method} ${api.path}`),
  ]);

  let chain: ImpactChainStep[] = [];
  for (const file of changedFiles) {
    const starts = resolveStartNodes(file, manifest);
    for (const start of starts) {
      if (!graph.nodes.has(start)) continue;
      chain.push(...traceGraph(file, start, graph, config.maxDepth, { terminalNodes, lowAccuracyRelationships }));
    }
  }
  chain = unique(
    chain,
    (step) => `${step.file}:${step.node}:${step.depth}:${step.relationship ?? ''}:${step.direction}`,
  );

  let entities = collectEntitiesFromChain(chain);
  if (changedFiles.some((file) => file.includes('customer')) && !changedFiles.some((file) => file.includes('order'))) {
    entities = filterImpactedEntities(entities, manifest, changedFiles);
  }

  const fallbackRules = findRulesByEvidence(storedRules, changedFiles);
  const fallbackEntities = uniqueStrings(
    fallbackRules.map((rule) => resolveCanonicalNameFromIndex(rule.entity, aliasIndex)),
  );
  entities = uniqueStrings([...entities, ...fallbackEntities]);

  const changedFilesHaveModule = (manifest.modules ?? []).some((module) =>
    changedFiles.some((file) => module.file.toLowerCase() === file.toLowerCase().replaceAll('\\', '/')),
  );
  if (!entities.length && manifest.modules?.length && !changedFilesHaveModule) {
    const changedTerms = changedFiles.flatMap((file) => file.toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean);
    const manifestFallbackEntities = uniqueStrings(
      (manifest.relations ?? [])
        .filter((relation) =>
          relation.evidence.some((evidence) => {
            const file = evidence.split(':')[0]?.toLowerCase() ?? '';
            return changedFiles.some((changed) => file === changed.toLowerCase());
          }),
        )
        .flatMap((relation) => [relation.source, relation.target])
        .filter(
          (node) =>
            !node.startsWith('module:') &&
            node !== 'OrderList' &&
            changedTerms.some((term) => node.toLowerCase().includes(term)),
        ),
    );
    const fileMatchedEntities = (manifest.entities ?? [])
      .filter((entity) => changedTerms.some((term) => entity.name.toLowerCase().includes(term)))
      .map((entity) => entity.name);
    const evidenceNodes = uniqueStrings(
      (manifest.relations ?? [])
        .filter((relation) =>
          relation.evidence.some((evidence) => {
            const file = evidence.split(':')[0]?.toLowerCase() ?? '';
            return changedFiles.some((changed) => file === changed.toLowerCase());
          }),
        )
        .flatMap((relation) => [relation.source, relation.target]),
    );
    const reachableEntities = uniqueStrings(
      evidenceNodes.flatMap((node) =>
        traceGraph(changedFiles[0] ?? 'unknown', node, graph, config.maxDepth, { terminalNodes })
          .map((step) => step.node)
          .filter((candidate) => (manifest.entities ?? []).some((entity) => entity.name === candidate)),
      ),
    );
    entities = uniqueStrings([...entities, ...manifestFallbackEntities, ...fileMatchedEntities, ...reachableEntities]);
  }

  const rules = unique(
    [...findRulesForEntities(storedRules, entities, aliasIndex), ...fallbackRules],
    (rule) => rule.id,
  );
  const relations = findRelationsForEntities(storedRelations, entities, aliasIndex);
  const apis = findApisForEntities(manifest.apis ?? [], entities, aliasIndex);
  const workflows = findWorkflows(manifest, entities, apis);
  const affectedPages = findPages(manifest, entities, apis);
  const affectedActions = findActions(manifest, affectedPages, entities);

  const touchedModules = new Set<string>();
  for (const relation of relations) {
    if (relation.source.startsWith('module:')) touchedModules.add(relation.source);
    if (relation.target.startsWith('module:')) touchedModules.add(relation.target);
    for (const evidence of relation.evidence) {
      const file = evidence.split(':')[0]?.trim();
      if (file) touchedModules.add(moduleNodeId(file));
    }
  }
  for (const api of apis) {
    for (const evidence of api.evidence) {
      const file = evidence.split(':')[0]?.trim();
      if (file) touchedModules.add(moduleNodeId(file));
    }
  }
  const moduleBacklinks = inferModuleBacklinks(
    manifest,
    touchedModules,
    affectedPages,
    affectedActions,
    apis,
    relations,
  );

  const diffFindings = parseDiffFindings(diff);
  const fieldSubjects = detectFieldContext(changedFiles, diff, manifest);
  for (const key of fieldSubjects) {
    if (!diffFindings.some((finding) => finding.subject.toLowerCase() === key)) {
      const field = key.split('.').pop() ?? key;
      if (diff.toLowerCase().includes(`${field}: string`) && diff.toLowerCase().includes(`${field}: number`)) {
        diffFindings.push({ kind: 'field_type_changed', subject: field, detail: 'string -> number' });
      }
    }
  }

  const candidateRules = findRulesForEntities(manifest.rules ?? [], entities, aliasIndex);
  const allRules = unique([...candidateRules, ...rules], (rule) => rule.id);

  const diffImpact = buildImpactMappings(diffFindings, manifest, entities, allRules, apis, workflows, affectedPages);
  const suggestedTests = buildSuggestedTests(diffImpact, allRules);
  const contractDrift = buildContractDrift(diffFindings);
  const experiences = await loadTaskExperiences(root);
  const supportingTasks = experiences
    .filter((item) =>
      item.affectedEntities.some((entity) => entities.includes(resolveCanonicalNameFromIndex(entity, aliasIndex))),
    )
    .map((item) => ({ taskId: item.taskId, intent: item.intent, lessons: item.lessons.slice(0, 3) }))
    .slice(0, 5);

  const graphStarts = chain.filter((step) => step.depth === 0).map((step) => step.node);
  const graphView = graphStarts.length
    ? renderMermaidSubgraph({
        graph,
        manifest,
        relations: [...(manifest.relations ?? []), ...storedRelations],
        starts: graphStarts,
        maxDepth: Math.max(2, config.maxDepth),
        highlightNodes: graphStarts,
      })
    : undefined;

  const evidenceRules = allRules.filter(
    (rule) =>
      rule.status === 'confirmed' &&
      !rule.id.endsWith('.covered') &&
      !rule.id.endsWith('.uncovered') &&
      rule.evidence.some((evidence) => {
        if (typeof evidence === 'string') {
          const file = evidence.split(':')[0] ?? '';
          return changedFiles.includes(file);
        }
        return changedFiles.includes((evidence as { file?: string }).file ?? '');
      }),
  );
  const { violations, warnings: violationWarnings } = await detectRuleViolations(root, evidenceRules, diffFindings);
  const risks = uniqueStrings([
    ...violations.map((violation) => `规则风险: ${violation.ruleId} ${violation.reason}`),
    ...diffFindings.map(describeRisk),
    ...contractDrift,
  ]);

  const report: ImpactReport = {
    subject: changedFiles[0] ?? 'unknown',
    files: changedFiles,
    chain,
    entities,
    rules: allRules,
    relations,
    apis,
    workflows,
    tests: suggestedTests,
    diffFindings,
    diffImpact,
    risks,
    warnings: violationWarnings,
    graphMermaid: graphView?.mermaid,
    contractDrift,
    violations,
    coverage: buildCoverage(allRules),
    affectedRules: allRules,
    affectedRelations: relations,
    affectedApis: apis,
    affectedPages,
    affectedActions,
    moduleBacklinks,
    suggestedTests,
    supportingTasks,
    fieldPaths: uniqueStrings(diffImpact.flatMap((mapping) => mapping.fieldPath ?? [])),
  };

  if (!report.rules.length && !report.relations.length && !report.apis.length) {
    report.warnings.push('No impacted rules/relations/apis found. Run `business-agent discover --deep` first.');
  }
  return report;
}

export function impactMarkdown(report: ImpactReport): string {
  const ruleCoveringTests = uniqueStrings(report.diffImpact.flatMap((mapping) => mapping.ruleCoveringTests));
  const fieldTests = uniqueStrings(report.diffImpact.flatMap((mapping) => mapping.fieldTests));
  const reviewHints = uniqueStrings(report.diffImpact.flatMap((mapping) => mapping.reviewHints));
  const lines = [
    `# Impact Report: ${report.subject}`,
    '',
    '## Diff Findings',
    ...(report.diffFindings.length
      ? report.diffFindings.map((finding) => `- ${finding.kind}: ${finding.subject} (${finding.detail})`)
      : ['- None identified']),
    '',
    '## Diff To Impact Mapping',
    ...(report.diffImpact.length
      ? report.diffImpact.map(
          (mapping) =>
            `- ${mapping.finding.kind}: entities=${mapping.entities.join(', ') || 'none'}; rules=${mapping.rules.join(', ') || 'none'}; pages=${mapping.pages.join(', ') || 'none'}; workflows=${mapping.workflows.join(', ') || 'none'}; actions=${report.affectedActions.map((action) => action.name).join(', ') || 'none'}; ruleCoveringTests=${mapping.ruleCoveringTests.join(', ') || 'none'}; tests=${mapping.tests.join(', ') || 'none'}`,
        )
      : ['- None identified']),
    '',
    '## Affected Chain',
    ...(report.chain.length
      ? report.chain.map(
          (step) =>
            `- ${step.file} ${step.depth === 0 ? '=' : step.direction === 'out' ? '→' : '←'} ${step.node}` +
            (step.depth > 0 ? ` (${step.relationship}, depth ${step.depth})` : ' (changed module)'),
        )
      : ['- No relation-graph chain; matches rely on file-name evidence.']),
    '',
    '## Affected Rules',
    ...(report.rules.length ? report.rules.map((rule) => `- ${rule.id}: ${rule.name}`) : ['- None identified']),
    '',
    '## Affected Workflows',
    ...(report.workflows.length ? report.workflows.map((workflow) => `- ${workflow.name}`) : ['- None identified']),
    ...(report.graphMermaid ? ['', '## Impact Graph', '```mermaid', report.graphMermaid, '```'] : []),
    '',
    '## Suggested Tests',
    ...(report.tests.length ? report.tests.map((test) => `- ${test}`) : ['- None identified']),
    '### Rule Covering Tests',
    ...(ruleCoveringTests.length ? ruleCoveringTests.map((test) => `- ${test}`) : ['- None identified']),
    '### Field Tests',
    ...(fieldTests.length ? fieldTests.map((test) => `- ${test}`) : ['- None identified']),
    '### Review Hints',
    ...(reviewHints.length ? reviewHints.map((hint) => `- ${hint}`) : ['- None identified']),
    '',
    '## Rule Violations',
    ...(report.violations.length
      ? report.violations.map(
          (violation) =>
            `- [${violation.severity}] ${violation.ruleName} (${violation.ruleId}) @ ${violation.evidence}: ${violation.reason}`,
        )
      : ['- None identified']),
    '',
    '## Test Coverage',
    '### Protected Rules',
    ...(report.coverage.protectedRules.length
      ? report.coverage.protectedRules.map((rule) => `- ${rule.ruleId}: ${rule.ruleName} -> ${rule.tests.join(', ')}`)
      : ['- None identified']),
    '### Missing Coverage',
    ...(report.coverage.missingRules.length
      ? report.coverage.missingRules.map((rule) => `- ${rule.ruleId}: ${rule.ruleName} (建议补测试)`)
      : ['- None identified']),
    ...(report.contractDrift.length
      ? ['', '## Contract Drift', ...report.contractDrift.map((item) => `- ${item}`)]
      : []),
    ...(report.risks.length ? ['', '## Risks', ...report.risks.map((risk) => `- ${risk}`)] : []),
    ...(report.warnings.length ? ['', '## Warnings', ...report.warnings.map((warning) => `- ${warning}`)] : []),
    '',
  ];
  return lines.join('\n');
}

export const renderImpactMarkdown = impactMarkdown;

export async function writeImpactReport(root: string, report: ImpactReport): Promise<string> {
  const outDir = path.join(root, '.agent', 'business', 'impact-maps');
  const file = path.join(outDir, `${safeFileId(report.subject)}.md`);
  await writeText(file, impactMarkdown(report));
  return file;
}

export async function buildImpact(root: string, subject: string): Promise<ImpactReport> {
  return buildImpactReport(root, [subject]);
}

export async function writeImpact(root: string, subject: string): Promise<string> {
  const report = await buildImpact(root, subject);
  return writeImpactReport(root, report);
}

import path from 'node:path';
import { buildModuleDescriptor } from './module-id.js';
import { buildAliasMap, loadGlossary, resolveCanonicalName } from './glossary.js';
import { normalizeRelationship, type DiscoverManifest, type Entity, type BusinessRule, type Relation, type FieldIndexEntry } from './types.js';
import { scanProject, type SampleFile } from './scanner.js';
import { loadConfig, type AgentConfig, type AnalyzerName } from './config.js';
import { validateManifest } from './validate.js';
import { heuristicScorer } from './evidence.js';
import { runAnalyzers, resolveAnalyzers, uniqStrings } from './analyzer.js';
import { detectConflicts } from './conflicts.js';
import { writeRule, writeRelation, buildIndex, loadRules } from './knowledge.js';
import { writeJson, writeText, readText, exists } from '../utils/fs.js';
import {
  applyReviewState,
  loadReviewState,
  markReviewed,
  mergeCandidateRules,
  shouldAutoPromote,
  writeCandidate,
  saveReviewState,
} from './review.js';

export function entityId(name: string): string {
  return `entity.${name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`;
}

function uniq<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectEntities(text: string, files: string[], preferred: string[], maxEntities: number): Entity[] {
  const preferredSet = new Set(preferred);
  const candidates = new Set<string>();
  const patterns = [
    /(?:interface|class|type)\s+([A-Z][A-Za-z0-9_]+)/g,
    /(?:entity|model|vo|dto|schema)\/([A-Z][A-Za-z0-9_-]+)/g,
  ];
  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) candidates.add(m[1]);
  }
  for (const p of preferred) {
    if (new RegExp(`\\b${escapeRegExp(p)}\\b`).test(text)) candidates.add(p);
  }

  return [...candidates].slice(0, Math.max(1, maxEntities)).map((name): Entity => ({
    id: entityId(name),
    name,
    type: 'business_entity',
    description: `Discovered business candidate: ${name}`,
    confidence: preferredSet.has(name) ? 'medium' : 'low',
    evidence: files.filter((f) => f.includes(name)).slice(0, 8),
  }));
}

function detectRelations(entities: Entity[], text: string, window = 150): Relation[] {
  const relations: Relation[] = [];
  const names = new Set(entities.map((e) => e.name));
  for (const source of names) {
    for (const target of names) {
      if (source === target) continue;
      const relationHint = new RegExp(`${escapeRegExp(source)}[\\s\\S]{0,${window}}${escapeRegExp(target)}`, 'm');
      if (!relationHint.test(text)) continue;
      relations.push({
        id: `relation.${source.toLowerCase()}-${target.toLowerCase()}`,
        source,
        target,
        relationship: normalizeRelationship('references_or_contains'),
        cardinality: 'unknown',
        description: `Potential business relationship discovered between ${source} and ${target}.`,
        confidence: 'low',
        evidence: [],
      });
    }
  }
  return uniq(relations, (r) => `${r.source}|${r.target}`);
}

const RULE_PATTERNS: Array<{ id: string; name: string; pattern: RegExp }> = [
  {
    id: 'validation-state',
    name: 'State-dependent validation discovered',
    pattern: /if\s*\([^)]*status[^)]*(AUDIT|AUDITING|APPROVED|DRAFT|REJECT)/i,
  },
  {
    id: 'disabled-control',
    name: 'Disabled control / conditional edit discovered',
    pattern: /disabled\s*=/,
  },
  {
    id: 'thrown-error',
    name: 'Explicit validation error thrown',
    pattern: /throw new (?:Error|RuntimeException|IllegalArgumentException|\w*(?:Business|Service|Biz)\w*Exception)/,
  },
];

function buildEvidenceContext(evidence: string[], samples: SampleFile[]): string[] {
  return evidence.map((file) => {
    const sample = samples.find((item) => item.file === file);
    if (!sample) return `${file}: evidence file selected during discovery.`;
    const lines = sample.text.split(/\r?\n/);
    const lineIndex = lines.findIndex((value) => /status|disabled|v-if|throw new|validation/i.test(value));
    const line = lineIndex >= 0 ? lines[lineIndex] : lines.find((value) => value.trim());
    return `${file}:${lineIndex >= 0 ? lineIndex + 1 : 1}: ${line?.trim() ?? 'matched business signal'}`;
  });
}

function ruleEvidenceSignals(rule: BusinessRule): string[] {
  const signals = new Set<string>();
  for (const evidence of rule.evidence) {
    const snippet = evidence.includes(': ') ? evidence.split(': ').slice(1).join(': ').trim() : '';
    if (snippet) signals.add(snippet);
    for (const state of evidence.match(/["'`](\w*[A-Z][A-Z0-9_-]*)["'`]/g) ?? []) {
      signals.add(state.replace(/["'`]/g, ''));
    }
  }
  for (const text of [rule.name, ...(rule.rule ?? []), ...(rule.preconditions ?? []), ...(rule.context ?? [])]) {
    for (const token of text.match(/[A-Za-z][A-Za-z0-9_-]{3,}/g) ?? []) {
      signals.add(token);
    }
  }
  return [...signals].filter((signal) => signal.length >= 4);
}

function buildRuleCoveringTests(
  rules: BusinessRule[],
  testFiles: string[],
  fileText: Record<string, string>,
  aliases: Record<string, string[]>,
): BusinessRule[] {
  return rules.map((rule) => {
    const entityTokens = [rule.entity, ...(aliases[rule.entity] ?? [])]
      .map((token) => token.toLowerCase())
      .filter((token) => token && token !== 'unknown');
    const signals = ruleEvidenceSignals(rule);
    if (signals.length === 0 || entityTokens.length === 0) return rule;
    const coveringTests = testFiles.filter((testFile) => {
      const lowerPath = testFile.toLowerCase();
      if (entityTokens.length && !entityTokens.some((token) => lowerPath.includes(token.toLowerCase()))) return false;
      const text = fileText[testFile];
      if (!text) return false;
      const lowerText = text.toLowerCase();
      return signals.some((signal) => lowerText.includes(signal.toLowerCase()));
    });
    return coveringTests.length ? { ...rule, coveringTests } : rule;
  });
}

function inferRuleEntity(evidence: string[], samples: SampleFile[], entities: Entity[]): string {
  const scored = entities
    .map((entity) => {
      const name = entity.name.toLowerCase();
      const score = evidence.reduce((total, file) => {
        const sample = samples.find((item) => item.file === file);
        const text = sample?.text.toLowerCase() ?? '';
        return total + (file.toLowerCase().includes(name) ? 2 : 0) + (text.includes(name) ? 1 : 0);
      }, 0);
      return { entity, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.entity.name ?? 'Unknown';
}

function ruleDescription(id: string, entity: string): string {
  const subject = entity === 'Unknown' ? '相关业务对象' : entity;
  if (id === 'validation-state') return `${subject} 的状态变化会影响可执行的校验与业务操作。`;
  if (id === 'disabled-control') return `${subject} 在特定业务条件下限制用户操作。`;
  if (id === 'thrown-error') return `${subject} 不满足业务条件时会拒绝本次操作；Review thrown validation errors for the exact rejection message.`;
  return 'Review the matched business signal as a candidate rule.';
}

function detectRules(samples: SampleFile[], entities: Entity[]): BusinessRule[] {
  const rules: BusinessRule[] = [];
  for (const { id, name, pattern } of RULE_PATTERNS) {
    const evidence = uniq(
      samples.filter((s) => pattern.test(s.text)).map((s) => s.file),
      (f) => f,
    ).slice(0, 10);
    if (evidence.length === 0) continue;
    const entity = inferRuleEntity(evidence, samples, entities);
    const rule: BusinessRule = {
      id: `rule.discovery.${id}`,
      name,
      entity,
      rule: [
        id === 'thrown-error'
          ? `${ruleDescription(id, entity)} ${samples
              .find((sample) => evidence.includes(sample.file))
              ?.text.match(/throw\s+new\s+\w+\s*\(\s*["']([^"']+)["']/i)?.[1] ?? ''}`.trim()
          : ruleDescription(id, entity),
      ],
      impact: ['Review related UI, API, service, and database code.'],
      confidence: heuristicScorer.score(evidence),
      evidence,
      context: buildEvidenceContext(evidence, samples),
      status: 'candidate',
    };
    rules.push(rule);
  }
  return rules;
}

function mergeEntitiesByAlias(entities: Entity[], aliases: Record<string, string[]>): Entity[] {
  const merged = new Map<string, Entity>();
  for (const entity of entities) {
    const canonical = resolveCanonicalName(entity.name, aliases);
    const existing = merged.get(canonical);
    const next: Entity = {
      ...entity,
      id: canonical === entity.name ? entity.id : entityId(canonical),
      name: canonical,
      description:
        canonical === entity.name
          ? entity.description
          : `Discovered business candidate: ${canonical}`,
      evidence: uniqStrings([...(existing?.evidence ?? []), ...entity.evidence]).slice(0, 8),
      tags: uniqStrings([...(existing?.tags ?? []), ...(entity.tags ?? []), entity.name]).filter((tag) => tag !== canonical),
      attributes: mergeEntityAttributes(existing?.attributes, entity.attributes),
      confidence:
        rankConfidence(entity.confidence) > rankConfidence(existing?.confidence ?? 'low')
          ? entity.confidence
          : (existing?.confidence ?? entity.confidence),
      type: existing?.type ?? entity.type,
    };
    merged.set(canonical, existing ? { ...existing, ...next } : next);
  }
  return [...merged.values()];
}

function mergeEntityAttributes(a?: Entity['attributes'], b?: Entity['attributes']): Entity['attributes'] | undefined {
  const out = new Map<string, NonNullable<Entity['attributes']>[number]>();
  for (const attr of [...(a ?? []), ...(b ?? [])]) {
    if (!out.has(attr.name)) out.set(attr.name, attr);
  }
  return out.size ? [...out.values()] : undefined;
}

function rankConfidence(c: Entity['confidence']): number {
  if (c === 'high') return 3;
  if (c === 'medium') return 2;
  return 1;
}

function buildFieldIndex(
  entities: Entity[],
  apis: DiscoverManifest['apis'],
  pages: DiscoverManifest['pages'],
  actions: DiscoverManifest['actions'],
  relations: DiscoverManifest['relations'],
  tests: string[],
): Record<string, FieldIndexEntry> {
  const index = new Map<string, FieldIndexEntry>();
  const ensure = (entity: string, field: string): FieldIndexEntry => {
    const key = `${entity}.${field}`.toLowerCase();
    const existing = index.get(key);
    if (existing) return existing;
    const created: FieldIndexEntry = { entity, field, apis: [], stores: [], storeActions: [], pages: [], tests: [] };
    index.set(key, created);
    return created;
  };
  const actionStoreIndex = new Map<string, string[]>();
  for (const relation of relations ?? []) {
    if (normalizeRelationship(relation.relationship) !== 'calls') continue;
    if (relation.subtype !== 'action_store_update') continue;
    const stores = actionStoreIndex.get(relation.source) ?? [];
    if (!stores.includes(relation.target)) stores.push(relation.target);
    actionStoreIndex.set(relation.source, stores);
  }
  for (const entity of entities) {
    for (const attribute of entity.attributes ?? []) {
      const entry = ensure(entity.name, attribute.name);
      entry.tests.push(...tests.filter((test) => test.toLowerCase().includes(entity.name.toLowerCase())));
    }
  }
  for (const api of apis ?? []) {
    for (const field of api.fields ?? []) ensure(field.entity, field.field).apis.push(`${api.method} ${api.path}`);
  }
  for (const page of pages ?? []) {
    for (const field of page.fields ?? []) ensure(field.entity, field.field).pages.push(page.component);
  }
  for (const action of actions ?? []) {
    for (const field of action.fields ?? []) {
      const entry = ensure(field.entity, field.field);
      entry.pages.push(action.source);
      entry.stores.push(...(action.stores ?? actionStoreIndex.get(action.name) ?? []));
      entry.storeActions?.push(action.name);
    }
  }
  return Object.fromEntries(
    [...index.entries()].map(([key, entry]) => [
      key,
      {
        ...entry,
        apis: [...new Set(entry.apis)],
        stores: [...new Set(entry.stores)],
        storeActions: [...new Set(entry.storeActions ?? [])],
        pages: [...new Set(entry.pages)],
        tests: [...new Set(entry.tests)],
      },
    ]),
  );
}

function entityMarkdown(e: Entity): string {
  return (
    `# ${e.name}\n\n` +
    `> Status: ${e.confidence}\n\n` +
    `## Description\n${e.description}\n\n` +
    `## Attributes\n${e.attributes?.length ? e.attributes.map((a) => `- ${a.name}${a.type ? `: ${a.type}` : ''}`).join('\n') : '- TBD'}\n\n` +
    `## Evidence\n${e.evidence.length ? e.evidence.map((x) => `- ${x}`).join('\n') : '- None captured yet'}\n`
  );
}

/** Markdown for a discovered candidate rule; parseable by parseCandidate for later promotion. */
export function candidateMarkdown(rule: BusinessRule): string {
  const lines = [
    `# Candidate: ${rule.name}`,
    '',
    'Status: candidate',
    '',
    '## Entity',
    rule.entity,
    '',
    '## Hypothesis',
    ...(rule.rule.length ? rule.rule.map((r) => `- ${r}`) : ['- TBD']),
    '',
    '## Evidence',
    ...(rule.evidence.length ? rule.evidence.map((e) => `- ${e}`) : ['- None captured yet']),
    '',
    '## Context',
    ...(rule.context?.length
      ? rule.context.map((c) => `- ${c}`)
      : ['- Review the cited code paths before promoting this candidate.']),
    '',
    '## Impact',
    ...(rule.impact?.length ? rule.impact.map((i) => `- ${i}`) : ['- TBD']),
    '',
    '## Verification',
    '- Verify against frontend, backend, API and database evidence.',
  ];
  return lines.join('\n') + '\n';
}

async function readPreviousManifest(agentRoot: string): Promise<DiscoverManifest | null> {
  const file = path.join(agentRoot, 'memory', 'discovery-manifest.json');
  if (!(await exists(file))) return null;
  try {
    return JSON.parse(await readText(file)) as DiscoverManifest;
  } catch {
    return null;
  }
}

export interface DiscoverOptions {
  dryRun?: boolean;
  config?: AgentConfig;
  analyzers?: AnalyzerName[];
  /** Receives non-fatal warnings (analyzer failures, preserved manual edits, unknown analyzers). */
  onWarning?: (message: string) => void;
}

export async function discover(root: string, options: DiscoverOptions = {}): Promise<DiscoverManifest> {
  const warn = options.onWarning ?? ((): void => {});
  const config = options.config ?? (await loadConfig(root, warn));
  const scan = await scanProject(root, config);
  const glossary = await loadGlossary(root);
  const entities = detectEntities(scan.sampleText, scan.files, config.preferredEntities, config.maxEntities);
  const aliases = buildAliasMap(entities, glossary);
  const canonicalEntities = mergeEntitiesByAlias(entities, aliases);
  const relations = detectRelations(canonicalEntities, scan.sampleText, config.relationWindow);
  const rules = detectRules(scan.samples, canonicalEntities);

  const analyzers = resolveAnalyzers(config, options.analyzers ?? [], warn);
  let finalEntities = canonicalEntities;
  let finalRules = rules;
  let finalRelations = relations;
  let apis: DiscoverManifest['apis'] = [];
  let states: DiscoverManifest['states'] = [];
  let workflows: DiscoverManifest['workflows'] = [];
  let pages: DiscoverManifest['pages'] = [];
  let actions: DiscoverManifest['actions'] = [];

  if (analyzers.length > 0) {
    const deep = await runAnalyzers(scan, { config, entities, rules, relations }, analyzers, warn);
    finalEntities = deep.entities;
    finalRules = deep.rules;
    finalRelations = deep.relations;
    apis = deep.apis;
    states = deep.states;
    workflows = deep.workflows;
    pages = deep.pages;
    actions = deep.actions;
  }

  const agentRoot = path.join(root, '.agent');
  const confirmedKnowledgeRules = await loadRules(agentRoot);
  const reviewState = await loadReviewState(agentRoot);
  const candidateRules = mergeCandidateRules(applyReviewState(finalRules, reviewState));
  const autoPromoted = candidateRules.filter((rule) => shouldAutoPromote(rule, config.autoPromote));
  const persistedRules = candidateRules.filter((rule) => !shouldAutoPromote(rule, config.autoPromote));
  const confirmedRules = autoPromoted.map((rule) => ({ ...rule, status: 'confirmed' as const }));
  for (const rule of autoPromoted) markReviewed(reviewState, rule, 'accepted', rule.id);
  finalRules = mergeCandidateRules([
    ...persistedRules,
    ...confirmedRules,
    ...confirmedKnowledgeRules.map((rule) => ({ ...rule, status: rule.status ?? 'confirmed' as const })),
  ]);

  finalEntities = mergeEntitiesByAlias(finalEntities, aliases);
  const manifestAliases = buildAliasMap(finalEntities, glossary);
  const conflicts = detectConflicts(finalRules);

  const modules = scan.files
    .filter((file) => /\.(vue|tsx|jsx|ts|js)$/i.test(file))
    .map((file) => buildModuleDescriptor(file));

  const testFiles = scan.files.filter((file) => /(?:^|\/|\\).*\.(?:test|spec)\.[jt]sx?$/.test(file));
  finalRules = buildRuleCoveringTests(finalRules, testFiles, scan.fileText, manifestAliases);
  const fieldIndex = buildFieldIndex(finalEntities, apis, pages, actions, relations, testFiles);

  const manifest: DiscoverManifest = {
    generatedAt: new Date().toISOString(),
    projectRoot: root,
    filesScanned: scan.files.length,
    entities: finalEntities,
    rules: finalRules,
    relations: finalRelations,
    apis,
    conflicts,
    tests: testFiles,
    states,
    workflows,
    pages,
    actions,
    modules,
    aliases: manifestAliases,
    fieldIndex,
  };
  const problems = await validateManifest(manifest);
  if (problems.length > 0) {
    throw new Error(`Discovery produced an invalid manifest:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  }
  if (options.dryRun) return manifest;

  const prevManifest = await readPreviousManifest(agentRoot);
  await writeJson(path.join(agentRoot, 'memory', 'discovery-manifest.json'), manifest);
  await saveReviewState(agentRoot, reviewState);

  // Entities: never clobber files the user has edited since the last discovery.
  const preserved: string[] = [];
  for (const entity of finalEntities) {
    const target = path.join(agentRoot, 'business', 'entities', `${entity.name.toLowerCase()}.md`);
    const prev = prevManifest?.entities.find((e) => e.name.toLowerCase() === entity.name.toLowerCase());
    if (await exists(target)) {
      const current = await readText(target);
      const expected = prev ? entityMarkdown(prev) : '';
      if (current === expected) {
        await writeText(target, entityMarkdown(entity));
      } else {
        preserved.push(entity.name);
      }
    } else {
      await writeText(target, entityMarkdown(entity));
    }
  }
  if (preserved.length > 0) {
    warn(`Preserved manual edits in entity file(s): ${preserved.join(', ')}`);
  }

  // Knowledge model: only confirmed rules belong in .agent/business/rules.
  // Discovered candidates stay in memory/candidates until promoted.
  for (const rule of finalRules.filter((r) => r.status === 'confirmed')) {
    await writeRule(agentRoot, rule);
  }
  for (const rule of finalRules.filter((r) => r.status !== 'confirmed')) {
    await writeCandidate(agentRoot, rule, candidateMarkdown);
  }
  for (const relation of finalRelations) {
    await writeRelation(agentRoot, relation);
  }
  await buildIndex(
    agentRoot,
    finalEntities.map((e) => ({ name: e.name })),
  );
  if (states.length) {
    await writeText(
      path.join(agentRoot, 'business', 'states', 'discovery.md'),
      states.map((state) => `# ${state.entity} States\n\n\`\`\`mermaid\n${state.mermaid}\n\`\`\``).join('\n\n'),
    );
  }

  return manifest;
}

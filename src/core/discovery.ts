import path from 'node:path';
import { buildModuleDescriptor } from './module-id.js';
import {
  applyGlossaryEnrichment,
  buildAliasArtifacts,
  getEntityAliases,
  loadGlossary,
  normalizeTerm,
  resolveCanonicalNameFromIndex,
} from './glossary.js';
import {
  normalizeRelationship,
  type DiscoverManifest,
  type Entity,
  type BusinessRule,
  type Relation,
  type FieldIndexEntry,
} from './types.js';
import { scanProject, type SampleFile } from './scanner.js';
import { loadConfig, type AgentConfig, type AnalyzerName } from './config.js';
import { validateManifest } from './validate.js';
import { heuristicScorer } from './evidence.js';
import { isSkeletonDescription, isSqlTableDescription, skeletonDescription } from './entity-description.js';
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

  return [...candidates].slice(0, Math.max(1, maxEntities)).map((name): Entity => {
    const evidence = files.filter((f) => f.includes(name)).slice(0, 8);
    return {
      id: entityId(name),
      name,
      type: 'business_entity',
      description: skeletonDescription(name, evidence),
      confidence: preferredSet.has(name) ? 'medium' : 'low',
      evidence,
    };
  });
}

/**
 * Copy discovered lifecycle states onto the entities they belong to, so consumers
 * can read `entity.states` instead of re-matching state machines by entity name.
 */
function attachEntityStates(
  entities: Entity[],
  states: DiscoverManifest['states'],
  aliasToEntity: Record<string, string>,
): Entity[] {
  if (!states?.length) return entities;
  const statesByEntity = new Map<string, string[]>();
  for (const machine of states) {
    const canonical = resolveCanonicalNameFromIndex(machine.entity, aliasToEntity);
    statesByEntity.set(canonical, uniqStrings([...(statesByEntity.get(canonical) ?? []), ...machine.states]));
  }
  return entities.map((entity) => {
    const canonical = resolveCanonicalNameFromIndex(entity.name, aliasToEntity);
    const matched = statesByEntity.get(canonical) ?? statesByEntity.get(entity.name);
    if (!matched?.length) return entity;
    return { ...entity, states: uniqStrings([...(entity.states ?? []), ...matched]) };
  });
}

function detectRelations(textEntities: Entity[], samples: SampleFile[], window = 150): Relation[] {
  const relations: Relation[] = [];
  const names = [...new Set(textEntities.map((e) => e.name))];
  // Pre-index the sample files mentioning each entity so per-pair regex checks
  // only run on the intersection instead of the whole concatenated repo text.
  const filesByName = new Map<string, Set<string>>();
  const textByFile = new Map(samples.map((sample) => [sample.file, sample.text]));
  for (const name of names) {
    const needle = name.toLowerCase();
    filesByName.set(
      name,
      new Set(samples.filter((sample) => sample.text.toLowerCase().includes(needle)).map((sample) => sample.file)),
    );
  }
  for (const source of names) {
    for (const target of names) {
      if (source === target) continue;
      const sourceFiles = filesByName.get(source) ?? new Set<string>();
      const targetFiles = filesByName.get(target) ?? new Set<string>();
      const coFiles = [...sourceFiles].filter((file) => targetFiles.has(file));
      if (!coFiles.length) continue;
      const relationHint = new RegExp(`${escapeRegExp(source)}[\\s\\S]{0,${window}}${escapeRegExp(target)}`, 'm');
      const structuralHint = new RegExp(
        `(?:extends|implements|imports?|has|contains|references|belongsTo|\\b${escapeRegExp(source)}\\b[\\s\\S]{0,40}(?:\\.|<|\\[))`,
        'i',
      );
      // Co-occurrence and the structural hint must hold inside the SAME file, and
      // that file (with the matching line) becomes the evidence — cross-file
      // co-occurrence is noise (G2.3), and a bare file list cannot be reviewed
      // without re-searching (aligned with rule evidence "file:line" format).
      const evidence: string[] = [];
      for (const file of coFiles) {
        const text = textByFile.get(file) ?? '';
        relationHint.lastIndex = 0;
        const match = relationHint.exec(text);
        if (!match || !structuralHint.test(text)) continue;
        const line = text.slice(0, match.index).split(/\r?\n/).length;
        evidence.push(`${file}:${line}`);
      }
      if (!evidence.length) continue;
      relations.push({
        id: `relation.${source.toLowerCase()}-${target.toLowerCase()}`,
        source,
        target,
        relationship: normalizeRelationship('references_or_contains'),
        cardinality: 'unknown',
        description: `Potential business relationship discovered between ${source} and ${target}.`,
        confidence: 'low',
        evidence,
      });
    }
  }
  return uniq(relations, (r) => `${r.source}|${r.target}`);
}

/**
 * Relation ids are assembled from entity/module names that may contain
 * characters outside the schema pattern (`^relation\.[a-z0-9._-]+$`), e.g.
 * `module:src/order.ts` or Chinese glossary aliases — a real-project manifest
 * would otherwise fail validation. Rewrites every id once, before it is
 * persisted, and guarantees uniqueness after sanitization.
 */
function sanitizeRelationIds(relations: Relation[]): Relation[] {
  const seen = new Set<string>();
  return relations.map((relation) => {
    const base = relation.id
      .replace(/^relation\./i, '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    let id = `relation.${base}`;
    let suffix = 2;
    while (seen.has(id)) id = `relation.${base}-${suffix++}`;
    seen.add(id);
    return id === relation.id ? relation : { ...relation, id };
  });
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
  aliasesByEntity: Record<string, string[]>,
  aliasIndex: Record<string, string>,
): BusinessRule[] {
  return rules.map((rule) => {
    const canonicalEntity = resolveCanonicalNameFromIndex(rule.entity, aliasIndex);
    const entityTokens = [canonicalEntity, ...getEntityAliases(canonicalEntity, aliasesByEntity)]
      .flatMap((token) => [token, token.endsWith('s') ? token.slice(0, -1) : `${token}s`])
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
    return coveringTests.length
      ? { ...rule, entity: canonicalEntity, coveringTests }
      : { ...rule, entity: canonicalEntity };
  });
}

/**
 * Entities that are framework/type scaffolding rather than business objects.
 * Rules matched on shared patterns (e.g. `disabled=` appears in every Vue
 * component) used to attach to the most co-occurring name — which was usually
 * `Props`/`ApiResponse`. Skipping these lets the rule attach to the business
 * entity that actually owns the file.
 */
const TECHNICAL_ENTITY_RE =
  /^(?:props|ref|query|auth|system|app|group|image|chatmessage|messagerole|importmeta|importmetaenv|processenv|qform|dictitem|codeoption|resultdialogline|apiresponse|nvhl|coverageitem|suite?dictoption)$/i;

function inferRuleEntity(evidence: string[], samples: SampleFile[], entities: Entity[]): string {
  const scored = entities
    .filter((entity) => !TECHNICAL_ENTITY_RE.test(entity.name))
    .map((entity) => {
      const name = entity.name.toLowerCase();
      let fileHits = 0;
      let textHits = 0;
      for (const file of evidence) {
        const sample = samples.find((item) => item.file === file);
        const text = sample?.text.toLowerCase() ?? '';
        // A file path containing the entity name is a strong signal (the file
        // belongs to that entity); bare text co-occurrence is weak.
        if (file.toLowerCase().includes(name)) fileHits += 1;
        if (text.includes(name)) textHits += 1;
      }
      return { entity, score: fileHits * 10 + textHits };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.entity.name.length - a.entity.name.length);
  return scored[0]?.entity.name ?? 'Unknown';
}

function ruleDescription(id: string, entity: string): string {
  const subject = entity === 'Unknown' ? '相关业务对象' : entity;
  if (id === 'validation-state') return `${subject} 的状态变化会影响可执行的校验与业务操作。`;
  if (id === 'disabled-control') return `${subject} 在特定业务条件下限制用户操作。`;
  if (id === 'thrown-error')
    return `${subject} 不满足业务条件时会拒绝本次操作；Review thrown validation errors for the exact rejection message.`;
  return 'Review the matched business signal as a candidate rule.';
}

/** First comparison inside a matched snippet, e.g. `order.status = AUDIT`. */
const RULE_CONDITION_RE = /([A-Za-z_$][\w$.]*)\s*(?:===?|!==?)\s*["']?([A-Za-z0-9_-]+)["']?/;
/** Role keywords that turn a matched snippet into a structured precondition. */
const RULE_ROLE_RE = /\b(?:admin(?:istrator)?|superuser|管理员|超管)\b/i;

function normalizeRuleSnippet(snippet: string): string | undefined {
  const trimmed = snippet.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

/**
 * Turn the matched code snippet into a concrete rule condition (G3.2): the raw
 * comparison text is quoted so candidates read like "when status = AUDIT"
 * instead of a generic template, and role words become structured preconditions
 * for the semantic conflict detector (G3.5).
 */
function enrichRuleText(snippet: string | undefined): { condition?: string; preconditions?: string[] } {
  if (!snippet) return {};
  const condition = normalizeRuleSnippet(snippet);
  const preconditions: string[] = [];
  const comparison = snippet.match(RULE_CONDITION_RE);
  if (comparison) preconditions.push(`${comparison[1]} = ${comparison[2]}`);
  if (RULE_ROLE_RE.test(snippet)) preconditions.push('role: admin');
  return { condition, preconditions: preconditions.length ? preconditions : undefined };
}

function detectRules(samples: SampleFile[], entities: Entity[]): BusinessRule[] {  const rules: BusinessRule[] = [];
  for (const { id, name, pattern } of RULE_PATTERNS) {
    const evidence: string[] = [];
    let firstSnippet: string | undefined;
    for (const sample of samples) {
      const matched = sample.text.match(pattern);
      if (!matched) continue;
      if (!firstSnippet) firstSnippet = matched[0];
      evidence.push(sample.file);
      if (evidence.length >= 10) break;
    }
    if (evidence.length === 0) continue;
    const entity = inferRuleEntity(evidence, samples, entities);
    const { condition, preconditions } = enrichRuleText(firstSnippet);
    const ruleText = [
      ruleDescription(id, entity),
      ...(id === 'thrown-error'
        ? [
            samples
              .find((sample) => evidence.includes(sample.file))
              ?.text.match(/throw\s+new\s+\w+\s*\(\s*["']([^"']+)["']/i)?.[1] ?? '',
          ]
        : []),
      ...(condition ? [`匹配条件: \`${condition}\`。`] : []),
    ]
      .join(' ')
      .trim();
    const rule: BusinessRule = {
      id: `rule.discovery.${id}`,
      name,
      entity,
      rule: [ruleText],
      impact: ['Review related UI, API, service, and database code.'],
      confidence: heuristicScorer.score(evidence),
      evidence,
      context: buildEvidenceContext(evidence, samples),
      status: 'candidate',
      ...(preconditions ? { preconditions } : {}),
    };
    rules.push(rule);
  }
  return rules;
}

function mergeEntitiesByAlias(entities: Entity[], aliasIndex: Record<string, string>): Entity[] {
  const merged = new Map<string, Entity>();

  for (const entity of entities) {
    const canonical = resolveCanonicalNameFromIndex(entity.name, aliasIndex);
    const existing = merged.get(canonical);
    const next: Entity = {
      ...entity,
      id: canonical === entity.name ? entity.id : entityId(canonical),
      name: canonical,
      description: canonical === entity.name ? entity.description : skeletonDescription(canonical, entity.evidence),
      evidence: uniqStrings([...(existing?.evidence ?? []), ...entity.evidence]).slice(0, 8),
      tags: uniqStrings([...(existing?.tags ?? []), ...(entity.tags ?? []), entity.name]).filter(
        (tag) => tag !== canonical,
      ),
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
  aliasIndex: Record<string, string>,
  fileText: Record<string, string>,
): Record<string, FieldIndexEntry> {
  const index = new Map<string, FieldIndexEntry>();
  const addFieldEvidence = (entry: FieldIndexEntry, field: string, files: string[]): void => {
    const fieldPattern = new RegExp(`\\b${escapeRegExp(field)}\\b`);
    for (const file of files) {
      const text = fileText[file];
      if (!text) continue;
      const line = text.split(/\r?\n/).findIndex((value) => fieldPattern.test(value));
      if (line >= 0) entry.evidence?.push(`${file}:${line + 1}`);
    }
  };
  const ensure = (entity: string, field: string): FieldIndexEntry => {
    const canonicalEntity = resolveCanonicalNameFromIndex(entity, aliasIndex);
    const key = `${canonicalEntity}.${field}`.toLowerCase();
    const existing = index.get(key);
    if (existing) return existing;
    const created: FieldIndexEntry = {
      entity: canonicalEntity,
      field,
      apis: [],
      stores: [],
      storeActions: [],
      pages: [],
      tests: [],
      evidence: [],
    };
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
      entry.evidence?.push(...entity.evidence);
      addFieldEvidence(entry, attribute.name, entity.evidence);
      entry.tests.push(...tests.filter((test) => test.toLowerCase().includes(entity.name.toLowerCase())));
    }
  }
  for (const api of apis ?? []) {
    for (const field of api.fields ?? []) {
      const entry = ensure(field.entity, field.field);
      entry.apis.push(`${api.method} ${api.path}`);
      entry.evidence?.push(...api.evidence);
      addFieldEvidence(entry, field.field, api.evidence);
    }
  }
  for (const page of pages ?? []) {
    for (const field of page.fields ?? []) {
      const entry = ensure(field.entity, field.field);
      entry.pages.push(page.component);
      addFieldEvidence(entry, field.field, page.evidence);
    }
  }
  for (const action of actions ?? []) {
    for (const field of action.fields ?? []) {
      const entry = ensure(field.entity, field.field);
      entry.pages.push(action.source);
      entry.evidence?.push(...action.evidence);
      addFieldEvidence(entry, field.field, action.evidence);
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
        evidence: [...new Set(entry.evidence ?? [])],
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
    `## States\n${e.states?.length ? e.states.map((s) => `- ${s}`).join('\n') : '- None discovered'}\n\n` +
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
  files?: string[];
  /** Receives non-fatal warnings (analyzer failures, preserved manual edits, unknown analyzers). */
  onWarning?: (message: string) => void;
}

export async function discover(root: string, options: DiscoverOptions = {}): Promise<DiscoverManifest> {
  const warn = options.onWarning ?? ((): void => {});
  const config = options.config ?? (await loadConfig(root, warn));
  const fullScan = await scanProject(root, config);
  const selectedFiles = options.files?.length
    ? new Set(options.files.map((file) => file.replaceAll('/', path.sep).replaceAll('\\', path.sep)))
    : undefined;
  const scan = selectedFiles
    ? {
        root,
        files: fullScan.files.filter((file) => selectedFiles.has(file)),
        sampleText: fullScan.samples
          .filter((sample) => selectedFiles.has(sample.file))
          .map((sample) => `\n--- ${sample.file} ---\n${sample.text}`)
          .join('\n'),
        samples: fullScan.samples.filter((sample) => selectedFiles.has(sample.file)),
        fileText: Object.fromEntries(Object.entries(fullScan.fileText).filter(([file]) => selectedFiles.has(file))),
      }
    : fullScan;
  const glossary = await loadGlossary(root);
  const entities = detectEntities(scan.sampleText, scan.files, config.preferredEntities, config.maxEntities);
  const initialAliases = buildAliasArtifacts(entities, glossary);
  const canonicalEntities = mergeEntitiesByAlias(entities, initialAliases.aliasToEntity);
  const relations = detectRelations(canonicalEntities, scan.samples, config.relationWindow);
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
    ...confirmedKnowledgeRules.map((rule) => ({ ...rule, status: rule.status ?? ('confirmed' as const) })),
  ]);

  const finalAliasArtifacts = buildAliasArtifacts(finalEntities, glossary);
  finalEntities = mergeEntitiesByAlias(finalEntities, finalAliasArtifacts.aliasToEntity);
  // Glossary terms become entity tags and enrich skeleton descriptions (G1.2);
  // runs before the alias artifacts are rebuilt so the terms are indexed too.
  finalEntities = applyGlossaryEnrichment(finalEntities, glossary);
  finalEntities = finalEntities.filter(
    (entity) =>
      !(
        isSkeletonDescription(entity.description) &&
        finalEntities.some(
          (candidate) =>
            candidate !== entity &&
            candidate.name !== entity.name &&
            candidate.evidence.some((evidence) => entity.evidence.includes(evidence)),
        )
      ),
  );
  const manifestAliasArtifacts = buildAliasArtifacts(finalEntities, glossary);
  finalEntities = attachEntityStates(finalEntities, states, manifestAliasArtifacts.aliasToEntity);
  const sqlAliasIndex = { ...manifestAliasArtifacts.aliasToEntity };
  for (const entity of finalEntities) {
    if (!isSqlTableDescription(entity.description)) continue;
    const singular = entity.name.endsWith('s') ? entity.name.slice(0, -1) : entity.name;
    const normalized = normalizeTerm(entity.name);
    if (
      singular !== entity.name &&
      finalEntities.some((candidate) => candidate.name === singular && !isSqlTableDescription(candidate.description))
    ) {
      sqlAliasIndex[normalized] = singular;
    }
  }
  finalRules = buildRuleCoveringTests(
    finalRules,
    scan.files.filter((file) => /(?:^|\/|\\).*\.(?:test|spec)\.[jt]sx?$/.test(file)),
    scan.fileText,
    manifestAliasArtifacts.aliasesByEntity,
    sqlAliasIndex,
  ).map((rule) => ({
    ...rule,
    entity: resolveCanonicalNameFromIndex(rule.entity, manifestAliasArtifacts.aliasToEntity),
  }));
  const conflicts = detectConflicts(finalRules);

  const modules = scan.files
    .filter((file) => /\.(vue|tsx|jsx|ts|js)$/i.test(file))
    .map((file) => buildModuleDescriptor(file));

  const testFiles = scan.files.filter((file) => /(?:^|\/|\\).*\.(?:test|spec)\.[jt]sx?$/.test(file));
  const fieldIndex = buildFieldIndex(
    finalEntities,
    apis,
    pages,
    actions,
    finalRelations,
    testFiles,
    sqlAliasIndex,
    scan.fileText,
  );
  for (const api of apis) {
    if (api.kind !== 'backend') continue;
    for (const field of api.fields ?? []) {
      const canonicalEntity = resolveCanonicalNameFromIndex(field.entity, sqlAliasIndex);
      const key = `${canonicalEntity}.${field.field}`.toLowerCase();
      fieldIndex[key] ??= {
        entity: canonicalEntity,
        field: field.field,
        apis: [],
        stores: [],
        pages: [],
        tests: [],
        evidence: [],
      };
      fieldIndex[key].evidence?.push(...api.evidence);
      const route = `${api.method} ${api.path}`;
      if (!fieldIndex[key].apis.includes(route)) fieldIndex[key].apis.push(route);
    }
  }
  for (const entity of finalEntities) {
    for (const attribute of entity.attributes ?? []) {
      const key = `${entity.name}.${attribute.name}`.toLowerCase();
      fieldIndex[key] ??= {
        entity: entity.name,
        field: attribute.name,
        apis: [],
        stores: [],
        pages: [],
        tests: [],
        evidence: [],
      };
    }
  }

  // Sanitize once and reuse for BOTH the manifest and the confirmed knowledge
  // files: writing the raw finalRelations to .agent/business/relationships
  // re-introduced ids with ':'/'/' on every re-run, breaking schema validation.
  const manifestRelations = sanitizeRelationIds(finalRelations);
  const manifest: DiscoverManifest = {
    generatedAt: new Date().toISOString(),
    projectRoot: root,
    filesScanned: scan.files.length,
    entities: finalEntities,
    rules: finalRules,
    relations: manifestRelations,
    apis,
    conflicts,
    tests: testFiles,
    states,
    workflows,
    pages,
    actions,
    modules,
    aliases: manifestAliasArtifacts.aliasesByEntity,
    aliasIndex: sqlAliasIndex,
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

  for (const rule of finalRules.filter((r) => r.status === 'confirmed')) {
    await writeRule(agentRoot, rule);
  }
  for (const rule of finalRules.filter((r) => r.status !== 'confirmed')) {
    await writeCandidate(agentRoot, rule, candidateMarkdown);
  }
  for (const relation of manifestRelations) {
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

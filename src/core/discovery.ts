import path from 'node:path';
import type { DiscoverManifest, Entity, BusinessRule, Relation } from './types.js';
import { scanProject, type SampleFile } from './scanner.js';
import { loadConfig, type AgentConfig, type AnalyzerName } from './config.js';
import { validateManifest } from './validate.js';
import { heuristicScorer } from './evidence.js';
import { runAnalyzers, resolveAnalyzers } from './analyzer.js';
import { detectConflicts } from './conflicts.js';
import { writeRule, writeRelation, buildIndex } from './knowledge.js';
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
        relationship: 'references_or_contains',
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
    pattern: /throw new (?:Error|RuntimeException|IllegalArgumentException)/,
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

function detectRules(samples: SampleFile[]): BusinessRule[] {
  const rules: BusinessRule[] = [];
  for (const { id, name, pattern } of RULE_PATTERNS) {
    const evidence = uniq(
      samples.filter((s) => pattern.test(s.text)).map((s) => s.file),
      (f) => f,
    ).slice(0, 10);
    if (evidence.length === 0) continue;
    const rule: BusinessRule = {
      id: `rule.discovery.${id}`,
      name,
      entity: 'Unknown',
      rule: [
        'Review the matched conditions, disabled controls, and thrown validation errors as candidate business rules.',
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
  const entities = detectEntities(scan.sampleText, scan.files, config.preferredEntities, config.maxEntities);
  const relations = detectRelations(entities, scan.sampleText, config.relationWindow);
  const rules = detectRules(scan.samples);

  const analyzers = resolveAnalyzers(config, options.analyzers ?? [], warn);
  let finalEntities = entities;
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
  const reviewState = await loadReviewState(agentRoot);
  const candidateRules = mergeCandidateRules(applyReviewState(finalRules, reviewState));
  const autoPromoted = candidateRules.filter((rule) => shouldAutoPromote(rule, config.autoPromote));
  const persistedRules = candidateRules.filter((rule) => !shouldAutoPromote(rule, config.autoPromote));
  const confirmedRules = autoPromoted.map((rule) => ({ ...rule, status: 'confirmed' as const }));
  for (const rule of autoPromoted) markReviewed(reviewState, rule, 'accepted', rule.id);
  finalRules = [...persistedRules, ...confirmedRules];

  const conflicts = detectConflicts(finalRules);

  const manifest: DiscoverManifest = {
    generatedAt: new Date().toISOString(),
    projectRoot: root,
    filesScanned: scan.files.length,
    entities: finalEntities,
    rules: finalRules,
    relations: finalRelations,
    apis,
    conflicts,
    tests: scan.files.filter((file) => /(?:^|\/|\\).*\.(?:test|spec)\.[jt]sx?$/.test(file)),
    states,
    workflows,
    pages,
    actions,
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

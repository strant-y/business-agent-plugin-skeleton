import path from 'node:path';
import { normalizeRelationship, type BusinessRule, type Relation } from './types.js';
import { readText, writeJson, writeText, exists } from '../utils/fs.js';

export function safeFileId(id: string): string {
  return id
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

export function ruleMarkdown(rule: BusinessRule): string {
  const lines = [
    `# ${rule.name}`,
    '',
    `> Status: ${rule.status ?? 'candidate'} | Confidence: ${rule.confidence}`,
    '',
    `## Entity\n${rule.entity}`,
    '',
    '## Rule',
    ...(rule.rule.length ? rule.rule.map((r) => `- ${r}`) : ['- TBD']),
    '',
    '## Preconditions',
    ...(rule.preconditions?.length ? rule.preconditions.map((p) => `- ${p}`) : ['- None']),
    '',
    '## Exceptions',
    ...(rule.exceptions?.length ? rule.exceptions.map((x) => `- ${x}`) : ['- None']),
    '',
    '## Impact',
    ...(rule.impact?.length ? rule.impact.map((i) => `- ${i}`) : ['- TBD']),
    '',
    '## Evidence',
    ...(rule.evidence.length ? rule.evidence.map((e) => `- ${e}`) : ['- None captured yet']),
  ];
  return lines.join('\n') + '\n';
}

export function relationMarkdown(relation: Relation): string {
  return (
    [
      `# ${relation.source} → ${relation.target}`,
      '',
      `> Relationship: ${relation.relationship} | Cardinality: ${relation.cardinality} | Confidence: ${relation.confidence}`,
      '',
      '## Description',
      relation.description ?? '- TBD',
      '',
      '## Evidence',
      ...(relation.evidence.length ? relation.evidence.map((e) => `- ${e}`) : ['- None captured yet']),
    ].join('\n') + '\n'
  );
}

export function impactMarkdown(subject: string, items: string[], evidence: string[]): string {
  return (
    [
      `# Impact Map: ${subject}`,
      '',
      '## Affected Areas',
      ...(items.length ? items.map((i) => `- ${i}`) : ['- TBD']),
      '',
      '## Evidence',
      ...(evidence.length ? evidence.map((e) => `- ${e}`) : ['- None captured yet']),
      '',
      '## Review Checklist',
      '- Confirm which business rules, states and workflows are affected.',
      '- Trace API and database evidence.',
      '- Update this map before changing business behavior.',
    ].join('\n') + '\n'
  );
}

export async function writeRule(agentRoot: string, rule: BusinessRule): Promise<string> {
  const base = safeFileId(rule.id);
  await writeJson(path.join(agentRoot, 'business', 'rules', `${base}.json`), rule);
  await writeText(path.join(agentRoot, 'business', 'rules', `${base}.md`), ruleMarkdown(rule));
  await writeText(
    path.join(agentRoot, 'business', 'impact', `${base}.md`),
    impactMarkdown(rule.name, rule.impact ?? [], rule.evidence),
  );
  return base;
}

export async function writeRelation(agentRoot: string, relation: Relation): Promise<string> {
  const base = safeFileId(relation.id);
  await writeJson(path.join(agentRoot, 'business', 'relationships', `${base}.json`), relation);
  await writeText(path.join(agentRoot, 'business', 'relationships', `${base}.md`), relationMarkdown(relation));
  await writeText(
    path.join(agentRoot, 'business', 'impact', `${base}.md`),
    impactMarkdown(
      `${relation.source} → ${relation.target}`,
      [
        relation.relationship,
        ...(relation.subtype ? [`subtype: ${relation.subtype}`] : []),
        ...(relation.provenance ? [`provenance: ${relation.provenance}`] : []),
      ],
      relation.evidence,
    ),
  );
  return base;
}

export async function loadRules(agentRoot: string): Promise<BusinessRule[]> {
  return loadJsonDir<BusinessRule>(path.join(agentRoot, 'business', 'rules'));
}

export async function loadRelations(agentRoot: string): Promise<Relation[]> {
  const relations = await loadJsonDir<Relation>(path.join(agentRoot, 'business', 'relationships'));
  return relations.map((relation) => ({ ...relation, relationship: normalizeRelationship(relation.relationship) }));
}

export async function listImpacts(agentRoot: string): Promise<string[]> {
  const dir = path.join(agentRoot, 'business', 'impact');
  if (!(await exists(dir))) return [];
  const entries = await import('node:fs/promises').then((fs) => fs.readdir(dir, { withFileTypes: true }));
  return entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => `impact/${e.name}`);
}

async function loadJsonDir<T>(dir: string): Promise<T[]> {
  if (!(await exists(dir))) return [];
  const fs = await import('node:fs/promises');
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: T[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(await readText(path.join(dir, entry.name))) as T);
    } catch {
      // Ignore malformed knowledge files.
    }
  }
  return out;
}

export async function buildIndex(agentRoot: string, entities: Array<{ name: string }>): Promise<void> {
  const rules = await loadRules(agentRoot);
  const relations = await loadRelations(agentRoot);
  const index =
    [
      '# Business Knowledge Index',
      '',
      'This is the entry point for business-aware agents.',
      '',
      '## Entities',
      ...(entities.length
        ? entities.map((e) => `- [${e.name}](./entities/${e.name.toLowerCase()}.md)`)
        : ['- None discovered yet']),
      '',
      '## Rules',
      ...(rules.length ? rules.map((r) => `- [${r.name}](./rules/${safeFileId(r.id)}.md)`) : ['- None yet']),
      '',
      '## Relationships',
      ...(relations.length
        ? relations.map((r) => `- [${r.source} → ${r.target}](./relationships/${safeFileId(r.id)}.md)`)
        : ['- None yet']),
      '',
      '## Impact Maps',
      ...(await listImpacts(agentRoot)).map((i) => `- [${i}](./${i})`),
      '',
      '## Context',
      'Use `business-agent context <subject>` to build a task-specific context package.',
    ].join('\n') + '\n';
  await writeText(path.join(agentRoot, 'business', 'INDEX.md'), index);
}

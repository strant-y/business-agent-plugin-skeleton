import path from 'node:path';
import { exists, readText, writeText } from '../utils/fs.js';
import { parseCandidate, buildRuleFromCandidate, buildRelationFromInput } from '../core/candidate.js';
import { isRelationshipValue } from '../core/types.js';
import { writeRule, writeRelation, buildIndex, loadRules, loadRelations } from '../core/knowledge.js';
import { validateRule, validateRelation } from '../core/validate.js';
import type { Relation } from '../core/types.js';

export interface PromoteOptions {
  type?: 'rule' | 'relation';
  entity?: string;
  source?: string;
  target?: string;
  relationship?: string;
  cardinality?: string;
  json?: boolean;
  dryRun?: boolean;
}

const CARDINALITIES = ['1:1', '1:N', 'N:1', 'N:M', 'unknown'] as const;

function isCardinality(value: string): value is Relation['cardinality'] {
  return (CARDINALITIES as readonly string[]).includes(value);
}

export async function promoteCommand(
  root: string,
  target: string | undefined,
  options: PromoteOptions = {},
): Promise<void> {
  const agentRoot = path.join(root, '.agent');
  const candidatesDir = path.join(agentRoot, 'memory', 'candidates');
  const type = options.type ?? 'rule';

  if (!target) {
    console.log('Usage: business-agent promote <candidate> [--type rule|relation] [--entity <name>]');
    console.log(`Candidates live in ${candidatesDir}`);
    return;
  }

  if (type === 'relation') {
    await promoteRelation(agentRoot, candidatesDir, target, options);
    return;
  }

  await promoteRule(agentRoot, candidatesDir, target, options);
}

interface ResolvedCandidate {
  name: string;
  content: string;
  file?: string;
}

async function resolveCandidateText(candidatesDir: string, target: string): Promise<ResolvedCandidate | null> {
  if (await exists(target)) {
    return { name: path.basename(target, path.extname(target)), content: await readText(target), file: target };
  }
  const file = path.join(candidatesDir, `${target.endsWith('.md') ? target.replace(/\.md$/, '') : target}.md`);
  if (await exists(file)) {
    return { name: target.replace(/\.md$/, ''), content: await readText(file), file };
  }
  return null;
}

async function markCandidatePromoted(file: string, promotedId: string): Promise<void> {
  try {
    const content = await readText(file);
    if (!content.includes('Status: candidate')) return;
    await writeText(file, content.replace('Status: candidate', `Status: promoted as ${promotedId}`));
  } catch {
    // Marking is best-effort; promotion itself already succeeded.
  }
}

function warnIfAlreadyPromoted(resolved: ResolvedCandidate | null): void {
  if (resolved?.content.includes('Status: promoted')) {
    console.warn(
      `Warning: candidate "${resolved.name}" was already promoted; promoting again will overwrite the existing knowledge files.`,
    );
  }
}

async function promoteRule(
  agentRoot: string,
  candidatesDir: string,
  target: string,
  options: PromoteOptions,
): Promise<void> {
  const resolved = await resolveCandidateText(candidatesDir, target);
  const candidate = resolved
    ? parseCandidate(resolved.content, resolved.name)
    : { name: target, hypothesis: [target], evidence: [], impact: [], context: [], verification: [] };
  if (!resolved) {
    console.warn(`Warning: no candidate file found for "${target}"; promoting a bare rule from the name.`);
  }
  warnIfAlreadyPromoted(resolved);

  const entity = options.entity ?? candidate.entity ?? (await inferEntity(agentRoot, candidate.name));
  const rule = buildRuleFromCandidate({
    name: candidate.name,
    entity,
    candidate,
    confidence: 'medium',
    evidence: candidate.evidence.length ? candidate.evidence : undefined,
  });

  const validation = await validateRule(rule);
  if (!validation.valid) {
    throw new Error(`Promoted rule is invalid:\n${validation.problems.map((p) => `- ${p}`).join('\n')}`);
  }

  if (options.dryRun) {
    console.log(`Dry run: would promote rule "${rule.name}" (entity: ${rule.entity}) to .agent/business/rules/`);
    return;
  }

  const base = await writeRule(agentRoot, rule);
  await refreshIndex(agentRoot);
  if (resolved?.file) await markCandidatePromoted(resolved.file, rule.id);

  if (options.json) {
    console.log(JSON.stringify(rule, null, 2));
    return;
  }
  console.log(`Promoted rule: ${base}`);
  console.log(`  ${agentRoot}/business/rules/${base}.md`);
  console.log(`  ${agentRoot}/business/impact/${base}.md`);
}

async function promoteRelation(
  agentRoot: string,
  candidatesDir: string,
  target: string,
  options: PromoteOptions,
): Promise<void> {
  const resolved = await resolveCandidateText(candidatesDir, target);
  warnIfAlreadyPromoted(resolved);
  const source = options.source ?? (resolved ? resolved.name : undefined);
  if (!source || !options.target) {
    throw new Error('Relation promotion requires --source <name> --target <name>');
  }
  const cardinality = options.cardinality ?? 'unknown';
  if (!isCardinality(cardinality)) {
    throw new Error(`Invalid --cardinality "${cardinality}"; expected one of ${CARDINALITIES.join(', ')}`);
  }
  const relationship = options.relationship ?? 'references';
  if (!isRelationshipValue(relationship)) {
    throw new Error(`Invalid --relationship "${relationship}"`);
  }
  const relation = buildRelationFromInput({
    source,
    target: options.target,
    relationship,
    cardinality,
    evidence: resolved ? parseCandidate(resolved.content, resolved.name).evidence : [],
  });

  const validation = await validateRelation(relation);
  if (!validation.valid) {
    throw new Error(`Promoted relation is invalid:\n${validation.problems.map((p) => `- ${p}`).join('\n')}`);
  }

  if (options.dryRun) {
    console.log(
      `Dry run: would promote relation ${relation.source} -> ${relation.target} (${relation.cardinality}) to .agent/business/relationships/`,
    );
    return;
  }

  const base = await writeRelation(agentRoot, relation);
  await refreshIndex(agentRoot);
  if (resolved?.file) await markCandidatePromoted(resolved.file, relation.id);

  if (options.json) {
    console.log(JSON.stringify(relation, null, 2));
    return;
  }
  console.log(`Promoted relation: ${base}`);
  console.log(`  ${agentRoot}/business/relationships/${base}.md`);
  console.log(`  ${agentRoot}/business/impact/${base}.md`);
}

async function inferEntity(agentRoot: string, name: string): Promise<string> {
  const rules = await loadRules(agentRoot);
  const relations = await loadRelations(agentRoot);
  const candidates = new Set<string>();
  for (const r of rules) if (r.entity !== 'Unknown') candidates.add(r.entity);
  for (const r of relations) {
    candidates.add(r.source);
    candidates.add(r.target);
  }
  for (const entity of candidates) {
    if (name.toLowerCase().includes(entity.toLowerCase())) return entity;
  }
  return 'Unknown';
}

async function refreshIndex(agentRoot: string): Promise<void> {
  const manifestFile = path.join(agentRoot, 'memory', 'discovery-manifest.json');
  if (await exists(manifestFile)) {
    try {
      const manifest = JSON.parse(await readText(manifestFile)) as {
        entities?: Array<{ name: string }>;
      };
      if (Array.isArray(manifest.entities) && manifest.entities.length > 0) {
        await buildIndex(
          agentRoot,
          manifest.entities.map((e) => ({ name: e.name })),
        );
        return;
      }
    } catch {
      // Fall through to inference below.
    }
  }
  const rules = await loadRules(agentRoot);
  const relations = await loadRelations(agentRoot);
  const entityNames = new Set<string>();
  for (const r of rules) if (r.entity !== 'Unknown') entityNames.add(r.entity);
  for (const r of relations) {
    entityNames.add(r.source);
    entityNames.add(r.target);
  }
  await buildIndex(
    agentRoot,
    [...entityNames].map((name) => ({ name })),
  );
}

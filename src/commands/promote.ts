import path from 'node:path';
import { exists, readText, writeText } from '../utils/fs.js';
import { parseCandidate, buildRuleFromCandidate, buildRelationFromInput } from '../core/candidate.js';
import { isRelationshipValue } from '../core/types.js';
import { writeRule, writeRelation, buildIndex, loadRules, loadRelations } from '../core/knowledge.js';
import { validateRule, validateRelation } from '../core/validate.js';
import { applyCandidateStatus, resolveCandidateState, resolveCandidateId } from '../core/candidate-status.js';
import { loadReviewState, markReviewed, saveReviewState } from '../core/review.js';
import type { BusinessRule, Confidence, Relation } from '../core/types.js';

export interface PromoteOptions {
  type?: 'rule' | 'relation';
  entity?: string;
  source?: string;
  target?: string;
  relationship?: string;
  cardinality?: string;
  /** Explicit rule id override (e.g. `rule.approval-display`); conflicts still fail, never overwrite. */
  id?: string;
  /** Merge the candidate into an existing rule instead of creating a new one. */
  into?: string;
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

async function markCandidateResolved(
  file: string,
  status: 'promoted' | 'covered' | 'rejected',
  targetRuleId: string | undefined,
  reason?: string,
): Promise<void> {
  try {
    const content = await readText(file);
    await writeText(file, applyCandidateStatus(content, path.basename(file), { status, targetRuleId, reason }));
  } catch {
    // Marking is best-effort; promotion itself already succeeded.
  }
}

function warnIfAlreadyResolved(resolved: ResolvedCandidate | null): void {
  if (!resolved) return;
  const state = resolveCandidateState(resolved.content);
  if (state.status === 'promoted') {
    console.warn(
      `Warning: candidate "${resolved.name}" was already promoted${
        state.targetRuleId ? ` as ${state.targetRuleId}` : ''
      }; promoting again will overwrite the existing knowledge files.`,
    );
  } else if (state.status === 'covered') {
    console.warn(
      `Warning: candidate "${resolved.name}" was already covered by ${state.targetRuleId ?? 'an existing rule'}.`,
    );
  } else if (state.status === 'rejected') {
    console.warn(`Warning: candidate "${resolved.name}" was already rejected.`);
  }
}

/**
 * Record a promotion/merge decision in review-state so audit can reconcile
 * the candidate file (resolved) with the review trail (recorded). Best-effort:
 * promotion itself has already succeeded when this runs.
 */
async function recordPromotionDecision(
  agentRoot: string,
  file: string,
  input: {
    status: 'promoted' | 'covered';
    targetRuleId: string;
    name: string;
    entity: string;
    reason?: string;
  },
): Promise<void> {
  try {
    const content = await readText(file);
    const fileName = path.basename(file);
    const slug = fileName.replace(/\.md$/i, '');
    const candidateId = resolveCandidateId(fileName, content);
    const state = await loadReviewState(agentRoot);
    markReviewed(
      state,
      { name: input.name, entity: input.entity, confidence: 'medium' as Confidence },
      {
        decision: input.status === 'promoted' ? 'accepted' : 'rejected',
        slug,
        candidateId,
        status: input.status,
        targetRuleId: input.targetRuleId,
        reason: input.reason ?? (input.status === 'covered' ? 'merged into existing rule' : undefined),
        reviewedBy: 'promote',
      },
    );
    await saveReviewState(agentRoot, state);
  } catch {
    // Best-effort: audit will surface the gap if recording fails.
  }
}

function normalizeRuleId(value: string): string {
  return value.startsWith('rule.') ? value : `rule.${value}`;
}

async function findExistingRule(agentRoot: string, ruleId: string): Promise<BusinessRule | undefined> {
  const rules = await loadRules(agentRoot);
  return rules.find((rule) => rule.id === ruleId);
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
  warnIfAlreadyResolved(resolved);

  // Prefer the stable candidate file slug over the (possibly Chinese) display name.
  const idHint = resolved?.file ? path.basename(resolved.file).replace(/\.md$/i, '') : undefined;
  const candidateId = resolved?.file ? resolveCandidateId(path.basename(resolved.file), resolved.content) : undefined;

  if (options.into) {
    await promoteIntoExistingRule(agentRoot, candidatesDir, target, resolved, candidate, candidateId, options);
    return;
  }

  const entity = options.entity ?? candidate.entity ?? (await inferEntity(agentRoot, candidate.name));
  const rule = buildRuleFromCandidate({
    name: candidate.name,
    entity,
    candidate,
    confidence: 'medium',
    evidence: candidate.evidence.length ? candidate.evidence : undefined,
    idHint,
  });
  if (options.id) rule.id = normalizeRuleId(options.id);

  const existing = await findExistingRule(agentRoot, rule.id);
  if (existing && existing.name === rule.name && existing.entity === rule.entity) {
    console.warn(`Warning: rule ${rule.id} already exists with identical name/entity; refreshing its content.`);
  } else if (existing) {
    throw new Error(
      `Rule id "${rule.id}" already exists ("${existing.name}"). ` +
        `Refusing to overwrite. Re-run with --id <new-id> to pick a different id, ` +
        `or --into ${rule.id} to merge this candidate into the existing rule.`,
    );
  }

  const validation = await validateRule(rule);
  if (!validation.valid) {
    throw new Error(`Promoted rule is invalid:\n${validation.problems.map((p) => `- ${p}`).join('\n')}`);
  }

  if (options.dryRun) {
    console.log(
      `Dry run: would promote rule "${rule.name}" (id: ${rule.id}, entity: ${rule.entity}) to .agent/business/rules/`,
    );
    return;
  }

  const base = await writeRule(agentRoot, rule);
  await refreshIndex(agentRoot);
  if (resolved?.file) {
    await markCandidateResolved(resolved.file, 'promoted', rule.id);
    await recordPromotionDecision(agentRoot, resolved.file, {
      status: 'promoted',
      targetRuleId: rule.id,
      name: rule.name,
      entity: rule.entity,
    });
  }

  if (options.json) {
    console.log(JSON.stringify(rule, null, 2));
    return;
  }
  console.log(`Promoted rule: ${base}`);
  console.log(`  ${agentRoot}/business/rules/${base}.md`);
  console.log(`  ${agentRoot}/business/impact/${base}.md`);
}

async function promoteIntoExistingRule(
  agentRoot: string,
  candidatesDir: string,
  target: string,
  resolved: ResolvedCandidate | null,
  candidate: ReturnType<typeof parseCandidate>,
  candidateId: string | undefined,
  options: PromoteOptions,
): Promise<void> {
  const intoId = normalizeRuleId(options.into as string);
  const existing = await findExistingRule(agentRoot, intoId);
  if (!existing) {
    throw new Error(`Target rule "${intoId}" not found under ${agentRoot}/business/rules/.`);
  }
  const merged: BusinessRule = {
    ...existing,
    rule: uniq([...existing.rule, ...(candidate.hypothesis.length ? candidate.hypothesis : [candidate.name])]),
    evidence: uniq([...existing.evidence, ...(candidate.evidence.length ? candidate.evidence : [])]),
    impact: uniq([...(existing.impact ?? []), ...(candidate.impact ?? [])]),
    context: uniq([...(existing.context ?? []), ...candidate.context]),
    confidence: existing.confidence,
  };

  const validation = await validateRule(merged);
  if (!validation.valid) {
    throw new Error(`Merged rule is invalid:\n${validation.problems.map((p) => `- ${p}`).join('\n')}`);
  }

  if (options.dryRun) {
    console.log(
      `Dry run: would merge candidate "${candidate.name}" into existing rule ${intoId} ` +
        `(+${merged.rule.length - existing.rule.length} rule lines, +${merged.evidence.length - existing.evidence.length} evidence).`,
    );
    return;
  }

  await writeRule(agentRoot, merged);
  await refreshIndex(agentRoot);
  if (resolved?.file) {
    await markCandidateResolved(resolved.file, 'covered', intoId, 'merged into existing rule');
    await recordPromotionDecision(agentRoot, resolved.file, {
      status: 'covered',
      targetRuleId: intoId,
      name: candidate.name,
      entity: existing.entity,
      reason: 'merged into existing rule',
    });
  }

  if (options.json) {
    console.log(JSON.stringify({ mergedInto: intoId, candidate: candidateId ?? target, rule: merged }, null, 2));
    return;
  }
  console.log(`Merged candidate "${candidate.name}" into existing rule: ${intoId}`);
  console.log(`  ${agentRoot}/business/rules/${intoId.slice('rule.'.length)}.md`);
}

async function promoteRelation(
  agentRoot: string,
  candidatesDir: string,
  target: string,
  options: PromoteOptions,
): Promise<void> {
  const resolved = await resolveCandidateText(candidatesDir, target);
  warnIfAlreadyResolved(resolved);
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
  if (resolved?.file) {
    await markCandidateResolved(resolved.file, 'promoted', relation.id);
    await recordPromotionDecision(agentRoot, resolved.file, {
      status: 'promoted',
      targetRuleId: relation.id,
      name: relation.source,
      entity: relation.target,
    });
  }

  if (options.json) {
    console.log(JSON.stringify(relation, null, 2));
    return;
  }
  console.log(`Promoted relation: ${base}`);
  console.log(`  ${agentRoot}/business/relationships/${base}.md`);
  console.log(`  ${agentRoot}/business/impact/${base}.md`);
}

function uniq(items: string[]): string[] {
  return [...new Set(items.filter((item) => item.trim().length > 0))];
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

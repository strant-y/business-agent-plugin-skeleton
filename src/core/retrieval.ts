import path from 'node:path';
import { exists, readText, writeJson } from '../utils/fs.js';
import { normalizeEvidence, type EvidenceRef } from './evidence.js';
import { loadFeedback } from './feedback.js';
import { loadRules, buildIndex, safeFileId } from './knowledge.js';
import { getEntityAliases, invertAliasMap, resolveCanonicalNameFromIndex } from './glossary.js';
import { loadManifestSafe } from './manifest-loader.js';
import { isResolvedCandidateStatus, scanCandidateDir } from './candidate-status.js';
import { isResolvedDecision, loadReviewState } from './review.js';
import type { KnowledgeRecord, KnowledgeStatus } from './knowledge-state.js';
import type { TaskExperience } from './task.js';

export interface RetrievalDocument {
  id: string;
  type: 'entity' | 'rule' | 'relation' | 'workflow' | 'task' | 'feedback' | 'evidence';
  title: string;
  tokens: string[];
  aliases: string[];
  relatedIds: string[];
  status?: KnowledgeStatus;
  confidence?: number;
  updatedAt: string;
  text?: string;
  evidence?: EvidenceRef[];
}

export interface RetrievalHit {
  id: string;
  type: RetrievalDocument['type'];
  title: string;
  score: number;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  evidence: EvidenceRef[];
  warnings: string[];
}

export interface RetrieveOptions {
  limit?: number;
  /** Include stale/contradicted/deprecated knowledge (excluded by default to avoid misleading results). */
  includeUnhealthy?: boolean;
  /** Include low-confidence candidates (excluded by default to reduce noise). */
  includeLowConfidence?: boolean;
}

function tokens(value: string): string[] {
  const result = new Set<string>();
  const runs = value.toLowerCase().match(/\p{Script=Han}+|[^\p{Script=Han}]+/gu) ?? [];
  for (const run of runs) {
    if (/^\p{Script=Han}/u.test(run)) {
      if (run.length === 1) {
        result.add(run);
        continue;
      }
      for (let i = 0; i + 1 < run.length; i += 1) result.add(run.slice(i, i + 2));
    } else {
      for (const item of run.split(/[^\p{L}\p{N}_/-]+/u)) {
        if (item.length >= 2) result.add(item);
      }
    }
  }
  return [...result];
}

function knowledgeStatePath(root: string): string {
  return path.join(root, '.agent', 'memory', 'knowledge-state.json');
}

function taskHistoryDir(root: string): string {
  return path.join(root, '.agent', 'memory', 'task-history');
}

/**
 * Collect the candidate file slugs (which equal safeFileId(rule.id) for every
 * candidate written by `writeCandidate`) that should no longer surface as
 * searchable rules: candidates whose markdown front matter / status line is
 * resolved (promoted, covered, rejected) or that have a resolved review-state
 * entry. Formal rules written under .agent/business/rules are unaffected.
 */
async function loadResolvedCandidateRuleSlugs(root: string): Promise<Set<string>> {
  const agentRoot = path.join(root, '.agent');
  const resolved = new Set<string>();
  const candidatesDir = path.join(agentRoot, 'memory', 'candidates');
  if (await exists(candidatesDir)) {
    const index = await scanCandidateDir(candidatesDir);
    for (const entry of Object.values(index.byId)) {
      if (!isResolvedCandidateStatus(entry.status)) continue;
      const slug = entry.fileName.replace(/\.md$/i, '');
      if (slug) resolved.add(slug);
      if (entry.targetRuleId) resolved.add(safeFileId(entry.targetRuleId));
    }
  }
  const reviewState = await loadReviewState(agentRoot);
  for (const entry of Object.values(reviewState.decisions)) {
    if (!isResolvedDecision(entry)) continue;
    if (entry.slug) resolved.add(entry.slug);
    if (entry.targetRuleId) resolved.add(safeFileId(entry.targetRuleId));
  }
  return resolved;
}

async function loadKnowledgeRecords(root: string): Promise<Record<string, KnowledgeRecord>> {
  const file = knowledgeStatePath(root);
  if (!(await exists(file))) return {};
  const value = JSON.parse(await readText(file)) as unknown;
  if (typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string') {
    return { [value.id]: value as KnowledgeRecord };
  }
  return value as Record<string, KnowledgeRecord>;
}

async function loadTaskExperiences(root: string): Promise<TaskExperience[]> {
  const dir = taskHistoryDir(root);
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
      // Keep retrieval resilient to malformed history entries.
    }
  }
  return items;
}

export async function rebuildRetrievalIndex(root: string): Promise<RetrievalDocument[]> {
  const documents: RetrievalDocument[] = [];
  const knowledgeRecords = await loadKnowledgeRecords(root);
  const resolvedCandidateRuleSlugs = await loadResolvedCandidateRuleSlugs(root);
  const manifest = await loadManifestSafe(root, (message) => console.warn(`Warning: ${message}`));
  const aliasesByEntity = manifest.aliases ?? {};
  const aliasIndex = manifest.aliasIndex ?? invertAliasMap(aliasesByEntity);
  for (const entity of manifest.entities ?? []) {
    const knowledge = knowledgeRecords[entity.id];
    const entityAliases = getEntityAliases(entity.name, aliasesByEntity);
    documents.push({
      id: entity.id,
      type: 'entity',
      title: entity.name,
      tokens: tokens(
        `${entity.name} ${entity.description} ${(entity.tags ?? []).join(' ')} ${entityAliases.join(' ')} ${knowledge?.claim ?? ''}`,
      ),
      aliases: [...new Set([...(entity.tags ?? []), ...entityAliases])],
      relatedIds: knowledge?.relatedTasks ?? [],
      status: knowledge?.status,
      confidence:
        knowledge?.confidenceScore ?? (entity.confidence === 'high' ? 1 : entity.confidence === 'medium' ? 0.6 : 0.3),
      updatedAt: knowledge?.lastVerifiedAt ?? new Date().toISOString(),
      text: `${entity.description} ${knowledge?.claim ?? ''}`.trim(),
      evidence: knowledge?.evidence?.length ? knowledge.evidence : normalizeEvidence(entity.evidence),
    });
  }
  for (const rule of manifest.rules ?? []) {
    if (resolvedCandidateRuleSlugs.has(safeFileId(rule.id))) continue;
    const knowledge = knowledgeRecords[rule.id];
    const canonicalEntity = resolveCanonicalNameFromIndex(rule.entity, aliasIndex);
    const entityAliases = getEntityAliases(canonicalEntity, aliasesByEntity);
    documents.push({
      id: rule.id,
      type: 'rule',
      title: rule.name,
      tokens: tokens(
        `${rule.name} ${canonicalEntity} ${entityAliases.join(' ')} ${(rule.rule ?? []).join(' ')} ${(rule.context ?? []).join(' ')} ${knowledge?.claim ?? ''}`,
      ),
      aliases: [...new Set([canonicalEntity, ...entityAliases])],
      relatedIds: [canonicalEntity, ...(knowledge?.relatedTasks ?? [])],
      status:
        knowledge?.status ??
        (rule.status === 'deprecated' ? 'deprecated' : rule.status === 'confirmed' ? 'confirmed' : 'candidate'),
      confidence:
        knowledge?.confidenceScore ?? (rule.confidence === 'high' ? 1 : rule.confidence === 'medium' ? 0.6 : 0.3),
      updatedAt: knowledge?.lastVerifiedAt ?? new Date().toISOString(),
      text: `${(rule.rule ?? []).join(' ')} ${(rule.context ?? []).join(' ')} ${knowledge?.claim ?? ''}`.trim(),
      evidence: knowledge?.evidence?.length ? knowledge.evidence : normalizeEvidence(rule.evidence),
    });
  }
  const manifestRuleIds = new Set((manifest.rules ?? []).map((r) => r.id));
  for (const rule of await loadRules(path.join(root, '.agent'))) {
    if (manifestRuleIds.has(rule.id)) continue;
    const knowledge = knowledgeRecords[rule.id];
    const canonicalEntity = resolveCanonicalNameFromIndex(rule.entity, aliasIndex);
    const entityAliases = getEntityAliases(canonicalEntity, aliasesByEntity);
    documents.push({
      id: rule.id,
      type: 'rule',
      title: rule.name,
      tokens: tokens(
        `${rule.name} ${canonicalEntity} ${entityAliases.join(' ')} ${(rule.rule ?? []).join(' ')} ${(rule.context ?? []).join(' ')} ${knowledge?.claim ?? ''}`,
      ),
      aliases: [...new Set([canonicalEntity, ...entityAliases])],
      relatedIds: [canonicalEntity, ...(knowledge?.relatedTasks ?? [])],
      status: knowledge?.status ?? (rule.status === 'deprecated' ? 'deprecated' : (rule.status ?? 'confirmed')),
      confidence:
        knowledge?.confidenceScore ?? (rule.confidence === 'high' ? 1 : rule.confidence === 'medium' ? 0.6 : 0.3),
      updatedAt: knowledge?.lastVerifiedAt ?? new Date().toISOString(),
      text: `${(rule.rule ?? []).join(' ')} ${(rule.context ?? []).join(' ')} ${knowledge?.claim ?? ''}`.trim(),
      evidence: knowledge?.evidence?.length ? knowledge.evidence : normalizeEvidence(rule.evidence),
    });
  }
  for (const relation of manifest.relations ?? []) {
    const knowledge = knowledgeRecords[relation.id];
    const canonicalSource = resolveCanonicalNameFromIndex(relation.source, aliasIndex);
    const canonicalTarget = resolveCanonicalNameFromIndex(relation.target, aliasIndex);
    const relationAliases = [
      canonicalSource,
      canonicalTarget,
      ...getEntityAliases(canonicalSource, aliasesByEntity),
      ...getEntityAliases(canonicalTarget, aliasesByEntity),
    ];
    documents.push({
      id: relation.id,
      type: 'relation',
      title: `${relation.source} ${relation.relationship} ${relation.target}`,
      tokens: tokens(
        `${relation.source} ${canonicalSource} ${relation.target} ${canonicalTarget} ${relationAliases.join(' ')} ${relation.relationship} ${knowledge?.claim ?? ''}`,
      ),
      aliases: [...new Set(relationAliases)],
      relatedIds: [canonicalSource, canonicalTarget, ...(knowledge?.relatedTasks ?? [])],
      status: knowledge?.status,
      confidence:
        knowledge?.confidenceScore ??
        (relation.confidence === 'high' ? 1 : relation.confidence === 'medium' ? 0.6 : 0.3),
      updatedAt: knowledge?.lastVerifiedAt ?? new Date().toISOString(),
      text: `${relation.description ?? ''} ${knowledge?.claim ?? ''}`.trim(),
      evidence: knowledge?.evidence?.length ? knowledge.evidence : normalizeEvidence(relation.evidence),
    });
  }
  for (const workflow of manifest.workflows ?? []) {
    documents.push({
      id: workflow.id,
      type: 'workflow',
      title: workflow.name,
      tokens: tokens(`${workflow.name} ${workflow.description} ${workflow.steps.join(' ')}`),
      aliases: [],
      relatedIds: [],
      updatedAt: new Date().toISOString(),
      text: workflow.description,
    });
  }
  const experiences = await loadTaskExperiences(root);
  for (const item of experiences) {
    documents.push({
      id: item.taskId,
      type: 'task',
      title: item.summary ?? item.intent,
      tokens: tokens(
        [
          item.intent,
          item.summary ?? '',
          item.changedFiles.join(' '),
          item.affectedEntities.join(' '),
          item.affectedRules.join(' '),
          item.learnedFacts.join(' '),
          item.lessons.join(' '),
        ].join(' '),
      ),
      aliases: item.affectedEntities,
      relatedIds: [...item.affectedRules, ...item.affectedEntities],
      updatedAt: item.createdAt,
      text: [item.intent, item.summary ?? '', ...item.learnedFacts, ...item.lessons].join(' ').trim(),
    });
  }
  const feedback = await loadFeedback(root);
  for (const item of feedback) {
    const knowledge = knowledgeRecords[item.targetId];
    documents.push({
      id: item.id,
      type: 'feedback',
      title: item.correction ?? item.reason ?? item.type,
      tokens: tokens(`${item.type} ${item.targetId} ${item.correction ?? ''} ${item.reason ?? ''}`),
      aliases: [],
      relatedIds: [item.targetId, item.taskId, item.sessionId],
      status: knowledge?.status,
      confidence: knowledge?.confidenceScore,
      updatedAt: item.createdAt,
      text: [item.reason, item.correction].filter(Boolean).join(' ').trim(),
      evidence: item.evidence,
    });
  }
  await writeJson(path.join(root, '.agent', 'memory', 'indexes', 'retrieval-index.json'), documents);
  const manifestForIndex = await loadManifestSafe(root, (message) => console.warn(`Warning: ${message}`));
  await buildIndex(path.join(root, '.agent'), manifestForIndex.entities ?? []);
  return documents;
}

function statusWeight(status?: KnowledgeStatus): { multiplier: number; reason?: string; warning?: string } {
  if (status === 'verified') return { multiplier: 1.35, reason: '知识状态：verified' };
  if (status === 'confirmed') return { multiplier: 1.18, reason: '知识状态：confirmed' };
  if (status === 'stale') return { multiplier: 0.52, reason: '知识状态：stale', warning: '知识已过期，使用前请复核' };
  if (status === 'contradicted')
    return { multiplier: 0.22, reason: '知识状态：contradicted', warning: '知识存在冲突，优先检查更新证据' };
  if (status === 'deprecated')
    return { multiplier: 0.08, reason: '知识状态：deprecated', warning: '知识已弃用，通常不应继续沿用' };
  return { multiplier: 1, reason: '知识状态：candidate/corroborated' };
}

function recencyWeight(updatedAt: string): { multiplier: number; reason: string } {
  const ageMs = Math.max(Date.now() - Date.parse(updatedAt), 0);
  const ageDays = ageMs / 86_400_000;
  if (ageDays <= 3) return { multiplier: 1.15, reason: '更新时间：3天内' };
  if (ageDays <= 14) return { multiplier: 1.05, reason: '更新时间：2周内' };
  if (ageDays <= 60) return { multiplier: 0.92, reason: '更新时间：2个月内' };
  return { multiplier: 0.78, reason: '更新时间较久' };
}

function evidenceWeight(evidence?: EvidenceRef[]): { multiplier: number; reason?: string } {
  const items = evidence ?? [];
  const count = items.length;
  if (!count) return { multiplier: 0.9 };
  const direct = items.filter((item) => item.strength === 'direct').length;
  const linked = items.filter((item) => item.strength === 'linked').length;
  const inferred = items.filter((item) => item.strength === 'inferred').length;
  const multiplier = 1 + Math.min(direct * 0.08 + linked * 0.04 + inferred * 0.02, 0.28);
  return { multiplier, reason: `证据强度：${count}条` };
}

function feedbackWeight(document: RetrievalDocument): { multiplier: number; reason?: string; warning?: string } {
  const evidence = document.evidence ?? [];
  const text = [document.text ?? '', document.title, ...evidence.map((item) => item.description ?? item.snippet ?? '')]
    .join(' ')
    .toLowerCase();
  if (document.type === 'feedback') {
    return { multiplier: 0.6, reason: '反馈修正：存在反馈记录', warning: '该结果来自反馈修正记录' };
  }
  if (/reject_|mark_deprecated|mark_stale|correction|contradict|冲突|修正/.test(text)) {
    return { multiplier: 0.6, reason: '反馈修正：内容含修正信号', warning: '内容包含修正信号，请结合最新上下文判断' };
  }
  return { multiplier: 1 };
}

function experienceWeight(document: RetrievalDocument): { multiplier: number; reason?: string } {
  if (document.type !== 'task') return { multiplier: 1 };
  return { multiplier: 1.45, reason: '任务经验：历史任务可复用' };
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items)];
}

function isUnhealthy(document: RetrievalDocument): boolean {
  return document.status === 'stale' || document.status === 'contradicted' || document.status === 'deprecated';
}

function isLowConfidence(document: RetrievalDocument): boolean {
  if (document.type === 'task' || document.type === 'feedback') return false;
  if (document.status === 'candidate' && (document.confidence ?? 0) < 0.6) return true;
  if (document.status === undefined && document.confidence !== undefined && document.confidence < 0.5) return true;
  return false;
}

export async function retrieveTaskContext(
  root: string,
  task: string,
  limit = 10,
  options: RetrieveOptions = {},
): Promise<RetrievalHit[]> {
  const file = path.join(root, '.agent', 'memory', 'indexes', 'retrieval-index.json');
  const documents = (await exists(file))
    ? (JSON.parse(await readText(file)) as RetrievalDocument[])
    : await rebuildRetrievalIndex(root);
  const query = tokens(task);
  const score = (includeLowConfidence: boolean): RetrievalHit[] =>
    documents
      .filter((document) => {
        if (!(options.includeUnhealthy ?? false) && isUnhealthy(document)) return false;
        if (!includeLowConfidence && isLowConfidence(document)) return false;
        return true;
      })
      .map((document) => {
        const matched = query.filter(
          (token) =>
            document.tokens.includes(token) || document.aliases.some((alias) => alias.toLowerCase().includes(token)),
        );
        const coverage = matched.length / Math.max(query.length, 1);
        const relatedMatch = matched.length && document.relatedIds.some((id) => query.includes(id.toLowerCase()));
        const reasons = matched.map((token) => `关键词匹配: ${token}`);
        const warnings: string[] = [];
        let score = coverage;
        if (relatedMatch) {
          score += 0.12;
          reasons.push('关联实体匹配');
        }
        const status = statusWeight(document.status);
        score *= status.multiplier;
        if (status.reason) reasons.push(status.reason);
        if (status.warning) warnings.push(status.warning);
        const feedback = feedbackWeight(document);
        score *= feedback.multiplier;
        if (feedback.reason) reasons.push(feedback.reason);
        if (feedback.warning) warnings.push(feedback.warning);
        const experience = experienceWeight(document);
        score *= experience.multiplier;
        if (experience.reason) reasons.push(experience.reason);
        const evidence = evidenceWeight(document.evidence);
        score *= evidence.multiplier;
        if (evidence.reason) reasons.push(evidence.reason);
        const recency = recencyWeight(document.updatedAt);
        score *= recency.multiplier;
        reasons.push(recency.reason);
        if (document.confidence !== undefined) {
          score *= 0.85 + Math.min(Math.max(document.confidence, 0), 1) * 0.3;
          reasons.push(`基础置信度：${document.confidence.toFixed(2)}`);
        }
        const confidence: RetrievalHit['confidence'] = score >= 0.72 ? 'high' : score >= 0.38 ? 'medium' : 'low';
        return {
          id: document.id,
          type: document.type,
          title: document.title,
          score: Number(Math.min(score, 1).toFixed(4)),
          confidence,
          reasons: uniqueStrings(reasons),
          evidence: document.evidence ?? [],
          warnings: uniqueStrings(warnings),
        };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || b.evidence.length - a.evidence.length || a.title.localeCompare(b.title))
      .slice(0, limit);
  const hits = score(options.includeLowConfidence ?? false);
  if (hits.length === 0 && !(options.includeLowConfidence ?? false)) {
    return score(true);
  }
  return hits;
}

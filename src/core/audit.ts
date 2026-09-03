import path from 'node:path';
import { exists, readText } from '../utils/fs.js';
import { findGitRoot } from '../utils/git.js';
import { validateManifest, validateKnowledgeDir } from './validate.js';
import { normalizeEvidence, validateEvidence } from './evidence.js';
import { findKnowledgeEvidenceDrift } from './knowledge-state.js';
import { isResolvedCandidateStatus, scanCandidateDir, type CandidateStatus } from './candidate-status.js';
import { isResolvedDecision, loadReviewState } from './review.js';
import type { DiscoverManifest } from './types.js';

export type AuditStatus = 'ok' | 'warn' | 'error';

export interface AuditCheck {
  id: string;
  label: string;
  status: AuditStatus;
  message: string;
  /** Optional structured payload (e.g. reconciliation counts) for --json consumers. */
  data?: Record<string, unknown>;
}

export interface AuditReport {
  healthy: boolean;
  issues: number;
  warnings: number;
  checks: AuditCheck[];
}

const MAX_EVIDENCE_CHECKS = 200;

function ok(label: string, message: string, data?: Record<string, unknown>): AuditCheck {
  return { id: label, label, status: 'ok', message, ...(data ? { data } : {}) };
}

function warn(label: string, message: string, data?: Record<string, unknown>): AuditCheck {
  return { id: label, label, status: 'warn', message, ...(data ? { data } : {}) };
}

function error(label: string, message: string, data?: Record<string, unknown>): AuditCheck {
  return { id: label, label, status: 'error', message, ...(data ? { data } : {}) };
}

function summarizeProblems(problems: string[], max = 5): string {
  const shown = problems.slice(0, max);
  const rest = problems.length - shown.length;
  return `${shown.join('; ')}${rest > 0 ? ` 等 ${problems.length} 条` : ''}`;
}

async function checkInit(root: string): Promise<AuditCheck> {
  const configFile = path.join(root, '.agent', 'business-agent.json');
  if (!(await exists(configFile))) {
    return error('init', '未初始化：.agent/business-agent.json 不存在，请先运行 business-agent init');
  }
  return ok('init', '.agent/ 结构已初始化');
}

async function checkManifest(root: string): Promise<{ check: AuditCheck; manifest?: DiscoverManifest }> {
  const manifestFile = path.join(root, '.agent', 'memory', 'discovery-manifest.json');
  if (!(await exists(manifestFile))) {
    return { check: error('manifest', '发现清单不存在，请先运行 business-agent discover') };
  }
  try {
    const manifest = JSON.parse(await readText(manifestFile)) as DiscoverManifest;
    const counts = [
      `实体 ${manifest.entities?.length ?? 0}`,
      `规则 ${manifest.rules?.length ?? 0}`,
      `关系 ${manifest.relations?.length ?? 0}`,
      `API ${manifest.apis?.length ?? 0}`,
    ];
    return { check: ok('manifest', `发现清单正常（${counts.join('，')}）`), manifest };
  } catch {
    return { check: error('manifest', '发现清单无法解析（损坏的 JSON）') };
  }
}

async function checkSchema(root: string, manifest: DiscoverManifest | undefined): Promise<AuditCheck> {
  const problems: string[] = [];
  if (manifest) problems.push(...(await validateManifest(manifest)));
  const knowledgeProblems = await validateKnowledgeDir(path.join(root, '.agent'));
  for (const item of knowledgeProblems) {
    problems.push(`${item.file}: ${summarizeProblems(item.problems, 2)}`);
  }
  if (problems.length > 0) return error('schema', `schema 校验失败：${summarizeProblems(problems)}`);
  return ok('schema', '发现清单与已确认知识均符合 schema');
}

/**
 * Reconcile the three sources that describe candidate state:
 *  1. the discovery manifest rules,
 *  2. the candidate markdown files (status read via the unified parser),
 *  3. the review-state decisions.
 * They drift when a file is edited by hand, a promotion only rewrote the file,
 * or a review decision was recorded without the file marker. The check reports
 * each count and suggests concrete reconcile actions instead of a single
 * boolean "noise" line.
 */
async function checkCandidateReconciliation(root: string, manifest: DiscoverManifest | undefined): Promise<AuditCheck> {
  const data: Record<string, unknown> = {};
  if (!manifest) {
    data.skipped = true;
    return warn('candidates', '无发现清单，跳过候选对账检查', data);
  }
  const agentRoot = path.join(root, '.agent');
  const manifestPending = (manifest.rules ?? []).filter(
    (rule) => rule.status !== 'confirmed' && rule.status !== 'deprecated',
  );
  const fileIndex = await scanCandidateDir(path.join(agentRoot, 'memory', 'candidates'));
  const statusCounts = fileIndex.byId;
  const byStatus = new Map<CandidateStatus, number>();
  for (const entry of Object.values(statusCounts)) {
    byStatus.set(entry.status, (byStatus.get(entry.status) ?? 0) + 1);
  }
  const filePending = fileIndex.pending;
  const fileResolved = fileIndex.resolved;

  const reviewState = await loadReviewState(agentRoot);
  const reviewEntries = Object.values(reviewState.decisions);
  const reviewResolved = reviewEntries.filter(isResolvedDecision).length;
  const reviewPending = reviewEntries.length - reviewResolved;

  // Files resolved on disk but missing a review-state record → audit trail gap.
  const fileResolvedIds = new Set<string>();
  for (const entry of Object.values(statusCounts)) {
    if (isResolvedCandidateStatus(entry.status)) fileResolvedIds.add(entry.candidateId);
  }
  const reviewSlugs = new Set(reviewEntries.map((entry) => entry.slug));
  const missingFromReview = [...fileResolvedIds].filter((candidateId) => !reviewSlugs.has(candidateId));

  data.manifestPending = manifestPending.length;
  data.fileTotal = fileIndex.total;
  data.filePending = filePending;
  data.fileResolved = fileResolved;
  data.fileByStatus = Object.fromEntries(byStatus);
  data.reviewTotal = reviewEntries.length;
  data.reviewResolved = reviewResolved;
  data.reviewPending = reviewPending;
  data.missingFromReview = missingFromReview.length;

  const drift = manifestPending.length !== filePending;
  const auditGap = missingFromReview.length > 0;
  const strayDecisions = reviewResolved > fileResolved + missingFromReview.length;

  if (!drift && !auditGap && !strayDecisions) {
    return ok(
      'candidates',
      `候选对账一致：manifest 待评审 ${manifestPending.length}、候选文件待评审 ${filePending}（共 ${fileIndex.total}，已决 ${fileResolved}）、review-state 已决 ${reviewResolved}、待补证据 ${reviewPending}`,
      data,
    );
  }

  const notes: string[] = [];
  if (drift)
    notes.push(
      `候选文件待评审（${filePending}）与 manifest 候选（${manifestPending.length}）不一致，说明候选文件或清单有手工改动`,
    );
  if (auditGap)
    notes.push(
      `${missingFromReview.length} 个已决候选文件没有 review-state 审计记录（多为手工编辑或旧版 promote 只改文件）`,
    );
  if (strayDecisions) notes.push('review-state 已决数超过候选文件已决数，可能存在已被正式规则收录的旧决策');
  const actions: string[] = [];
  if (auditGap)
    actions.push(
      `运行 business-agent reconcile review-state 自动补齐 ${missingFromReview.length} 条审计记录（以文件状态为准回填，不会删除或降级）`,
    );
  if (drift) actions.push('运行 business-agent discover 重新生成 manifest，或按候选文件状态手工对齐');
  actions.push('运行 business-agent validate 校验整体一致性');
  return warn('candidates', `候选对账发现差异：${notes.join('；')}。建议：${actions.join('；')}`, data);
}

async function checkKnowledgeState(root: string): Promise<AuditCheck> {
  const stateFile = path.join(root, '.agent', 'memory', 'knowledge-state.json');
  if (!(await exists(stateFile))) return ok('knowledge-state', '暂无知识状态记录');
  try {
    const value = JSON.parse(await readText(stateFile)) as unknown;
    const records =
      typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string'
        ? [value as { status?: string }]
        : (Object.values(value as Record<string, { status?: string }>) ?? []);
    const counts = records.reduce<Record<string, number>>((acc, record) => {
      acc[record.status ?? 'unknown'] = (acc[record.status ?? 'unknown'] ?? 0) + 1;
      return acc;
    }, {});
    const stale = counts.stale ?? 0;
    const contradicted = counts.contradicted ?? 0;
    const deprecated = counts.deprecated ?? 0;
    const unhealthy = stale + contradicted + deprecated;
    if (unhealthy > 0) {
      return warn(
        'knowledge-state',
        `有 ${unhealthy} 条知识已过期/冲突/弃用（stale ${stale}，contradicted ${contradicted}，deprecated ${deprecated}），建议复核证据后用 knowledge verify / stale 更新`,
      );
    }
    return ok('knowledge-state', `知识状态健康（共 ${records.length} 条记录）`);
  } catch {
    return error('knowledge-state', '知识状态文件无法解析（损坏的 JSON）');
  }
}

async function checkEvidence(root: string, manifest: DiscoverManifest | undefined): Promise<AuditCheck> {
  if (!manifest) return warn('evidence', '无发现清单，跳过证据检查');
  const items: Array<{ id: string; evidence: string[]; status?: string }> = [
    ...(manifest.rules ?? []),
    ...(manifest.relations ?? []),
  ];
  let checked = 0;
  const problems: string[] = [];
  for (const item of items) {
    if (item.status === 'candidate') continue;
    if (checked >= MAX_EVIDENCE_CHECKS) break;
    for (const ref of normalizeEvidence(item.evidence)) {
      if (!ref.file) continue;
      checked += 1;
      const result = await validateEvidence(ref, root);
      if (result.warnings.some((warning) => warning.includes('not found'))) {
        problems.push(`证据文件缺失：${ref.file}（${item.id}）`);
      } else if (result.warnings.some((warning) => warning.includes('changed'))) {
        problems.push(`证据内容已变化：${ref.file}（${item.id}）`);
      } else if (result.warnings.some((warning) => warning.includes('outside the file'))) {
        problems.push(`证据行号超出文件：${ref.file}（${item.id}）`);
      }
      if (checked >= MAX_EVIDENCE_CHECKS) break;
    }
  }
  if (problems.length > 0) return error('evidence', `证据失效：${summarizeProblems(problems, 3)}`);
  return ok('evidence', `已确认知识的证据文件可追溯（抽查 ${checked} 条）`);
}

async function checkKnowledgeEvidenceDrift(root: string): Promise<AuditCheck> {
  const drift = await findKnowledgeEvidenceDrift(root);
  if (!drift.length) return ok('knowledge-evidence-drift', '知识状态中的证据均可追溯');
  const stale = drift.filter((item) => item.status === 'stale').length;
  const affected = [...new Set(drift.map((item) => item.recordId))];
  return warn(
    'knowledge-evidence-drift',
    `发现 ${drift.length} 条知识证据漂移，涉及 ${affected.length} 条记录（已有 stale ${stale} 条），建议复核后运行 knowledge verify 或 stale`,
  );
}

async function checkHook(root: string): Promise<AuditCheck> {
  const logFile = path.join(root, '.agent', 'memory', 'hook-errors.log');
  if (await exists(logFile)) {
    const lines = (await readText(logFile)).trim().split(/\r?\n/).filter(Boolean);
    if (lines.length > 0) {
      const tail = lines.slice(-3).join(' | ');
      return warn('hook', `hook 运行失败 ${lines.length} 次，最近：${tail}（检查 business-agent 是否可用）`);
    }
  }
  const gitRoot = await findGitRoot(root);
  const hookFile = gitRoot ? path.join(gitRoot, '.git', 'hooks', 'post-commit') : undefined;
  if (!hookFile || !(await exists(hookFile))) {
    return warn(
      'hook',
      `post-commit hook 未安装（git 仓库根：${gitRoot ?? '未找到 .git'}），建议运行 business-agent hook install 自动捕获每次提交`,
    );
  }
  const content = await readText(hookFile);
  if (!content.includes('# business-agent')) {
    return warn('hook', 'post-commit hook 存在但不含 business-agent，可能被其他工具覆盖');
  }
  return ok('hook', 'post-commit hook 已安装且无失败记录');
}

async function checkSessions(root: string): Promise<AuditCheck> {
  const activeFile = path.join(root, '.agent', 'memory', 'active-session.json');
  if (!(await exists(activeFile))) return ok('sessions', '无活跃任务会话');
  try {
    const active = JSON.parse(await readText(activeFile)) as { status?: string; task?: string };
    if (active.status === 'finished') return ok('sessions', '任务会话均已收尾');
    return warn('sessions', `存在未收尾的任务会话（${active.task ?? '未知任务'}），建议用 task finish 收尾`);
  } catch {
    return warn('sessions', '活跃会话文件无法解析');
  }
}

export async function runAudit(root: string): Promise<AuditReport> {
  const checks: AuditCheck[] = [];
  checks.push(await checkInit(root));
  const { check: manifestCheck, manifest } = await checkManifest(root);
  checks.push(manifestCheck);
  checks.push(await checkSchema(root, manifest));
  checks.push(await checkCandidateReconciliation(root, manifest));
  checks.push(await checkKnowledgeState(root));
  checks.push(await checkKnowledgeEvidenceDrift(root));
  checks.push(await checkEvidence(root, manifest));
  checks.push(await checkHook(root));
  checks.push(await checkSessions(root));
  const issues = checks.filter((check) => check.status === 'error').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  return { healthy: issues === 0, issues, warnings, checks };
}

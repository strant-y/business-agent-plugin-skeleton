import path from 'node:path';
import { dispatchLifecycleEvent } from '../core/lifecycle.js';
import { loadKnowledgeState, type KnowledgeRecord, type KnowledgeStatus } from '../core/knowledge-state.js';
import { recordFeedback, type FeedbackType } from '../core/feedback.js';
import {
  rebuildRetrievalIndex,
  retrieveTaskContext,
  type RetrievalDocument,
  type RetrievalHit,
} from '../core/retrieval.js';
import { loadTaskSession } from '../core/task.js';
import { checkKnowledgeConsistency } from '../core/consistency.js';

const FEEDBACK_TYPES = new Set<FeedbackType>([
  'accept_impact',
  'reject_impact',
  'add_missing_impact',
  'confirm_rule',
  'reject_rule',
  'merge_entities',
  'split_entities',
  'correct_relation',
  'mark_stale',
  'mark_deprecated',
]);

function isFeedbackType(value: string | undefined): value is FeedbackType {
  return value !== undefined && FEEDBACK_TYPES.has(value as FeedbackType);
}

function parseOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Option --${name} requires a value`);
  return value;
}

function withoutOptions(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index]?.startsWith('--')) index++;
    else values.push(args[index]!);
  }
  return values;
}

function print(result: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(formatResult(result));
}

function formatResult(result: unknown): string {
  if (Array.isArray(result)) {
    if (result.length === 0) return '无结果';
    if (isRetrievalHitList(result)) return formatRetrievalHits(result);
    if (isRetrievalDocumentList(result)) return formatIndexRebuild(result);
    return result.map((item, index) => `[${index + 1}] ${formatFallback(item)}`).join('\n');
  }
  if (isKnowledgeStatusView(result)) return formatKnowledgeStatus(result);
  if (isKnowledgeTransitionView(result)) return formatKnowledgeTransition(result);
  if (isFeedbackView(result)) return formatFeedbackResult(result);
  return formatFallback(result);
}

function formatFallback(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined) return '无结果';
  return JSON.stringify(result, null, 2);
}

function parseKnowledgeStatus(record: KnowledgeRecord | undefined): unknown {
  if (!record) return undefined;
  return {
    id: record.id,
    subject: record.subject,
    status: record.status,
    confidenceScore: record.confidenceScore,
    lastVerifiedAt: record.lastVerifiedAt,
    version: record.version,
    relatedTasks: record.relatedTasks,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRetrievalHitList(value: unknown[]): value is RetrievalHit[] {
  return value.every(
    (item) =>
      isRecord(item) && typeof item.id === 'string' && typeof item.score === 'number' && Array.isArray(item.reasons),
  );
}

function isRetrievalDocumentList(value: unknown[]): value is RetrievalDocument[] {
  return value.every(
    (item) =>
      isRecord(item) && typeof item.id === 'string' && typeof item.type === 'string' && Array.isArray(item.tokens),
  );
}

function isKnowledgeStatusView(value: unknown): value is {
  id: string;
  subject: string;
  status: string;
  confidenceScore: number;
  lastVerifiedAt?: string;
  version: number;
  relatedTasks: string[];
} {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.subject === 'string' &&
    typeof value.status === 'string' &&
    typeof value.confidenceScore === 'number' &&
    typeof value.version === 'number' &&
    Array.isArray(value.relatedTasks)
  );
}

function isKnowledgeTransitionView(value: unknown): value is {
  eventId: string;
  feedback?: { targetId?: string; type?: string; reason?: string };
  knowledge?: ReturnType<typeof parseKnowledgeStatus>;
} {
  return isRecord(value) && typeof value.eventId === 'string' && 'knowledge' in value;
}

function isFeedbackView(value: unknown): value is {
  id: string;
  targetId: string;
  type: string;
  correction?: string;
  reason?: string;
  taskId: string;
  sessionId: string;
  createdAt: string;
} {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.targetId === 'string' &&
    typeof value.type === 'string' &&
    typeof value.taskId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.createdAt === 'string'
  );
}

function formatList(title: string, items: string[]): string {
  if (!items.length) return `${title}: 无`;
  return `${title}:\n${items.map((item) => `  - ${item}`).join('\n')}`;
}

function formatKnowledgeLabel(status: string): string {
  if (status === 'verified') return '已验证';
  if (status === 'stale') return '已过期';
  if (status === 'deprecated') return '已弃用';
  if (status === 'contradicted') return '有冲突';
  if (status === 'confirmed') return '已确认';
  if (status === 'candidate') return '候选';
  if (status === 'corroborated') return '已佐证';
  return status;
}

function formatConfidence(score: number): string {
  return `${score.toFixed(2)} / 1.00`;
}

function formatKnowledgeStatus(result: {
  id: string;
  subject: string;
  status: string;
  confidenceScore: number;
  lastVerifiedAt?: string;
  version: number;
  relatedTasks: string[];
}): string {
  return [
    `知识记录：${result.subject} (${result.id})`,
    `状态：${formatKnowledgeLabel(result.status)} [${result.status}]`,
    `置信度：${formatConfidence(result.confidenceScore)}`,
    `版本：v${result.version}`,
    `最近验证：${result.lastVerifiedAt ?? '未验证'}`,
    formatList('关联任务', result.relatedTasks),
  ].join('\n');
}

function formatKnowledgeTransition(result: {
  eventId: string;
  feedback?: { targetId?: string; type?: string; reason?: string };
  knowledge?: ReturnType<typeof parseKnowledgeStatus>;
}): string {
  const action =
    result.feedback?.type === 'confirm_rule'
      ? '标记为已验证'
      : result.feedback?.type === 'mark_stale'
        ? '标记为已过期'
        : result.feedback?.type === 'mark_deprecated'
          ? '标记为已弃用'
          : (result.feedback?.type ?? '已更新');
  const lines = [`知识状态已更新：${action}`, `事件：${result.eventId}`];
  if (result.feedback?.targetId) lines.push(`目标：${result.feedback.targetId}`);
  if (result.feedback?.reason) lines.push(`原因：${result.feedback.reason}`);
  if (isKnowledgeStatusView(result.knowledge)) lines.push('', formatKnowledgeStatus(result.knowledge));
  return lines.join('\n');
}

function formatFeedbackType(type: string): string {
  if (type === 'confirm_rule') return '确认规则';
  if (type === 'reject_rule') return '驳回规则';
  if (type === 'mark_stale') return '标记过期';
  if (type === 'mark_deprecated') return '标记弃用';
  return type;
}

function formatFeedbackResult(result: {
  id: string;
  targetId: string;
  type: string;
  correction?: string;
  reason?: string;
  taskId: string;
  sessionId: string;
  createdAt: string;
}): string {
  const lines = [
    '任务反馈已记录',
    `反馈：${result.id}`,
    `目标：${result.targetId}`,
    `类型：${formatFeedbackType(result.type)} [${result.type}]`,
    `任务：${result.taskId}`,
    `会话：${result.sessionId}`,
    `时间：${result.createdAt}`,
  ];
  if (result.correction) lines.push(`修正：${result.correction}`);
  if (result.reason) lines.push(`原因：${result.reason}`);
  lines.push('检索索引：已刷新');
  return lines.join('\n');
}

function formatRetrievalHits(result: RetrievalHit[]): string {
  return result
    .map((hit, index) => {
      const lines = [
        `[${index + 1}] ${hit.title}`,
        `  标识：${hit.id}`,
        `  类型：${hit.type}`,
        `  相关度：${hit.score.toFixed(4)} (${hit.confidence})`,
        formatList('  命中理由', hit.reasons),
      ];
      if (hit.warnings.length) lines.push(formatList('  注意事项', hit.warnings));
      if (hit.evidence.length) {
        lines.push(
          formatList(
            '  证据',
            hit.evidence.map((item) => {
              const location = item.file ? `${item.file}:${item.lineStart ?? 1}` : item.id;
              return `${location} [${item.strength}]`;
            }),
          ),
        );
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

function formatIndexRebuild(result: RetrievalDocument[]): string {
  const counts = result.reduce<Record<string, number>>((acc, item) => {
    acc[item.type] = (acc[item.type] ?? 0) + 1;
    return acc;
  }, {});
  return [
    '检索索引已重建',
    `文档总数：${result.length}`,
    ...Object.entries(counts)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([type, count]) => `- ${type}: ${count}`),
  ].join('\n');
}

/** After `index rebuild`, verify INDEX.md links point at real files. */
async function reportIndexIssues(root: string, json: boolean): Promise<void> {
  const consistency = await checkKnowledgeConsistency(path.join(root, '.agent'));
  if (consistency.indexBrokenLinks.length === 0) return;
  if (json) {
    console.warn(JSON.stringify({ warning: 'index-broken-links', links: consistency.indexBrokenLinks }));
    return;
  }
  console.warn(
    `Warning: INDEX.md 存在 ${consistency.indexBrokenLinks.length} 个断链：${consistency.indexBrokenLinks.join(', ')}`,
  );
}

async function requireActiveSession(root: string): Promise<{ taskId: string; sessionId: string }> {
  const session = await loadTaskSession(root);
  if (session.status !== 'active') throw new Error('Task feedback requires an active task session.');
  return { taskId: session.taskId, sessionId: session.sessionId };
}

async function dispatchKnowledgeTransition(
  root: string,
  targetId: string,
  to: KnowledgeStatus,
  reason: string | undefined,
): Promise<unknown> {
  const { taskId, sessionId } = await requireActiveSession(root);
  const result = await dispatchLifecycleEvent({
    eventId: `knowledge-${targetId}-${to}-${Date.now()}`,
    taskId,
    sessionId,
    phase: 'feedback',
    task: reason ?? `${to} ${targetId}`,
    root,
    source: 'cli',
    feedback: {
      targetId,
      type: to === 'verified' ? 'confirm_rule' : to === 'stale' ? 'mark_stale' : 'mark_deprecated',
      reason,
    },
    timestamp: new Date().toISOString(),
  });
  return {
    eventId: result.eventId,
    feedback: result.feedback,
    knowledge: parseKnowledgeStatus(await loadKnowledgeState(root, targetId)),
  };
}

export interface ContinuousLearningOptions {
  includeUnhealthy?: boolean;
  includeLowConfidence?: boolean;
}

export async function continuousLearningCommand(
  root: string,
  action: string | undefined,
  args: string[],
  json = false,
  options: ContinuousLearningOptions = {},
): Promise<void> {
  let result: unknown;
  if (action === 'retrieve') {
    result = await retrieveTaskContext(root, args.join(' '), 10, {
      includeUnhealthy: options.includeUnhealthy,
      includeLowConfidence: options.includeLowConfidence,
    });
  } else if (action === 'index') {
    result = await rebuildRetrievalIndex(root);
    await reportIndexIssues(root, json);
  } else if (action === 'feedback') {
    const values = withoutOptions(args);
    const reason = parseOption(args, 'reason');
    const correction = parseOption(args, 'correction');
    const [first, second, ...legacyReason] = values;
    const type = isFeedbackType(first) ? first : second;
    const targetId = isFeedbackType(first) ? second : first;
    if (!targetId || !isFeedbackType(type)) {
      throw new Error('Usage: business-agent task feedback <type> <targetId> [--reason <text>] [--correction <text>]');
    }
    const { taskId, sessionId } = await requireActiveSession(root);
    result = await recordFeedback(
      root,
      { targetId, type, reason: reason ?? (legacyReason.length ? legacyReason.join(' ') : undefined), correction },
      taskId,
      sessionId,
    );
    await rebuildRetrievalIndex(root);
  } else if (action === 'status') {
    if (!args[0]) throw new Error('Usage: business-agent knowledge status <targetId>');
    result = parseKnowledgeStatus(await loadKnowledgeState(root, args[0]));
  } else if (action === 'verify') {
    const values = withoutOptions(args);
    if (!values[0]) throw new Error('Usage: business-agent knowledge verify <targetId> [--reason <text>]');
    result = await dispatchKnowledgeTransition(
      root,
      values[0],
      'verified',
      parseOption(args, 'reason') ?? values.slice(1).join(' '),
    );
  } else if (action === 'stale') {
    const values = withoutOptions(args);
    const targetId = parseOption(args, 'id') ?? values[0];
    if (!targetId) throw new Error('Usage: business-agent knowledge stale --id <id> [--reason <text>]');
    result = await dispatchKnowledgeTransition(
      root,
      targetId,
      'stale',
      parseOption(args, 'reason') ?? values.slice(1).join(' '),
    );
  } else throw new Error('Usage: business-agent retrieve|index rebuild|task feedback|knowledge status|verify|stale');
  print(result, json);
}

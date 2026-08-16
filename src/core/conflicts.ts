import type { BusinessRule, RuleConflict } from './types.js';

const POSITIVE = /(allow|permit|must\s+be|enabled|允许|必须|可修改|可变更)/i;
const NEGATIVE = /(cannot|must\s+not|forbidden|disabled|禁止|不得|不可修改|不可变更)/i;

export function ruleSign(text: string): 1 | -1 | 0 {
  let sign = 0;
  if (POSITIVE.test(text)) sign += 1;
  if (NEGATIVE.test(text)) sign -= 1;
  return sign as 1 | -1 | 0;
}

function buildSuggestions(a: BusinessRule, b: BusinessRule): string[] {
  const suggestions: string[] = [];
  if ((a.preconditions?.length ?? 0) > 0 && (b.preconditions?.length ?? 0) > 0) {
    suggestions.push('合并两条规则的前置条件，确认是否只在不同状态下分别成立。');
  }
  if (a.confidence !== b.confidence) suggestions.push(`优先人工裁决置信度更高的规则（${a.id} vs ${b.id}）。`);
  if (a.evidence.some((e) => b.evidence.includes(e))) suggestions.push('同源证据可合并，保留更具体的规则描述。');
  suggestions.push(`确认后可将不适用规则标记为 deprecated：${a.id} 或 ${b.id}。`);
  return suggestions;
}

export function detectConflicts(rules: BusinessRule[]): RuleConflict[] {
  const conflicts: RuleConflict[] = [];
  const byEntity = new Map<string, BusinessRule[]>();
  for (const rule of rules) {
    const list = byEntity.get(rule.entity) ?? [];
    list.push(rule);
    byEntity.set(rule.entity, list);
  }

  for (const [entity, group] of byEntity) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const aText = a.rule.join(' ');
        const bText = b.rule.join(' ');
        const aSign = ruleSign(aText);
        const bSign = ruleSign(bText);
        if (aSign !== 0 && aSign === -bSign) {
          conflicts.push({
            id: `conflict.${a.id.replace(/^rule\./, '')}-vs-${b.id.replace(/^rule\./, '')}`,
            ruleA: a.id,
            ruleB: b.id,
            entity,
            description: `Rules "${a.name}" and "${b.name}" express opposing constraints on ${entity}.`,
            confidence: 'low',
            evidence: [...a.evidence, ...b.evidence].slice(0, 10),
            suggestions: buildSuggestions(a, b),
          });
        }
      }
    }
  }
  return conflicts;
}

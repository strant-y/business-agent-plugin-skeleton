import path from 'node:path';
import fs from 'node:fs/promises';
import { exists, readText } from '../utils/fs.js';
import { scanCandidateDir } from './candidate-status.js';

/**
 * Knowledge consistency checks: rule JSON/Markdown/impact trio completeness,
 * unique rule ids, non-empty evidence, INDEX.md link integrity and candidate
 * status closure. These live outside the JSON-schema validation because they
 * cross files (a schema can only validate one file at a time).
 */

export interface RuleKnowledgeCheck {
  /** Rule JSON file under business/rules/. */
  file: string;
  id: string;
  name: string;
  jsonValid: boolean;
  markdownExists: boolean;
  impactExists: boolean;
  /** Whether business/INDEX.md links to this rule. */
  indexed: boolean;
  evidenceEmpty: boolean;
  problems: string[];
}

export interface ConsistencyReport {
  rules: RuleKnowledgeCheck[];
  duplicateIds: string[];
  indexBrokenLinks: string[];
  unknownCandidateStatuses: string[];
  healthy: boolean;
}

export async function checkKnowledgeConsistency(agentRoot: string): Promise<ConsistencyReport> {
  const rulesDir = path.join(agentRoot, 'business', 'rules');
  const report: ConsistencyReport = {
    rules: [],
    duplicateIds: [],
    indexBrokenLinks: [],
    unknownCandidateStatuses: [],
    healthy: true,
  };

  const indexFile = path.join(agentRoot, 'business', 'INDEX.md');
  const indexContent = (await exists(indexFile)) ? await readText(indexFile) : '';

  if (await exists(rulesDir)) {
    const entries = await fs.readdir(rulesDir, { withFileTypes: true });
    const seenIds = new Map<string, string>();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const base = entry.name.slice(0, -'.json'.length);
      const file = path.join(rulesDir, entry.name);
      const check: RuleKnowledgeCheck = {
        file: `business/rules/${entry.name}`,
        id: base,
        name: base,
        jsonValid: true,
        markdownExists: false,
        impactExists: false,
        indexed: false,
        evidenceEmpty: false,
        problems: [],
      };
      try {
        const raw = JSON.parse(await readText(file)) as { id?: string; name?: string; evidence?: string[] };
        if (typeof raw.id === 'string' && raw.id.trim()) check.id = raw.id;
        if (typeof raw.name === 'string' && raw.name.trim()) check.name = raw.name;
        if (seenIds.has(check.id)) report.duplicateIds.push(check.id);
        else seenIds.set(check.id, file);
        check.evidenceEmpty = !Array.isArray(raw.evidence) || raw.evidence.length === 0;
        if (check.evidenceEmpty) check.problems.push('evidence 为空');
      } catch {
        check.jsonValid = false;
        check.problems.push('JSON 无法解析');
      }
      const mdLink = `./rules/${base}.md`;
      check.markdownExists = await exists(path.join(agentRoot, 'business', 'rules', `${base}.md`));
      check.impactExists = await exists(path.join(agentRoot, 'business', 'impact', `${base}.md`));
      check.indexed = indexContent.includes(mdLink);
      if (!check.markdownExists) check.problems.push('规则 Markdown 缺失');
      if (!check.impactExists) check.problems.push('impact map 缺失');
      if (!check.indexed) check.problems.push('INDEX.md 无链接');
      report.rules.push(check);
    }
  }

  // INDEX.md link integrity: only check links backed by confirmed knowledge
  // files. Entity links are skipped on purpose — entity markdown is optional
  // (entities primarily live in the discovery manifest).
  const brokenLinks: string[] = [];
  for (const match of indexContent.matchAll(/\]\(\.\/([^)#]+?)(?:#[^)]*)?\)/g)) {
    const rel = match[1];
    if (!rel || rel.startsWith('http')) continue;
    if (!(rel.startsWith('rules/') || rel.startsWith('relationships/') || rel.startsWith('impact/'))) continue;
    const target = path.join(agentRoot, 'business', rel);
    if (!(await exists(target))) brokenLinks.push(rel);
  }
  report.indexBrokenLinks = brokenLinks;

  const candidateIndex = await scanCandidateDir(path.join(agentRoot, 'memory', 'candidates'));
  report.unknownCandidateStatuses = candidateIndex.unknownStatuses;

  report.healthy =
    report.rules.every((rule) => rule.problems.length === 0) &&
    report.duplicateIds.length === 0 &&
    report.indexBrokenLinks.length === 0 &&
    report.unknownCandidateStatuses.length === 0;
  return report;
}

import path from 'node:path';
import { exists, readText } from '../utils/fs.js';
import {
  validateEntity,
  validateRule,
  validateRelation,
  validateApi,
  validateConflict,
  validateKnowledgeDir,
  type KnowledgeProblem,
} from '../core/validate.js';
import { checkKnowledgeConsistency } from '../core/consistency.js';

export interface ValidateCommandOptions {
  json?: boolean;
}

interface Problem {
  kind: 'entity' | 'rule' | 'relation' | 'api' | 'conflict';
  id?: string;
  problems: string[];
}

export async function validateCommand(root: string, options: ValidateCommandOptions = {}): Promise<void> {
  const agentRoot = path.join(root, '.agent');
  const manifestFile = path.join(agentRoot, 'memory', 'discovery-manifest.json');

  let manifest: {
    entities?: unknown[];
    rules?: unknown[];
    relations?: unknown[];
    apis?: unknown[];
    conflicts?: unknown[];
  } | null = null;
  if (await exists(manifestFile)) {
    try {
      manifest = JSON.parse(await readText(manifestFile));
    } catch {
      console.error(`Manifest at ${manifestFile} is not valid JSON.`);
      process.exitCode = 1;
      return;
    }
  }

  const problems: Problem[] = [];
  if (manifest) {
    const entities = manifest.entities ?? [];
    const rules = manifest.rules ?? [];
    const relations = manifest.relations ?? [];
    const apis = manifest.apis ?? [];
    const conflicts = manifest.conflicts ?? [];

    const sections: Array<{
      kind: Problem['kind'];
      items: unknown[];
      validate: (v: unknown) => Promise<{ valid: boolean; problems: string[] }>;
    }> = [
      { kind: 'entity', items: entities, validate: validateEntity },
      { kind: 'rule', items: rules, validate: validateRule },
      { kind: 'relation', items: relations, validate: validateRelation },
      { kind: 'api', items: apis, validate: validateApi },
      { kind: 'conflict', items: conflicts, validate: validateConflict },
    ];

    for (const section of sections) {
      for (let i = 0; i < section.items.length; i++) {
        const result = await section.validate(section.items[i]);
        if (!result.valid) {
          problems.push({ kind: section.kind, id: `#${i}`, problems: result.problems });
        }
      }
    }
  }

  // Confirmed knowledge under .agent/business/ is also schema-checked.
  const knowledgeProblems: KnowledgeProblem[] = await validateKnowledgeDir(agentRoot);

  // Cross-file consistency: rule JSON/Markdown/impact trio, unique ids,
  // non-empty evidence, INDEX.md link integrity, candidate status closure.
  const consistency = await checkKnowledgeConsistency(agentRoot);
  const consistencyFailed = !consistency.healthy;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          manifest: manifestFile,
          manifestFound: manifest !== null,
          valid: problems.length === 0 && knowledgeProblems.length === 0 && !consistencyFailed,
          problems,
          knowledge: knowledgeProblems,
          consistency,
        },
        null,
        2,
      ),
    );
    if (problems.length > 0 || knowledgeProblems.length > 0 || consistencyFailed) process.exitCode = 1;
    return;
  }

  if (!manifest) {
    console.log(`No discovery manifest found at ${manifestFile}. Run \`business-agent discover\` first.`);
    if (knowledgeProblems.length === 0 && !consistencyFailed) return;
  }

  if (problems.length === 0 && knowledgeProblems.length === 0 && !consistencyFailed) {
    const summary = manifest
      ? `${(manifest.entities ?? []).length} entities, ${(manifest.rules ?? []).length} rules, ${(manifest.relations ?? []).length} relations, ${(manifest.apis ?? []).length} apis, ${(manifest.conflicts ?? []).length} conflicts`
      : 'no manifest';
    console.log(`Validated ${summary} and confirmed knowledge files: all conform to schemas and stay consistent.`);
    return;
  }

  for (const p of problems) {
    console.error(`- [${p.kind} ${p.id}]`);
    for (const msg of p.problems) console.error(`    ${msg}`);
  }
  for (const k of knowledgeProblems) {
    console.error(`- [${k.kind}] ${k.file}`);
    for (const msg of k.problems) console.error(`    ${msg}`);
  }
  if (consistencyFailed) {
    for (const rule of consistency.rules) {
      for (const msg of rule.problems) console.error(`- [rule] ${rule.file} (${rule.id}): ${msg}`);
    }
    for (const id of consistency.duplicateIds) console.error(`- [rule] duplicate id across files: ${id}`);
    for (const link of consistency.indexBrokenLinks) console.error(`- [index] broken link in INDEX.md: ${link}`);
    for (const name of consistency.unknownCandidateStatuses)
      console.error(`- [candidate] unrecognized status marker: ${name}`);
  }
  process.exitCode = 1;
}

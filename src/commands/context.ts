import path from 'node:path';
import { exists, readText, writeText } from '../utils/fs.js';
import { loadRules, loadRelations, listImpacts, safeFileId } from '../core/knowledge.js';
import type { ApiRoute, RuleConflict } from '../core/types.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface ContextManifest {
  entities?: Array<{ name: string; description: string; confidence: string }>;
  apis?: ApiRoute[];
  conflicts?: RuleConflict[];
}

export interface ContextOptions {
  json?: boolean;
  dryRun?: boolean;
}

export async function contextCommand(root: string, subject: string, options: ContextOptions = {}): Promise<void> {
  const indexFile = path.join(root, '.agent/business/INDEX.md');
  const contextFile = path.join(root, '.agent/memory/active-context.md');
  const agentRoot = path.join(root, '.agent');
  const index = (await exists(indexFile))
    ? await readText(indexFile)
    : '# Business Index\n\nNo business index yet. Run `business-agent init && business-agent discover`.\n';
  const manifestFile = path.join(agentRoot, 'memory', 'discovery-manifest.json');
  let manifest: ContextManifest | null = null;
  if (await exists(manifestFile)) {
    try {
      manifest = JSON.parse(await readText(manifestFile)) as ContextManifest;
    } catch {
      console.warn(`Warning: ignoring unreadable manifest at ${manifestFile}`);
    }
  }
  const subjectLower = subject.toLowerCase();
  // Exact match first, then word-boundary match, then a conservative substring
  // fallback so "der" does not match "Order".
  const entities = manifest?.entities ?? [];
  const boundaryRe = new RegExp(`\\b${escapeRegExp(subjectLower)}\\b`, 'i');
  const matched = entities.filter((e) => e.name.toLowerCase() === subjectLower || boundaryRe.test(e.name));
  const matchedNames = new Set(matched.map((e) => e.name));

  const rules = await loadRules(agentRoot);
  const relations = await loadRelations(agentRoot);
  const impacts = await listImpacts(agentRoot);

  const relevantRules = rules.filter((r) => matchedNames.has(r.entity) || r.entity.toLowerCase() === subjectLower);
  const relevantRelations = relations.filter((r) => matchedNames.has(r.source) || matchedNames.has(r.target));
  const relevantConflicts = (manifest?.conflicts ?? []).filter(
    (c) => matchedNames.has(c.entity) || c.entity.toLowerCase() === subjectLower,
  );
  const relevantApis = (manifest?.apis ?? []).filter((a) => a.entity && matchedNames.has(a.entity));

  // Impact maps are keyed by rule/relation file id; only surface relevant ones.
  const relevantImpactFiles = new Set<string>();
  for (const rule of relevantRules) relevantImpactFiles.add(`${safeFileId(rule.id)}.md`);
  for (const relation of relevantRelations) relevantImpactFiles.add(`${safeFileId(relation.id)}.md`);
  const relevantImpacts = impacts.filter((i) => relevantImpactFiles.has(path.basename(i)));

  const lines = [
    '# Active Business Context',
    '',
    `Subject: ${subject}`,
    '',
    '## Relevant Entities',
    ...(matched.length
      ? matched.map((e) => `- ${e.name} (${e.confidence}): ${e.description}`)
      : ['- No exact entity match. Review Business Index.']),
    '',
    '## Relevant Rules',
    ...(relevantRules.length
      ? relevantRules.map(
          (r) => `- ${r.name} (${r.confidence}, ${r.status ?? 'candidate'}) [${safeFileId(r.id)}]: ${r.rule[0]}`,
        )
      : ['- None yet. Run `business-agent discover --deep` or promote verified knowledge.']),
    '',
    '## Relevant Relationships',
    ...(relevantRelations.length
      ? relevantRelations.map((r) => `- ${r.source} --(${r.relationship}, ${r.cardinality})--> ${r.target}`)
      : ['- None yet.']),
    '',
    '## Rule Conflicts',
    ...(relevantConflicts.length
      ? relevantConflicts.map((c) => `- ${c.ruleA} vs ${c.ruleB}: ${c.description}`)
      : ['- None detected.']),
    '',
    '## Relevant API Routes',
    ...(relevantApis.length
      ? relevantApis.map(
          (a) =>
            `- ${a.method.toUpperCase()} ${a.path}${a.kind === 'frontend' ? ' (frontend route)' : ''}${a.evidence.length ? ` [${a.evidence[0]}]` : ''}`,
        )
      : ['- None matched.']),
    '',
    '## Relevant Impact Maps',
    ...(relevantImpacts.length
      ? relevantImpacts.map((i) => `- [${i}](./${i})`)
      : ['- None directly matched. See Business Index for all maps.']),
    '',
    '## Business Index',
    index,
    '',
    '## Next Investigation',
    '- Load related rules and relationships.',
    '- Trace API and database evidence.',
    '- Build or update an Impact Map before changing business behavior.',
  ];
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          subject,
          entities: matched,
          rules: relevantRules,
          relations: relevantRelations,
          conflicts: relevantConflicts,
          apis: relevantApis,
          impacts: relevantImpacts,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (options.dryRun) {
    console.log(`Dry run: would write business context for "${subject}" to ${contextFile}`);
    return;
  }
  await writeText(contextFile, lines.join('\n'));
  console.log(`Business context written to ${contextFile}`);
}

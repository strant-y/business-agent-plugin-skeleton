import path from 'node:path';
import { exists, readText, writeText } from '../utils/fs.js';
import { getEntityAliases, invertAliasMap, resolveCanonicalNameFromIndex } from '../core/glossary.js';
import { loadRules, loadRelations, listImpacts, safeFileId } from '../core/knowledge.js';
import { buildGraph, renderMermaidSubgraph } from '../core/graph.js';
import { retrieveTaskContext } from '../core/retrieval.js';
import type { DiscoverManifest } from '../core/types.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type ContextManifest = Partial<DiscoverManifest>;

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
  const aliasesByEntity = manifest?.aliases ?? {};
  const aliasIndex = manifest?.aliasIndex ?? invertAliasMap(aliasesByEntity);
  const canonicalSubject = resolveCanonicalNameFromIndex(subject, aliasIndex);
  const subjectLower = canonicalSubject.toLowerCase();
  const entities = manifest?.entities ?? [];
  const boundaryRe = new RegExp(`\\b${escapeRegExp(subjectLower)}\\b`, 'i');
  let matched = entities.filter((e) => e.name.toLowerCase() === subjectLower || boundaryRe.test(e.name));

  const rules = await loadRules(agentRoot);
  const relations = await loadRelations(agentRoot);
  const impacts = await listImpacts(agentRoot);

  let retrievalFallback = false;
  if (!matched.length) {
    retrievalFallback = true;
    const hits = await retrieveTaskContext(root, subject, 8, { includeLowConfidence: true });
    const names = new Set<string>();
    for (const hit of hits) {
      if (hit.type === 'entity') {
        names.add(hit.title);
        continue;
      }
      const manifestRule = (manifest?.rules ?? []).find((r) => r.id === hit.id);
      if (manifestRule) {
        names.add(resolveCanonicalNameFromIndex(manifestRule.entity, aliasIndex));
        continue;
      }
      const confirmedRule = rules.find((r) => r.id === hit.id);
      if (confirmedRule) {
        names.add(resolveCanonicalNameFromIndex(confirmedRule.entity, aliasIndex));
        continue;
      }
      if (hit.type === 'relation') {
        const parts = hit.title.split(' ');
        if (parts.length >= 3) {
          names.add(resolveCanonicalNameFromIndex(parts[0], aliasIndex));
          names.add(resolveCanonicalNameFromIndex(parts[parts.length - 1], aliasIndex));
        }
      }
    }
    matched = entities.filter((e) => names.has(e.name));
  }
  const matchedNames = new Set(matched.map((e) => e.name));
  const directAliasMatch =
    aliasIndex[
      subject
        .trim()
        .toLowerCase()
        .replace(/[-_\s]/g, '')
    ];
  if (directAliasMatch) matchedNames.add(directAliasMatch);

  const relevantRules = rules.filter(
    (r) =>
      matchedNames.has(resolveCanonicalNameFromIndex(r.entity, aliasIndex)) || r.entity.toLowerCase() === subjectLower,
  );
  const relevantRelations = relations.filter(
    (r) =>
      matchedNames.has(resolveCanonicalNameFromIndex(r.source, aliasIndex)) ||
      matchedNames.has(resolveCanonicalNameFromIndex(r.target, aliasIndex)),
  );
  const relevantConflicts = (manifest?.conflicts ?? []).filter(
    (c) =>
      matchedNames.has(resolveCanonicalNameFromIndex(c.entity, aliasIndex)) || c.entity.toLowerCase() === subjectLower,
  );
  const relevantApis = (manifest?.apis ?? []).filter(
    (a) => a.entity && matchedNames.has(resolveCanonicalNameFromIndex(a.entity, aliasIndex)),
  );
  const relevantPages = (manifest?.pages ?? []).filter(
    (page) =>
      matchedNames.has(page.component) ||
      page.stores.some((store) => matchedNames.has(resolveCanonicalNameFromIndex(store, aliasIndex))) ||
      page.apiCalls.some((api) => api.toLowerCase().includes(subjectLower)),
  );
  const relevantActions = (manifest?.actions ?? []).filter(
    (action) =>
      relevantPages.some((page) => page.actions.includes(action.id)) || action.source.toLowerCase() === subjectLower,
  );
  const relevantWorkflows = (manifest?.workflows ?? []).filter(
    (workflow) =>
      matchedNames.has(workflow.name) ||
      workflow.name.toLowerCase().includes(subjectLower) ||
      workflow.steps.some((step) => step.toLowerCase().includes(subjectLower)),
  );

  // Entities carry their lifecycle states directly (G1.5); state machines add the mermaid view.
  const stateMachines = (manifest?.states ?? []).filter(
    (s) =>
      matchedNames.has(resolveCanonicalNameFromIndex(s.entity, aliasIndex)) || s.entity.toLowerCase() === subjectLower,
  );
  const entityStateLines = matched
    .filter(
      (entity) =>
        entity.states?.length &&
        !stateMachines.some((machine) => machine.entity.toLowerCase() === entity.name.toLowerCase()),
    )
    .map((entity) => `- ${entity.name}: ${(entity.states ?? []).join(', ')}`);
  const stateMachineLines = stateMachines.map((machine) => {
    const fromEntity = matched.find((entity) => entity.name.toLowerCase() === machine.entity.toLowerCase())?.states;
    return `- ${machine.entity}: ${(fromEntity ?? machine.states).join(', ')}\n\n  \`\`\`mermaid\n  ${machine.mermaid}\n  \`\`\``;
  });
  const stateLines = [...stateMachineLines, ...entityStateLines];

  const relevantImpactFiles = new Set<string>();
  for (const rule of relevantRules) relevantImpactFiles.add(`${safeFileId(rule.id)}.md`);
  for (const relation of relevantRelations) relevantImpactFiles.add(`${safeFileId(relation.id)}.md`);
  const relevantImpacts = impacts.filter((i) => relevantImpactFiles.has(path.basename(i)));
  const graphRelations = [...(manifest?.relations ?? []), ...relations] as DiscoverManifest['relations'];
  const graph = buildGraph(manifest ? (manifest as Partial<DiscoverManifest>) : {}, relations);
  const relationshipGraph = matchedNames.size
    ? renderMermaidSubgraph({
        graph,
        manifest: manifest ?? {},
        relations: graphRelations,
        starts: [...matchedNames],
        maxDepth: 2,
      })
    : undefined;

  const lines = [
    '# Active Business Context',
    '',
    `Subject: ${subject}`,
    ...(retrievalFallback
      ? [
          '',
          '> Note: no exact entity-name match; entities below resolved via content retrieval (Chinese terms supported).',
        ]
      : []),
    '',
    '## Relevant Entities',
    ...(matched.length
      ? matched.map(
          (e) =>
            `- ${e.name} (${e.confidence}): ${e.description}${getEntityAliases(e.name, aliasesByEntity).length ? ` [aliases: ${getEntityAliases(e.name, aliasesByEntity).join(', ')}]` : ''}`,
        )
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
    ...(relationshipGraph?.mermaid
      ? [
          '',
          '```mermaid',
          relationshipGraph.mermaid,
          '```',
          ...(relationshipGraph.truncated ? ['- Graph truncated at 40 nodes.'] : []),
        ]
      : []),
    '',
    '## Rule Conflicts',
    ...(relevantConflicts.length
      ? relevantConflicts.flatMap((c) => [
          `- ${c.ruleA} vs ${c.ruleB}: ${c.description}`,
          ...(c.suggestions ?? []).map((suggestion) => `  - Suggestion: ${suggestion}`),
        ])
      : ['- None detected.']),
    '',
    '## State Machines',
    ...(stateLines.length ? stateLines : ['- None detected.']),
    '',
    '## Frontend Pages',
    ...(relevantPages.length
      ? relevantPages.map(
          (page) =>
            `- ${page.component}${page.route ? ` (${page.route})` : ''}: stores=${page.stores.join(', ') || 'none'}, APIs=${page.apiCalls.join(', ') || 'none'}`,
        )
      : ['- None matched.']),
    '',
    '## Workflows',
    ...(relevantWorkflows.length
      ? relevantWorkflows.map((workflow) => `- ${workflow.name}: ${workflow.steps.join(' -> ') || 'no steps'}`)
      : ['- None matched.']),
    '',
    '## User Actions',
    ...(relevantActions.length
      ? relevantActions.map(
          (action) =>
            `- ${action.name} [${action.trigger}] on ${action.source}: ${action.preconditions.join('; ') || 'no explicit precondition'}`,
        )
      : ['- None matched.']),
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
          states: manifest?.states ?? [],
          workflows: relevantWorkflows,
          pages: relevantPages,
          actions: relevantActions,
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

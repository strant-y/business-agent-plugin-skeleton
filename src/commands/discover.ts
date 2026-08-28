import { discover } from '../core/discovery.js';
import { loadConfig, type AnalyzerName } from '../core/config.js';

export interface CommandOptions {
  dryRun?: boolean;
  json?: boolean;
  deep?: boolean;
}

export async function discoverCommand(root: string, options: CommandOptions = {}): Promise<void> {
  const config = await loadConfig(root, (message) => console.warn(`Warning: ${message}`));
  const analyzers: AnalyzerName[] = options.deep ? ['vue', 'stores', 'frontend', 'java', 'xml', 'linkage'] : [];
  const active = new Set<AnalyzerName>([...(config.analyzers as AnalyzerName[]), ...analyzers]);
  if (active.has('llm') || active.has('llm-rules')) {
    console.log('LLM enrichment active: source code snippets will be sent to the configured LLM endpoint.');
  }
  const manifest = await discover(root, {
    dryRun: options.dryRun,
    analyzers,
    config,
    onWarning: (message) => console.warn(`Warning: ${message}`),
  });
  if (options.json) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  console.log(`Scanned ${manifest.filesScanned} source files.`);
  console.log(`Entities: ${manifest.entities.length}`);
  console.log(`Relations: ${manifest.relations.length}`);
  console.log(`Rules (candidates): ${manifest.rules.length}`);
  if (options.deep) {
    console.log(`APIs: ${manifest.apis.length}`);
    console.log(`Conflicts: ${manifest.conflicts.length}`);
    console.log(`Frontend pages: ${manifest.pages?.length ?? 0}`);
    console.log(`User actions: ${manifest.actions?.length ?? 0}`);
    console.log(`Workflows: ${manifest.workflows?.length ?? 0}`);
  }
  if (options.dryRun) {
    console.log('Dry run: no files written.');
  } else {
    console.log('Discovery manifest: .agent/memory/discovery-manifest.json');
    console.log('Candidate rules: .agent/memory/candidates/ (promote verified ones into .agent/business/)');
  }
}

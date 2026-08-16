import path from 'node:path';
import { exists, readText, writeText } from '../utils/fs.js';
import { extractStateMachines } from '../core/analyzers/states.js';
import { loadConfig } from '../core/config.js';
import { scanProject } from '../core/scanner.js';
import type { DiscoverManifest } from '../core/types.js';

export async function statesCommand(root: string, json = false): Promise<void> {
  const manifestFile = path.join(root, '.agent', 'memory', 'discovery-manifest.json');
  if (!(await exists(manifestFile))) throw new Error('Discovery manifest not found; run discover first.');
  const manifest = JSON.parse(await readText(manifestFile)) as DiscoverManifest;
  const scan = await scanProject(root, await loadConfig(root));
  const machines = extractStateMachines(scan.samples, manifest.entities);
  if (json) {
    console.log(JSON.stringify(machines, null, 2));
    return;
  }
  const dir = path.join(root, '.agent', 'business', 'states');
  for (const machine of machines)
    await writeText(
      path.join(dir, `${machine.entity.toLowerCase()}.md`),
      `# ${machine.entity} States\n\n\`\`\`mermaid\n${machine.mermaid}\n\`\`\`\n`,
    );
  console.log(`State machines written to ${dir}`);
}

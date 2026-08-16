import path from 'node:path';
import { exists, readText, writeJson } from '../utils/fs.js';
import { loadRules } from '../core/knowledge.js';
import { detectConflicts } from '../core/conflicts.js';

export async function conflictsCommand(root: string, json = false): Promise<void> {
  const agentRoot = path.join(root, '.agent');
  const rules = await loadRules(agentRoot);
  const conflicts = detectConflicts(rules);
  const manifestFile = path.join(agentRoot, 'memory', 'discovery-manifest.json');
  if (await exists(manifestFile)) {
    try {
      const manifest = JSON.parse(await readText(manifestFile)) as { conflicts?: unknown[] };
      manifest.conflicts = conflicts;
      await writeJson(manifestFile, manifest);
    } catch {
      throw new Error(`Invalid discovery manifest: ${manifestFile}`);
    }
  }
  if (json) console.log(JSON.stringify(conflicts, null, 2));
  else if (!conflicts.length) console.log('No rule conflicts detected.');
  else
    for (const conflict of conflicts)
      console.log(`${conflict.id}: ${conflict.description}\n- ${conflict.suggestions?.join('\n- ')}`);
}

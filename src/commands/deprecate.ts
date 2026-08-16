import path from 'node:path';
import { exists, readText, writeJson, writeText } from '../utils/fs.js';
import { buildIndex, safeFileId, ruleMarkdown } from '../core/knowledge.js';
import type { BusinessRule } from '../core/types.js';

export async function deprecateCommand(root: string, ruleId?: string): Promise<void> {
  if (!ruleId) throw new Error('Usage: business-agent deprecate <rule-id>');
  const file = path.join(root, '.agent', 'business', 'rules', `${safeFileId(ruleId)}.json`);
  if (!(await exists(file))) throw new Error(`Rule not found: ${ruleId}`);
  const rule = JSON.parse(await readText(file)) as BusinessRule;
  rule.status = 'deprecated';
  await writeJson(file, rule);
  await writeText(file.replace(/\.json$/, '.md'), ruleMarkdown(rule));
  const manifestFile = path.join(root, '.agent', 'memory', 'discovery-manifest.json');
  let entities: Array<{ name: string }> = [];
  if (await exists(manifestFile)) {
    try {
      const manifest = JSON.parse(await readText(manifestFile)) as { entities?: Array<{ name: string }> };
      entities = manifest.entities ?? [];
    } catch {
      entities = [];
    }
  }
  await buildIndex(path.join(root, '.agent'), entities);
  console.log(`Deprecated rule: ${rule.id}`);
}

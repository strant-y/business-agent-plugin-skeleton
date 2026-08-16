import path from 'node:path';
import { exists, writeText } from '../utils/fs.js';

export async function workflowCommand(root: string, name?: string): Promise<void> {
  if (!name) throw new Error('Usage: business-agent workflow <name>');
  const dir = path.join(root, '.agent', 'business', 'workflows');
  const file = path.join(dir, `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`);
  if (await exists(file)) throw new Error(`Workflow already exists: ${file}`);
  await writeText(
    file,
    `# Workflow: ${name}\n\nStatus: draft\n\n## Trigger\n- Define the trigger.\n\n## Steps\n1. Define the first step.\n2. Define the next step.\n\n## Outcomes\n- Define success and failure outcomes.\n`,
  );
  console.log(`Workflow created: ${file}`);
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDir, exists } from '../utils/fs.js';

export interface InitOptions {
  /** Re-apply template files to an existing .agent/ directory. */
  force?: boolean;
}

export async function initCommand(root: string, options: InitOptions = {}): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = path.resolve(here, '../../templates/agent');
  const target = path.join(root, '.agent');
  if (await exists(target)) {
    if (!options.force) {
      console.log('.agent already exists; keeping existing project knowledge. Use --force to re-apply template files.');
      return;
    }
    console.log('Re-applying template files to existing .agent/');
  }
  await copyDir(source, target);
  console.log(`Initialized ${target}`);
}
